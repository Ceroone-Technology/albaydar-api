import nodemailer, { type Transporter } from 'nodemailer';
import { and, asc, count, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { env } from '../config/env';
import { correosSalientes } from '../db/schema';
import { db, type Tx } from '../lib/db';
import { logger } from '../lib/logger';
import type { Correo } from './plantillas';

const MAX_INTENTOS = 6;

export interface Adjunto {
  filename: string;
  /** Texto (un .ics) o, con `base64: true`, binario ya codificado (un PDF). */
  content: string;
  contentType: string;
  base64?: boolean;
}

/**
 * Encola un correo dentro de la transacción del cambio de negocio.
 * Si la transacción se deshace, el correo tampoco se envía.
 */
export async function encolarCorreo(
  tx: Tx,
  o: {
    plantilla: string;
    plantillaId?: string | null;
    para: string;
    correo: Correo;
    solicitudId?: string;
    notificacionId?: string;
    adjuntos?: Adjunto[];
    programadoPara?: Date;
  },
) {
  await tx.insert(correosSalientes).values({
    plantilla: o.plantilla,
    plantillaId: o.plantillaId ?? null,
    para: o.para,
    asunto: o.correo.asunto,
    html: o.correo.html,
    texto: o.correo.texto,
    solicitudId: o.solicitudId,
    notificacionId: o.notificacionId,
    // En la cola siempre en base64.
    adjuntos: o.adjuntos?.map(({ base64, ...a }) => ({ ...a, content: base64 ? a.content : Buffer.from(a.content).toString('base64') })),
    programadoPara: o.programadoPara ?? new Date(),
    // now() es el mismo durante toda la transacción: clock_timestamp() avanza y
    // desempata, en microsegundos, los correos encolados en la misma.
    createdAt: sql`clock_timestamp()`,
  });
}

let transporter: Transporter | null = null;
export function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}
/** Para tests: inyectar un transporte falso. */
export const setTransporter = (t: Transporter | null) => {
  transporter = t;
};

/** Ritmo de envío (0 = sin límite). Por defecto, el de la configuración (MAIL_MAX_POR_*). */
export interface LimitesEnvio {
  porSegundo: number;
  porDia: number;
}

const limitesDeEnv = (): LimitesEnvio => ({ porSegundo: env.MAIL_MAX_POR_SEGUNDO, porDia: env.MAIL_MAX_POR_DIA });

/** Las notificaciones masivas no gastan el último 20 % del cupo diario: queda para los correos del flujo. */
const CUPO_NOTIFICACIONES = 0.8;
/** El planificador lanza la cola cada 15 s: con ritmo, no se reclama más de lo que cabe en ese turno. */
const SEGUNDOS_POR_TURNO = 14;
const PLANTILLA_NOTIFICACION = 'NOTIFICACION';

/** Hora del último envío (en este proceso), para respetar el ritmo también entre turnos. */
let ultimoEnvio = 0;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Envía un lote de correos pendientes. Reclama filas con FOR UPDATE SKIP LOCKED,
 * así que se pueden ejecutar varias instancias de la API sin enviar duplicados.
 *
 * Ritmo (despliegue en AWS, 23/11/2026): con límites, deja entre envíos el intervalo que marca
 * `porSegundo` y no pasa de `porDia` en las últimas 24 h (ventana móvil, como SES); lo que no
 * cabe se queda PENDIENTE para el turno siguiente. Los correos del flujo (citaciones, matrícula,
 * pagos…) salen antes que las notificaciones masivas, que además se paran al 80 % del cupo.
 */
export async function procesarOutbox(lote = 20, limites: LimitesEnvio = limitesDeEnv()): Promise<{ enviados: number; fallidos: number }> {
  let max = lote;
  let sinNotificaciones = false;
  if (limites.porDia > 0) {
    const [r] = await db
      .select({ n: count() })
      .from(correosSalientes)
      .where(gte(correosSalientes.enviadoEn, new Date(Date.now() - 86_400_000)));
    const enviados24h = r?.n ?? 0;
    const cupo = limites.porDia - enviados24h;
    if (cupo <= 0) return { enviados: 0, fallidos: 0 };
    max = Math.min(max, cupo);
    sinNotificaciones = enviados24h >= Math.floor(limites.porDia * CUPO_NOTIFICACIONES);
  }
  if (limites.porSegundo > 0) max = Math.min(max, Math.max(1, Math.floor(limites.porSegundo * SEGUNDOS_POR_TURNO)));

  const reclamados = await db.transaction(async (tx) => {
    const filas = await tx
      .select({ id: correosSalientes.id })
      .from(correosSalientes)
      .where(
        and(
          eq(correosSalientes.estado, 'PENDIENTE'),
          lte(correosSalientes.programadoPara, new Date()),
          sinNotificaciones ? ne(correosSalientes.plantilla, PLANTILLA_NOTIFICACION) : undefined,
        ),
      )
      // Primero los del flujo; las notificaciones masivas, detrás.
      .orderBy(asc(sql`${correosSalientes.plantilla} = ${PLANTILLA_NOTIFICACION}`), correosSalientes.programadoPara, correosSalientes.createdAt)
      .limit(max)
      .for('update', { skipLocked: true });
    if (!filas.length) return [];
    const actualizadas = await tx
      .update(correosSalientes)
      .set({ estado: 'ENVIANDO', reclamadoEn: new Date(), intentos: sql`${correosSalientes.intentos} + 1` })
      .where(inArray(correosSalientes.id, filas.map((f) => f.id)))
      .returning();
    // RETURNING no garantiza ningún orden: se envían en el de la consulta, que
    // ordena PostgreSQL con microsegundos (en JavaScript se perderían).
    const orden = new Map(filas.map((f, i) => [f.id, i]));
    return actualizadas.sort((a, b) => orden.get(a.id)! - orden.get(b.id)!);
  });

  let enviados = 0;
  let fallidos = 0;
  const intervalo = limites.porSegundo > 0 ? 1000 / limites.porSegundo : 0;
  for (const c of reclamados) {
    if (intervalo) {
      const espera = ultimoEnvio + intervalo - Date.now();
      if (espera > 0) await dormir(espera);
      ultimoEnvio = Date.now();
    }
    try {
      // Modo demostración: todo va a un único buzón y el asunto dice a quién iba.
      const desvio = env.MAIL_DESVIO;
      await getTransporter().sendMail({
        from: env.MAIL_FROM,
        // Si la familia responde al correo (p. ej. para cancelar), lo lee secretaría.
        replyTo: env.MAIL_REPLY_TO ?? env.MAIL_SECRETARIA,
        to: desvio ?? c.para,
        subject: desvio ? `[Para: ${c.para}] ${c.asunto}` : c.asunto,
        html: c.html,
        text: c.texto,
        attachments: c.adjuntos?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType })),
      });
      await db.update(correosSalientes).set({ estado: 'ENVIADO', enviadoEn: new Date(), ultimoError: null }).where(eq(correosSalientes.id, c.id));
      enviados++;
    } catch (err) {
      fallidos++;
      const agotado = c.intentos >= MAX_INTENTOS;
      // Reintento con espera exponencial: 1, 2, 4, 8, 16 min…
      const espera = 2 ** (c.intentos - 1) * 60_000;
      await db
        .update(correosSalientes)
        .set({
          estado: agotado ? 'ERROR' : 'PENDIENTE',
          ultimoError: String((err as Error).message).slice(0, 500),
          programadoPara: new Date(Date.now() + espera),
        })
        .where(eq(correosSalientes.id, c.id));
      logger.warn({ correoId: c.id, intento: c.intentos, err: (err as Error).message }, 'Fallo al enviar correo');
    }
  }
  return { enviados, fallidos };
}

/** Si el proceso murió a mitad de envío, devuelve a la cola lo que quedó "ENVIANDO". */
export async function liberarAtascados(minutos = 10) {
  await db
    .update(correosSalientes)
    .set({ estado: 'PENDIENTE' })
    .where(and(eq(correosSalientes.estado, 'ENVIANDO'), lte(correosSalientes.reclamadoEn, new Date(Date.now() - minutos * 60_000))));
}
