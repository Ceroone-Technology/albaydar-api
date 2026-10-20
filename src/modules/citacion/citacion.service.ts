import { and, asc, desc, eq, gt, inArray, isNull, notInArray } from 'drizzle-orm';
import { CENTRO, env } from '../../config/env';
import {
  documentos,
  entrevistas,
  huecosAgenda,
  propuestaHuecos,
  propuestasCita,
  solicitudes,
  tokensPublicos,
  type Entrevista,
  type HuecoAgenda,
  type PropuestaCita,
} from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { badRequest, conflict, gone, notFound } from '../../lib/errors';
import { hashToken } from '../../lib/crypto';
import { diaLargo, franja, sumarDias, sumarMin } from '../../lib/fechas';
import { encolarCorreo } from '../../correo/outbox';
import { generarIcs } from '../../correo/ics';
import * as plantillas from '../../correo/plantillas';
import {
  calcularRevision,
  cambiarEstado,
  crearToken,
  datosCorreo,
  obtenerSolicitud,
  registrarEvento,
  revocarTokens,
  urlCita,
  type Actor,
} from '../solicitudes/comun';
import { ETIQUETA_ESTADO, ETIQUETA_FAMILIA_VIA } from '../solicitudes/dominio';

/** Antelación mínima para que la familia cambie una cita ya confirmada. */
export const HORAS_LIMITE_CAMBIO = 24;
const ESTADOS_PUEDE_CITAR = ['RECIBIDA', 'EN_REVISION', 'CITACION_ENVIADA', 'OTRA_FRANJA_SOLICITADA', 'ENTREVISTA_PROGRAMADA'] as const;

// ── Utilidades ──────────────────────────────────────────────────────────────

const huecoTexto = (h: Pick<HuecoAgenda, 'inicio' | 'fin'>) => ({ dia: diaLargo(h.inicio), franja: franja(h.inicio, h.fin) });

export function icsEntrevista(e: Entrevista, alumna: string, cancelar = false) {
  return generarIcs({
    uid: `entrevista-${e.id}`,
    inicio: e.inicio,
    fin: e.fin,
    titulo: `Entrevista de admisión · ${alumna} · Albaydar`,
    descripcion: `Entrevista presencial con el ${CENTRO.entrevista.con.toLowerCase()} del ${CENTRO.nombre}.`,
    lugar: `${e.lugar}, ${CENTRO.direccion}`,
    secuencia: e.secuenciaIcs,
    cancelar,
  });
}

async function huecosDePropuesta(tx: Tx, propuestaId: string) {
  return tx
    .select({ hueco: huecosAgenda })
    .from(propuestaHuecos)
    .innerJoin(huecosAgenda, eq(huecosAgenda.id, propuestaHuecos.huecoId))
    .where(eq(propuestaHuecos.propuestaId, propuestaId))
    .orderBy(asc(huecosAgenda.inicio))
    .then((r) => r.map((x) => x.hueco));
}

async function entrevistaActivaDePropuesta(tx: Tx, propuestaId: string) {
  const [e] = await tx
    .select()
    .from(entrevistas)
    .where(and(eq(entrevistas.propuestaId, propuestaId), notInArray(entrevistas.estado, ['CANCELADA'])))
    .limit(1);
  return e ?? null;
}

/** Cancela una entrevista y devuelve su hueco a la agenda. */
async function liberarEntrevista(tx: Tx, e: Entrevista) {
  // La entrevista suelta el hueco (huecoId es único) para que otra familia pueda reservarlo.
  await tx.update(entrevistas).set({ estado: 'CANCELADA', huecoId: null, secuenciaIcs: e.secuenciaIcs + 1 }).where(eq(entrevistas.id, e.id));
  if (e.huecoId) await tx.update(huecosAgenda).set({ estado: 'LIBRE' }).where(and(eq(huecosAgenda.id, e.huecoId), eq(huecosAgenda.estado, 'OCUPADO')));
}

// ── Secretaría: proponer de 1 a 3 huecos ────────────────────────────────────

export async function proponer(solicitudId: string, huecoIds: string[], mensaje: string | null | undefined, usuarioId: string) {
  const ids = [...new Set(huecoIds)];
  if (ids.length < 1 || ids.length > 3) throw badRequest('HUECOS_INVALIDOS', 'Propón entre 1 y 3 huecos.');

  return db.transaction(async (tx) => {
    const { s, via } = await obtenerSolicitud(tx, solicitudId, true);
    if (!(ESTADOS_PUEDE_CITAR as readonly string[]).includes(s.estado)) {
      throw conflict('ESTADO_NO_PERMITE', `No se puede citar una solicitud en estado “${ETIQUETA_ESTADO[s.estado]}”.`);
    }
    const revision = await calcularRevision(tx, s, via);
    if (!revision.puedeCitar) {
      throw conflict('SOLICITUD_INCOMPLETA', 'Pide a la familia que la complete antes de citar a entrevista.', { faltan: revision.faltan });
    }

    // Los huecos deben existir, estar libres y ser futuros. Se bloquean para que nadie los ocupe a la vez.
    const huecos = await tx.select().from(huecosAgenda).where(inArray(huecosAgenda.id, ids)).for('update');
    if (huecos.length !== ids.length) throw badRequest('HUECO_NO_EXISTE', 'Algún hueco ya no existe. Recarga la agenda.');
    const ahora = new Date();
    const noValidos = huecos.filter((h) => h.estado !== 'LIBRE' || h.inicio <= ahora);
    if (noValidos.length) {
      throw conflict('HUECO_NO_DISPONIBLE', 'Algún hueco ya está ocupado, bloqueado o ha pasado. Elige otros.', {
        huecos: noValidos.map((h) => h.id),
      });
    }
    huecos.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());

    // Sustituye la propuesta anterior ("Cambiar la propuesta" / "Proponer nuevas fechas").
    const anteriores = await tx
      .select()
      .from(propuestasCita)
      .where(and(eq(propuestasCita.solicitudId, solicitudId), inArray(propuestasCita.estado, ['PENDIENTE', 'CONFIRMADA', 'OTRA_FRANJA'])));
    for (const p of anteriores) {
      const e = await entrevistaActivaDePropuesta(tx, p.id);
      if (e) await liberarEntrevista(tx, e);
      await tx.update(propuestasCita).set({ estado: 'ANULADA' }).where(eq(propuestasCita.id, p.id));
    }
    await revocarTokens(tx, solicitudId, 'ELEGIR_CITA');

    const ultimo = huecos[huecos.length - 1]!;
    const [p] = await tx
      .insert(propuestasCita)
      .values({ solicitudId, enviadaPorId: usuarioId, mensaje: mensaje ?? null, expiraEn: ultimo.inicio })
      .returning();
    await tx.insert(propuestaHuecos).values(huecos.map((h, i) => ({ propuestaId: p!.id, huecoId: h.id, orden: i + 1 })));

    // El enlace vale hasta el día siguiente al último hueco propuesto (y se amplía al confirmar).
    const token = await crearToken(tx, {
      proposito: 'ELEGIR_CITA',
      solicitudId,
      propuestaId: p!.id,
      expiraEn: sumarDias(ultimo.fin, 1),
    });

    await tx.update(solicitudes).set({ revision, revisadaEn: ahora }).where(eq(solicitudes.id, solicitudId));
    const actor: Actor = { tipo: 'usuario', usuarioId };
    const detalle = { propuestaId: p!.id, huecos: huecos.map((h) => h.inicio.toISOString()), sustituye: anteriores.map((a) => a.id) };
    if (s.estado === 'CITACION_ENVIADA') await registrarEvento(tx, solicitudId, actor, 'CITACION_ENVIADA', { detalle });
    else await cambiarEstado(tx, s, 'CITACION_ENVIADA', actor, 'CITACION_ENVIADA', detalle);

    await encolarCorreo(tx, {
      plantilla: 'citacion-propuesta',
      para: s.email,
      correo: plantillas.propuestaCita({ ...datosCorreo(s, via), huecos: huecos.map(huecoTexto), enlace: urlCita(token), mensaje }),
      solicitudId,
    });

    return { propuestaId: p!.id, huecos: huecos.map((h) => ({ id: h.id, inicio: h.inicio, fin: h.fin, ...huecoTexto(h) })), expiraEn: p!.expiraEn };
  });
}

// ── Página pública "Albaydar Cita" ──────────────────────────────────────────

async function contextoToken(tx: Tx, token: string, bloquear = false) {
  const [t] = await tx.select().from(tokensPublicos).where(eq(tokensPublicos.tokenHash, hashToken(token))).limit(1);
  if (!t || t.proposito !== 'ELEGIR_CITA' || !t.propuestaId) throw notFound('Enlace no válido.', 'ENLACE_NO_VALIDO');
  if (t.revocadoEn) throw gone('PROPUESTA_SUSTITUIDA', 'Esta propuesta ha sido sustituida. Revisa el último correo que te hemos enviado.');
  if (t.expiraEn < new Date()) throw gone('ENLACE_CADUCADO', 'Este enlace ha caducado. Si necesitas una cita, contacta con secretaría.');

  const q = tx.select().from(propuestasCita).where(eq(propuestasCita.id, t.propuestaId));
  const [p] = bloquear ? await q.for('update') : await q;
  if (!p || p.estado === 'ANULADA') throw gone('PROPUESTA_SUSTITUIDA', 'Esta propuesta ha sido sustituida. Revisa el último correo que te hemos enviado.');
  const { s, via } = await obtenerSolicitud(tx, t.solicitudId, bloquear);
  return { t, p, s, via };
}

async function notasActuales(tx: Tx, solicitudId: string) {
  const [d] = await tx
    .select()
    .from(documentos)
    .where(and(eq(documentos.solicitudId, solicitudId), eq(documentos.tipo, 'BOLETIN_NOTAS'), isNull(documentos.eliminadoEn)))
    .orderBy(desc(documentos.createdAt))
    .limit(1);
  return d ?? null;
}

/** Estado de la página pública. Mismo vocabulario que el mockup (pick / done). */
export async function verCita(token: string) {
  const { t, p, s, via } = await contextoToken(db, token);
  await db.update(tokensPublicos).set({ ultimoUsoEn: new Date() }).where(eq(tokensPublicos.id, t.id));
  const huecos = await huecosDePropuesta(db, p.id);
  const entrevista = await entrevistaActivaDePropuesta(db, p.id);
  const notas = await notasActuales(db, s.id);
  const ahora = new Date();

  return {
    ref: s.codigo,
    alumno: `${s.alumnaNombre} ${s.alumnaApellidos}`.trim(),
    tutor: s.tutorNombre.split(/\s+/)[0],
    curso: `${ETIQUETA_FAMILIA_VIA[via.familia]} ${via.curso}º`,
    info: [
      { k: 'Tipo', v: CENTRO.entrevista.tipo },
      { k: 'Con', v: CENTRO.entrevista.con },
      { k: 'Lugar', v: `${CENTRO.entrevista.lugar} · ${CENTRO.direccion.split(' · ')[0]}` },
    ],
    /** propuesta | elegida | alternativa | caducada */
    estado: p.estado === 'CONFIRMADA' ? 'elegida' : p.estado === 'OTRA_FRANJA' ? 'alternativa' : p.estado === 'CADUCADA' ? 'caducada' : 'propuesta',
    mensaje: p.mensaje,
    slots: huecos.map((h) => ({
      id: h.id,
      ...huecoTexto(h),
      inicio: h.inicio,
      fin: h.fin,
      elegido: entrevista?.huecoId === h.id,
      disponible: entrevista?.huecoId === h.id || (h.estado === 'LIBRE' && h.inicio > ahora),
    })),
    elegida: entrevista ? { inicio: entrevista.inicio, fin: entrevista.fin, dia: diaLargo(entrevista.inicio), franja: franja(entrevista.inicio, entrevista.fin) } : null,
    alternativa: p.estado === 'OTRA_FRANJA' ? { franja: p.franjaSolicitada, prefiereLlamada: p.prefiereLlamada } : null,
    puedeCambiar: !entrevista || entrevista.inicio.getTime() - ahora.getTime() > HORAS_LIMITE_CAMBIO * 3_600_000,
    notas: notas ? { nombre: notas.nombreOriginal, tamano: notas.tamano, subidoEn: notas.createdAt } : null,
    notasHasta: entrevista?.inicio ?? null,
  };
}

/** La familia elige (o cambia) el hueco. La cita confirmada aparece sola en el calendario. */
export async function elegir(token: string, huecoId: string) {
  return db.transaction(async (tx) => {
    const { t, p, s, via } = await contextoToken(tx, token, true);
    if (p.estado === 'CADUCADA') throw gone('PROPUESTA_CADUCADA', 'Las fechas propuestas ya han pasado. Indícanos otra franja.');
    const huecos = await huecosDePropuesta(tx, p.id);
    if (!huecos.some((h) => h.id === huecoId)) throw badRequest('HUECO_NO_PROPUESTO', 'Esa fecha no está entre las propuestas.');

    const actual = await entrevistaActivaDePropuesta(tx, p.id);
    if (actual?.huecoId === huecoId) return { entrevistaId: actual.id, sinCambios: true }; // idempotente

    const ahora = new Date();
    if (actual && actual.inicio.getTime() - ahora.getTime() <= HORAS_LIMITE_CAMBIO * 3_600_000) {
      throw conflict('CAMBIO_FUERA_DE_PLAZO', `Quedan menos de ${HORAS_LIMITE_CAMBIO} horas para la entrevista. Para cambiarla, llama a secretaría (${CENTRO.telefono}).`);
    }

    // Reserva atómica: solo gana quien pase el hueco de LIBRE a OCUPADO.
    const [hueco] = await tx
      .update(huecosAgenda)
      .set({ estado: 'OCUPADO' })
      .where(and(eq(huecosAgenda.id, huecoId), eq(huecosAgenda.estado, 'LIBRE'), gt(huecosAgenda.inicio, ahora)))
      .returning();
    if (!hueco) throw conflict('HUECO_NO_DISPONIBLE', 'Esa fecha acaba de ocuparse. Elige otra o indícanos qué franja te vendría bien.');

    let entrevista: Entrevista;
    const cambio = !!actual;
    if (actual) {
      if (actual.huecoId) await tx.update(huecosAgenda).set({ estado: 'LIBRE' }).where(eq(huecosAgenda.id, actual.huecoId));
      [entrevista] = (await tx
        .update(entrevistas)
        .set({ huecoId: hueco.id, inicio: hueco.inicio, fin: hueco.fin, lugar: hueco.lugar, estado: 'REPROGRAMADA', secuenciaIcs: actual.secuenciaIcs + 1, recordatorioEnviadoEn: null })
        .where(eq(entrevistas.id, actual.id))
        .returning()) as [Entrevista];
    } else {
      [entrevista] = (await tx
        .insert(entrevistas)
        .values({ solicitudId: s.id, propuestaId: p.id, huecoId: hueco.id, inicio: hueco.inicio, fin: hueco.fin, lugar: hueco.lugar })
        .returning()) as [Entrevista];
    }

    await tx.update(propuestasCita).set({ estado: 'CONFIRMADA', respondidaEn: ahora, franjaSolicitada: null, prefiereLlamada: false }).where(eq(propuestasCita.id, p.id));
    // El enlace sigue sirviendo para subir notas o cambiar la fecha hasta el día de la entrevista.
    await tx.update(tokensPublicos).set({ expiraEn: sumarDias(hueco.fin, 1), ultimoUsoEn: ahora }).where(eq(tokensPublicos.id, t.id));

    const detalle = { entrevistaId: entrevista.id, inicio: hueco.inicio.toISOString(), cambio };
    if (s.estado === 'ENTREVISTA_PROGRAMADA') await registrarEvento(tx, s.id, { tipo: 'familia' }, 'CITA_CAMBIADA', { detalle });
    else await cambiarEstado(tx, s, 'ENTREVISTA_PROGRAMADA', { tipo: 'familia' }, 'CITA_CONFIRMADA', detalle);

    const datos = datosCorreo(s, via);
    const notas = await notasActuales(tx, s.id);
    await encolarCorreo(tx, {
      plantilla: cambio ? 'cita-actualizada' : 'cita-confirmada',
      para: s.email,
      correo: plantillas.citaConfirmada({ ...datos, ...huecoTexto(hueco), enlace: urlCita(token), faltanNotas: !notas, cambio }),
      adjuntos: [{ filename: 'entrevista-albaydar.ics', content: icsEntrevista(entrevista, datos.alumna), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }],
      solicitudId: s.id,
    });

    return { entrevistaId: entrevista.id, inicio: hueco.inicio, fin: hueco.fin, ...huecoTexto(hueco), cambio };
  });
}

/** "Ninguna me encaja": la familia indica su disponibilidad o pide que la llamen. */
export async function pedirOtraFranja(token: string, franjaTexto: string | null, prefiereLlamada: boolean) {
  if (!franjaTexto?.trim() && !prefiereLlamada) throw badRequest('FALTA_DISPONIBILIDAD', 'Elige una fecha o dinos qué franja te vendría bien.');
  return db.transaction(async (tx) => {
    const { t, p, s, via } = await contextoToken(tx, token, true);
    const actual = await entrevistaActivaDePropuesta(tx, p.id);
    const ahora = new Date();
    if (actual) {
      if (actual.inicio.getTime() - ahora.getTime() <= HORAS_LIMITE_CAMBIO * 3_600_000) {
        throw conflict('CAMBIO_FUERA_DE_PLAZO', `Quedan menos de ${HORAS_LIMITE_CAMBIO} horas para la entrevista. Para cambiarla, llama a secretaría (${CENTRO.telefono}).`);
      }
      await liberarEntrevista(tx, actual);
    }
    await tx
      .update(propuestasCita)
      .set({ estado: 'OTRA_FRANJA', franjaSolicitada: franjaTexto?.trim() || null, prefiereLlamada, respondidaEn: ahora })
      .where(eq(propuestasCita.id, p.id));
    await tx.update(tokensPublicos).set({ ultimoUsoEn: ahora }).where(eq(tokensPublicos.id, t.id));
    await cambiarEstado(tx, s, 'OTRA_FRANJA_SOLICITADA', { tipo: 'familia' }, 'OTRA_FRANJA_SOLICITADA', {
      franja: franjaTexto,
      prefiereLlamada,
      cancelaEntrevista: actual?.id ?? null,
    });

    const datos = datosCorreo(s, via);
    await encolarCorreo(tx, {
      plantilla: 'aviso-otra-franja',
      para: env.MAIL_SECRETARIA,
      correo: plantillas.avisoOtraFranja({ ...datos, tutor: s.tutorNombre, franja: franjaTexto, prefiereLlamada, telefono: s.telefono, urlBandeja: `${env.PUBLIC_APP_URL}/admision?ref=${s.codigo}` }),
      solicitudId: s.id,
    });
    if (actual) {
      await encolarCorreo(tx, {
        plantilla: 'cita-cancelada-ics',
        para: s.email,
        correo: plantillas.citaCancelada({ ...datos, dia: diaLargo(actual.inicio), franja: franja(actual.inicio, actual.fin), motivo: 'Has indicado que prefieres otra franja; te escribiremos con una nueva fecha.' }),
        adjuntos: [{ filename: 'entrevista-albaydar.ics', content: icsEntrevista({ ...actual, secuenciaIcs: actual.secuenciaIcs + 1 }, datos.alumna, true), contentType: 'text/calendar; charset=utf-8; method=CANCEL' }],
        solicitudId: s.id,
      });
    }
    return { estado: 'alternativa' as const };
  });
}

/** .ics para el botón "Añadir a mi calendario". */
export async function icsDeToken(token: string) {
  const { p, s } = await contextoToken(db, token);
  const e = await entrevistaActivaDePropuesta(db, p.id);
  if (!e) throw notFound('Aún no has elegido fecha.', 'SIN_CITA');
  return icsEntrevista(e, `${s.alumnaNombre} ${s.alumnaApellidos}`);
}

/** Para subir/quitar notas desde el enlace. */
export async function solicitudDeToken(token: string) {
  const { s, p } = await contextoToken(db, token);
  const e = await entrevistaActivaDePropuesta(db, p.id);
  if (e && e.fin < new Date()) throw gone('ENTREVISTA_PASADA', 'La entrevista ya se ha celebrado.');
  return s;
}

export type { PropuestaCita };
