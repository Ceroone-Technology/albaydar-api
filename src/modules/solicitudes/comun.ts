import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { env } from '../../config/env';
import {
  ciclos,
  familias,
  plazasCiclo,
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
import { alumnasPorContacto } from '../alumnado/alumnado.service';
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
 * Serie del código según la vía (ajuste A1; respuesta del centro, 11/11/2026):
 * B Bachillerato, CC Ciclos Concertados (GM y GS) y CP Ciclos Privados. El formato vive solo aquí.
 */
export const SERIE_CODIGO: Record<FamiliaVia, string> = {
  BACHILLERATO: 'B',
  CICLOS_CONCERTADOS_GM: 'CC',
  CICLOS_CONCERTADOS_GS: 'CC',
  CICLOS_PRIVADOS_GS: 'CP',
};

/**
 * B2027-0001 / CC2027-0001 / CP2027-0001 (ajuste A1): la serie, el año de inicio de los estudios
 * (el del curso escolar de la vía: 2027-2028 → 2027) y un contador de cuatro cifras por serie y
 * año, atómico. Las solicitudes anteriores conservan su código (B-2026-0001, C-2026-0001, SOL-…).
 */
export async function siguienteCodigo(tx: Tx, via: Pick<Via, 'familia' | 'cursoEscolar'>): Promise<string> {
  const serie = SERIE_CODIGO[via.familia];
  const anio = via.cursoEscolar.slice(0, 4);
  return `${serie}${anio}-${String(await siguienteValor(tx, `solicitud-${serie}${anio}`)).padStart(4, '0')}`;
}

/**
 * Posición de cada solicitud EN_ESPERA dentro de su lista, por orden de entrada: la de su vía
 * o, si tiene ciclo, la de su ciclo en esa vía (A6).
 */
export async function posicionesEnEspera(tx: Tx, viaIds: string[]): Promise<Map<string, number>> {
  if (!viaIds.length) return new Map();
  const filas = await tx
    .select({ id: solicitudes.id, viaId: solicitudes.viaId, cicloId: solicitudes.cicloId })
    .from(solicitudes)
    .where(and(eq(solicitudes.estado, 'EN_ESPERA'), inArray(solicitudes.viaId, [...new Set(viaIds)])))
    .orderBy(sql`${solicitudes.enEsperaDesde} asc nulls last`, asc(solicitudes.createdAt));
  const contador = new Map<string, number>();
  return new Map(
    filas.map((f) => {
      const lista = claveCiclo(f.viaId, f.cicloId);
      const n = (contador.get(lista) ?? 0) + 1;
      contador.set(lista, n);
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

// ── Plazas por ciclo (A6, entrega 2) ────────────────────────────────────────

/** Clave de las cuentas por ciclo: vía y ciclo (sin ciclo, la cadena vacía). */
export const claveCiclo = (viaId: string, cicloId: string | null | undefined) => `${viaId}|${cicloId ?? ''}`;

/** Plazas de serie del centro (correo del 11/11/2026): 30 por ciclo y curso, 60 en Administración y Finanzas. */
export const plazasCicloDelCentro = (nombre: string) => (nombre === 'Administración y Finanzas' ? 60 : 30);

/** Ocupadas (admitidas, reservadas y matriculadas) por vía y ciclo, con `claveCiclo`. */
export async function ocupadasPorCiclo(tx: Tx, viaIds: string[]): Promise<Map<string, number>> {
  if (!viaIds.length) return new Map();
  const filas = await tx
    .select({ viaId: solicitudes.viaId, cicloId: solicitudes.cicloId, n: count() })
    .from(solicitudes)
    .where(and(inArray(solicitudes.viaId, [...new Set(viaIds)]), inArray(solicitudes.estado, ESTADOS_OCUPAN_PLAZA)))
    .groupBy(solicitudes.viaId, solicitudes.cicloId);
  return new Map(filas.map((f) => [claveCiclo(f.viaId, f.cicloId), f.n]));
}

/** Plazas de cada ciclo en esas vías, con el nombre y en el orden del catálogo. */
export async function plazasDeCiclos(tx: Tx, viaIds: string[]) {
  if (!viaIds.length) return [];
  return tx
    .select({ viaId: plazasCiclo.viaId, cicloId: plazasCiclo.cicloId, plazas: plazasCiclo.plazas, nombre: ciclos.nombre })
    .from(plazasCiclo)
    .innerJoin(ciclos, eq(ciclos.id, plazasCiclo.cicloId))
    .where(inArray(plazasCiclo.viaId, [...new Set(viaIds)]))
    .orderBy(asc(ciclos.orden), asc(ciclos.nombre));
}

/** Las plazas de una vía de ciclos son la suma de las de sus ciclos. */
export async function sumarPlazasVia(tx: Tx, viaId: string): Promise<Via> {
  const [s] = await tx
    .select({ total: sql<number>`coalesce(sum(${plazasCiclo.plazas}), 0)::int` })
    .from(plazasCiclo)
    .where(eq(plazasCiclo.viaId, viaId));
  const [via] = await tx.update(vias).set({ plazas: Number(s?.total ?? 0) }).where(eq(vias.id, viaId)).returning();
  return via!;
}

/**
 * Crea las filas de plazas que falten para los ciclos activos de una vía de ciclos
 * (`plazas(nombre)` las de cada una nueva) y recalcula la suma de la vía.
 */
export async function asegurarPlazasCiclo(tx: Tx, via: Via, plazas: (nombre: string) => number) {
  if (via.familia === 'BACHILLERATO') return via;
  const catalogo = await tx.select().from(ciclos).where(and(eq(ciclos.familia, via.familia), eq(ciclos.activo, true)));
  if (catalogo.length) {
    await tx
      .insert(plazasCiclo)
      .values(catalogo.map((c) => ({ viaId: via.id, cicloId: c.id, plazas: plazas(c.nombre) })))
      .onConflictDoNothing();
  }
  return sumarPlazasVia(tx, via.id);
}

export async function calcularRevision(tx: Tx, s: Solicitud, via: Via): Promise<ResultadoRevision> {
  return (await calcularRevisiones(tx, [{ ...s, via }])).get(s.id)!;
}

export type EntradaLote = Omit<EntradaRevision, 'via' | 'familia' | 'otrasSolicitudes'> & {
  id: string;
  via: Pick<Via, 'id' | 'nombre' | 'plazas' | 'plazasAsignadasPorJunta'>;
  /** Con ciclo y plazas para él, la comprobación de plazas es la del ciclo (A6). */
  cicloId?: string | null;
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
  const delCentro = await alumnasPorContacto(tx, emails, telefonos);
  // Plazas por ciclo (A6): solo si alguna fila lleva ciclo.
  const conCiclo = filas.some((f) => f.cicloId);
  const plazasCiclos = conCiclo ? await plazasDeCiclos(tx, viaIds) : [];
  const ocupadasCiclo = conCiclo ? await ocupadasPorCiclo(tx, viaIds) : new Map<string, number>();
  const plazaCiclo = new Map(plazasCiclos.map((p) => [claveCiclo(p.viaId, p.cicloId), p]));

  const ocupadasPorVia = new Map(ocupadas.map((o) => [o.viaId, o.n]));
  // Con ciclo y plazas para él, las del ciclo («GS privado 1º · Marketing y Publicidad»); si no, las de la vía.
  const cupo = (f: EntradaLote) => {
    const p = f.cicloId ? plazaCiclo.get(claveCiclo(f.via.id, f.cicloId)) : undefined;
    return p
      ? { nombre: `${f.via.nombre} · ${p.nombre}`, plazas: p.plazas, plazasAsignadasPorJunta: false, ocupadas: ocupadasCiclo.get(claveCiclo(f.via.id, f.cicloId)) ?? 0 }
      : { nombre: f.via.nombre, plazas: f.via.plazas, plazasAsignadasPorJunta: f.via.plazasAsignadasPorJunta, ocupadas: ocupadasPorVia.get(f.via.id) ?? 0 };
  };
  const ahora = new Date();
  return new Map(
    filas.map((f) => {
      const email = f.email?.trim();
      const otras = relacionadas
        .filter((o) => o.id !== f.id && ((!!email && o.email === email) || o.telefono === f.telefono))
        .slice(0, 5);
      const familia = email ? conocidas.find((c) => c.email === email) : undefined;
      // La alumna que nació de esta misma solicitud no cuenta como vínculo.
      const alumnasVinculadas = new Map(
        delCentro
          .filter((a) => a.solicitudId !== f.id && ((!!email && a.email === email.toLowerCase()) || a.telefono === f.telefono?.trim()))
          .map((a) => [a.id, { expediente: a.expediente, alumna: `${a.nombre} ${a.apellidos}`.trim() }]),
      );
      const r = revisar(
        {
          ...f,
          via: cupo(f),
          familia: familia ? { vinculo: familia.vinculo } : null,
          otrasSolicitudes: otras.map((o) => ({ codigo: o.codigo, alumna: `${o.n} ${o.a}` })),
          alumnas: [...alumnasVinculadas.values()].slice(0, 3),
        },
        ahora,
      );
      return [f.id, r];
    }),
  );
}
