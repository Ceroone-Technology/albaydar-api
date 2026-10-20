import nodemailer, { type Transporter } from 'nodemailer';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { env } from '../config/env';
import { correosSalientes } from '../db/schema';
import { db, type Tx } from '../lib/db';
import { logger } from '../lib/logger';
import type { Correo } from './plantillas';

const MAX_INTENTOS = 6;

export interface Adjunto {
  filename: string;
  content: string; // texto o base64
  contentType: string;
}

/**
 * Encola un correo dentro de la transacción del cambio de negocio.
 * Si la transacción se deshace, el correo tampoco se envía.
 */
export async function encolarCorreo(
  tx: Tx,
  o: { plantilla: string; plantillaId?: string | null; para: string; correo: Correo; solicitudId?: string; adjuntos?: Adjunto[]; programadoPara?: Date },
) {
  await tx.insert(correosSalientes).values({
    plantilla: o.plantilla,
    plantillaId: o.plantillaId ?? null,
    para: o.para,
    asunto: o.correo.asunto,
    html: o.correo.html,
    texto: o.correo.texto,
    solicitudId: o.solicitudId,
    adjuntos: o.adjuntos?.map((a) => ({ ...a, content: Buffer.from(a.content).toString('base64') })),
    programadoPara: o.programadoPara ?? new Date(),
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

/**
 * Envía un lote de correos pendientes. Reclama filas con FOR UPDATE SKIP LOCKED,
 * así que se pueden ejecutar varias instancias de la API sin enviar duplicados.
 */
export async function procesarOutbox(lote = 20): Promise<{ enviados: number; fallidos: number }> {
  const reclamados = await db.transaction(async (tx) => {
    const filas = await tx
      .select({ id: correosSalientes.id })
      .from(correosSalientes)
      .where(and(eq(correosSalientes.estado, 'PENDIENTE'), lte(correosSalientes.programadoPara, new Date())))
      .orderBy(correosSalientes.programadoPara)
      .limit(lote)
      .for('update', { skipLocked: true });
    if (!filas.length) return [];
    return tx
      .update(correosSalientes)
      .set({ estado: 'ENVIANDO', reclamadoEn: new Date(), intentos: sql`${correosSalientes.intentos} + 1` })
      .where(inArray(correosSalientes.id, filas.map((f) => f.id)))
      .returning();
  });

  let enviados = 0;
  let fallidos = 0;
  for (const c of reclamados) {
    try {
      // Modo demostración: todo va a un único buzón y el asunto dice a quién iba.
      const desvio = env.MAIL_DESVIO;
      await getTransporter().sendMail({
        from: env.MAIL_FROM,
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
