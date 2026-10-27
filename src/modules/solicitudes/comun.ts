import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { env } from '../../config/env';
import {
  familias,
  secuencias,
  solicitudEventos,
  solicitudes,
  tokensPublicos,
  vias,
  type EstadoSolicitud,
  type FamiliaVia,
  type Solicitud,
  type Via,
} from '../../db/schema';
import type { Tx } from '../../lib/db';
import { conflict, notFound } from '../../lib/errors';
import { hashToken, nuevoToken } from '../../lib/crypto';
import { nombrePila, nombreVia } from './dominio';
import { revisar, type EntradaRevision, type ResultadoRevision } from './revision';

export type Actor = { tipo: 'usuario'; usuarioId: string } | { tipo: 'familia' } | { tipo: 'sistema' };

/** Estados que consumen plaza de la vía. */
export const ESTADOS_OCUPAN_PLAZA: EstadoSolicitud[] = ['ADMITIDA', 'PLAZA_RESERVADA', 'MATRICULADA'];

export async function registrarEvento(
  tx: Tx,
  solicitudId: string,
  actor: Actor,
  tipo: string,
  extra: { deEstado?: EstadoSolicitud; aEstado?: EstadoSolicitud; detalle?: Record<string, unknown> } = {},
) {
  await tx.insert(solicitudEventos).values({
    solicitudId,
    tipo,
    actor: actor.tipo,
    usuarioId: actor.tipo === 'usuario' ? actor.usuarioId : null,
    deEstado: extra.deEstado,
    aEstado: extra.aEstado,
    detalle: extra.detalle,
  });
}

/**
 * Cambia el estado comprobando que no haya cambiado entre medias (control optimista):
 * si otra persona movió la solicitud a la vez, devuelve 409 en vez de pisarla.
 */
export async function cambiarEstado(
  tx: Tx,
  s: Pick<Solicitud, 'id' | 'estado'>,
  a: EstadoSolicitud,
  actor: Actor,
  tipo = 'ESTADO_CAMBIADO',
  detalle?: Record<string, unknown>,
) {
  if (s.estado === a) return;
  const r = await tx
    .update(solicitudes)
    .set({ estado: a })
    .where(and(eq(solicitudes.id, s.id), eq(solicitudes.estado, s.estado)))
    .returning({ id: solicitudes.id });
  if (!r.length) throw conflict('ESTADO_CAMBIADO', 'La solicitud acaba de cambiar. Recarga para ver su estado actual.');
  await registrarEvento(tx, s.id, actor, tipo, { deEstado: s.estado, aEstado: a, detalle });
}

/** Contador atómico por clave: no repite ni con peticiones simultáneas. */
export async function siguienteValor(tx: Tx, clave: string): Promise<number> {
  const [r] = await tx
    .insert(secuencias)
    .values({ clave, valor: 1 })
    .onConflictDoUpdate({ target: secuencias.clave, set: { valor: sql`${secuencias.valor} + 1` } })
    .returning({ valor: secuencias.valor });
  return r!.valor;
}

/**
 * Letra del código según la vía (reunión del 21/10/2026): B Bachillerato, C Ciclos.
 * Las series definitivas están pendientes del cliente: el formato vive solo aquí.
 */
export const LETRA_CODIGO: Record<FamiliaVia, string> = {
  BACHILLERATO: 'B',
  CICLOS_CONCERTADOS_GM: 'C',
  CICLOS_CONCERTADOS_GS: 'C',
  CICLOS_PRIVADOS_GS: 'C',
};

/**
 * B-2026-0001 / C-2026-0001 — contador por letra y año, atómico. Formato provisional.
 * Las solicitudes anteriores conservan su código SOL-AAAA-NNNN.
 */
export async function siguienteCodigo(tx: Tx, familia: FamiliaVia, fecha = new Date()): Promise<string> {
  const letra = LETRA_CODIGO[familia];
  const anio = fecha.getFullYear();
  return `${letra}-${anio}-${String(await siguienteValor(tx, `solicitud-${letra}-${anio}`)).padStart(4, '0')}`;
}

/** Posición de cada solicitud EN_ESPERA dentro de su vía, por orden de entrada en la lista. */
export async function posicionesEnEspera(tx: Tx, viaIds: string[]): Promise<Map<string, number>> {
  if (!viaIds.length) return new Map();
  const filas = await tx
    .select({ id: solicitudes.id, viaId: solicitudes.viaId })
    .from(solicitudes)
    .where(and(eq(solicitudes.estado, 'EN_ESPERA'), inArray(solicitudes.viaId, [...new Set(viaIds)])))
    .orderBy(sql`${solicitudes.enEsperaDesde} asc nulls last`, asc(solicitudes.createdAt));
  const contador = new Map<string, number>();
  return new Map(
    filas.map((f) => {
      const n = (contador.get(f.viaId) ?? 0) + 1;
      contador.set(f.viaId, n);
      return [f.id, n];
    }),
  );
}

export async function obtenerSolicitud(tx: Tx, id: string, bloquear = false) {
  const q = tx.select({ s: solicitudes, via: vias }).from(solicitudes).innerJoin(vias, eq(vias.id, solicitudes.viaId)).where(eq(solicitudes.id, id));
  const [r] = bloquear ? await q.for('update', { of: solicitudes }) : await q;
  if (!r) throw notFound('Solicitud no encontrada.', 'SOLICITUD_NO_ENCONTRADA');
  return r;
}

/** Variables comunes de los correos a la familia: {{alumna}}, {{tutor}}, {{codigo}}, {{curso}}. */
export function datosCorreo(s: Solicitud, via: Via) {
  return {
    codigo: s.codigo,
    tutor: nombrePila(s.tutorNombre),
    alumna: `${s.alumnaNombre} ${s.alumnaApellidos}`.trim(),
    curso: nombreVia(via.familia, via.curso),
  };
}

// ── Enlaces públicos ────────────────────────────────────────────────────────

export const urlCita = (token: string) => `${env.PUBLIC_APP_URL}/cita/${token}`;
export const urlCompletar = (token: string) => `${env.PUBLIC_APP_URL}/solicitud/completar/${token}`;

export async function crearToken(
  tx: Tx,
  o: { proposito: 'ELEGIR_CITA' | 'COMPLETAR_SOLICITUD'; solicitudId: string; propuestaId?: string; expiraEn: Date },
): Promise<string> {
  const token = nuevoToken();
  await tx.insert(tokensPublicos).values({ ...o, tokenHash: hashToken(token) });
  return token;
}

export async function revocarTokens(tx: Tx, solicitudId: string, proposito: 'ELEGIR_CITA' | 'COMPLETAR_SOLICITUD') {
  await tx
    .update(tokensPublicos)
    .set({ revocadoEn: new Date() })
    .where(and(eq(tokensPublicos.solicitudId, solicitudId), eq(tokensPublicos.proposito, proposito), isNull(tokensPublicos.revocadoEn)));
}

// ── Revisión ────────────────────────────────────────────────────────────────

export async function plazasOcupadas(tx: Tx, viaId: string) {
  const [r] = await tx
    .select({ n: count() })
    .from(solicitudes)
    .where(and(eq(solicitudes.viaId, viaId), inArray(solicitudes.estado, ESTADOS_OCUPAN_PLAZA)));
  return r?.n ?? 0;
}

export async function calcularRevision(tx: Tx, s: Solicitud, via: Via): Promise<ResultadoRevision> {
  return (await calcularRevisiones(tx, [{ ...s, via }])).get(s.id)!;
}

export type EntradaLote = Omit<EntradaRevision, 'via' | 'familia' | 'otrasSolicitudes'> & {
  id: string;
  via: Pick<Via, 'id' | 'nombre' | 'plazas' | 'plazasAsignadasPorJunta'>;
};

/**
 * Las cinco comprobaciones de varias solicitudes a la vez (bandeja, kanban):
 * tres consultas en total, no tres por fila. Un correo vacío (alta telefónica)
 * no cuenta como vínculo familiar.
 */
export async function calcularRevisiones(tx: Tx, filas: EntradaLote[]): Promise<Map<string, ResultadoRevision>> {
  if (!filas.length) return new Map();
  const viaIds = [...new Set(filas.map((f) => f.via.id))];
  const emails = [...new Set(filas.map((f) => f.email?.trim()).filter((e): e is string => !!e))];
  const telefonos = [...new Set(filas.map((f) => f.telefono?.trim()).filter((t): t is string => !!t))];

  // En serie: dentro de una transacción todas comparten la misma conexión.
  const ocupadas = await tx
    .select({ viaId: solicitudes.viaId, n: count() })
    .from(solicitudes)
    .where(and(inArray(solicitudes.viaId, viaIds), inArray(solicitudes.estado, ESTADOS_OCUPAN_PLAZA)))
    .groupBy(solicitudes.viaId);
  const conocidas = emails.length
    ? await tx.select({ email: familias.email, vinculo: familias.vinculo }).from(familias).where(inArray(familias.email, emails))
    : [];
  const relacionadas =
    emails.length || telefonos.length
      ? await tx
          .select({ id: solicitudes.id, codigo: solicitudes.codigo, n: solicitudes.alumnaNombre, a: solicitudes.alumnaApellidos, email: solicitudes.email, telefono: solicitudes.telefono })
          .from(solicitudes)
          .where(or(...(emails.length ? [inArray(solicitudes.email, emails)] : []), ...(telefonos.length ? [inArray(solicitudes.telefono, telefonos)] : [])))
          .orderBy(asc(solicitudes.createdAt))
      : [];

  const ocupadasPorVia = new Map(ocupadas.map((o) => [o.viaId, o.n]));
  const ahora = new Date();
  return new Map(
    filas.map((f) => {
      const email = f.email?.trim();
      const otras = relacionadas
        .filter((o) => o.id !== f.id && ((!!email && o.email === email) || o.telefono === f.telefono))
        .slice(0, 5);
      const familia = email ? conocidas.find((c) => c.email === email) : undefined;
      const r = revisar(
        {
          ...f,
          via: { nombre: f.via.nombre, plazas: f.via.plazas, plazasAsignadasPorJunta: f.via.plazasAsignadasPorJunta, ocupadas: ocupadasPorVia.get(f.via.id) ?? 0 },
          familia: familia ? { vinculo: familia.vinculo } : null,
          otrasSolicitudes: otras.map((o) => ({ codigo: o.codigo, alumna: `${o.n} ${o.a}` })),
        },
        ahora,
      );
      return [f.id, r];
    }),
  );
}
