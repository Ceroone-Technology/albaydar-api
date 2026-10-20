import { and, count, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { env } from '../../config/env';
import {
  familias,
  secuencias,
  solicitudEventos,
  solicitudes,
  tokensPublicos,
  vias,
  type EstadoSolicitud,
  type Solicitud,
  type Via,
} from '../../db/schema';
import type { Tx } from '../../lib/db';
import { conflict, notFound } from '../../lib/errors';
import { hashToken, nuevoToken } from '../../lib/crypto';
import { nombrePila, nombreVia } from './dominio';
import { revisar, type ResultadoRevision } from './revision';

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

/** SOL-2026-0001 — contador por año, atómico. */
export async function siguienteCodigo(tx: Tx, fecha = new Date()): Promise<string> {
  const anio = fecha.getFullYear();
  const [r] = await tx
    .insert(secuencias)
    .values({ clave: `solicitud-${anio}`, valor: 1 })
    .onConflictDoUpdate({ target: secuencias.clave, set: { valor: sql`${secuencias.valor} + 1` } })
    .returning({ valor: secuencias.valor });
  return `SOL-${anio}-${String(r!.valor).padStart(4, '0')}`;
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
  const [familia] = await tx.select({ vinculo: familias.vinculo }).from(familias).where(eq(familias.email, s.email)).limit(1);
  const otras = await tx
    .select({ codigo: solicitudes.codigo, n: solicitudes.alumnaNombre, a: solicitudes.alumnaApellidos })
    .from(solicitudes)
    .where(and(ne(solicitudes.id, s.id), or(eq(solicitudes.email, s.email), eq(solicitudes.telefono, s.telefono))))
    .limit(5);
  return revisar({
    ...s,
    via: { nombre: via.nombre, plazas: via.plazas, plazasAsignadasPorJunta: via.plazasAsignadasPorJunta, ocupadas: await plazasOcupadas(tx, via.id) },
    familia: familia ?? null,
    otrasSolicitudes: otras.map((o) => ({ codigo: o.codigo, alumna: `${o.n} ${o.a}` })),
  });
}
