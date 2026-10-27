import { and, asc, desc, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { CENTRO, env } from '../../config/env';
import {
  documentos,
  entrevistas,
  franjasAgenda,
  propuestasCita,
  solicitudes,
  tokensPublicos,
  type Entrevista,
  type FranjaAgenda,
  type PropuestaCita,
} from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { badRequest, conflict, gone, notFound } from '../../lib/errors';
import { hashToken } from '../../lib/crypto';
import { diaLargo, fechaHoraFrase, fechaLocal, franja, hora, horaLocalAUtc, sumarDias, sumarMin } from '../../lib/fechas';
import { enviarEvento } from '../../correo/enviar';
import { generarIcs } from '../../correo/ics';
import { boton, lista } from '../../correo/plantillas';
import { agendaConfig } from '../ajustes/ajustes.service';
import { dentroDeJornada, esSolape, ocupaciones } from '../agenda/agenda.service';
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
import { ESTADOS_ENTREVISTA_PREVIA, ESTADOS_PUEDE_CITAR, ETIQUETA_ESTADO, ETIQUETA_FAMILIA_VIA } from '../solicitudes/dominio';

/**
 * Reglas de la citación (validadas con el cliente):
 *  - Secretaría propone de 1 a 3 fechas dentro de la jornada (L–V 8:00–18:00 por defecto).
 *  - Esas fechas quedan RESERVADAS para la familia hasta que elija una: nadie más puede ocuparlas.
 *  - Al elegir, la elegida se confirma y las otras vuelven a estar libres.
 *  - La familia solo puede cambiar la fecha durante las 24 h siguientes a aceptarla.
 *  - La entrevista es siempre presencial, con el equipo directivo, en la sala de Dirección.
 */
export const HORAS_PARA_CAMBIAR = 24;

// ── Utilidades ──────────────────────────────────────────────────────────────

const textoFranja = (f: Pick<FranjaAgenda, 'inicio' | 'fin'>) => `${diaLargo(f.inicio)} · ${franja(f.inicio, f.fin)}`;
const limiteCambio = (p: Pick<PropuestaCita, 'confirmadaEn'>) => (p.confirmadaEn ? new Date(p.confirmadaEn.getTime() + HORAS_PARA_CAMBIAR * 3_600_000) : null);

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
const adjuntoIcs = (e: Entrevista, alumna: string, cancelar = false) => ({
  filename: 'entrevista-albaydar.ics',
  content: icsEntrevista(e, alumna, cancelar),
  contentType: `text/calendar; charset=utf-8; method=${cancelar ? 'CANCEL' : 'PUBLISH'}`,
});

const franjasDe = (tx: Tx, propuestaId: string) =>
  tx.select().from(franjasAgenda).where(eq(franjasAgenda.propuestaId, propuestaId)).orderBy(asc(franjasAgenda.inicio));

async function entrevistaActivaDe(tx: Tx, propuestaId: string) {
  const [e] = await tx
    .select()
    .from(entrevistas)
    .where(and(eq(entrevistas.propuestaId, propuestaId), notInArray(entrevistas.estado, ['CANCELADA'])))
    .limit(1);
  return e ?? null;
}

/** Devuelve a la agenda las franjas de una propuesta (todas, o todas menos una). */
async function liberarFranjas(tx: Tx, propuestaId: string, excepto?: string) {
  await tx
    .update(franjasAgenda)
    .set({ estado: 'LIBERADA' })
    .where(
      and(
        eq(franjasAgenda.propuestaId, propuestaId),
        inArray(franjasAgenda.estado, ['RESERVADA', 'CONFIRMADA']),
        ...(excepto ? [ne(franjasAgenda.id, excepto)] : []),
      ),
    );
}

async function cancelarEntrevista(tx: Tx, e: Entrevista) {
  const [act] = await tx
    .update(entrevistas)
    .set({ estado: 'CANCELADA', secuenciaIcs: e.secuenciaIcs + 1 })
    .where(eq(entrevistas.id, e.id))
    .returning();
  if (e.franjaId) await tx.update(franjasAgenda).set({ estado: 'LIBERADA' }).where(eq(franjasAgenda.id, e.franjaId));
  return act!;
}

async function hayNotas(tx: Tx, solicitudId: string) {
  const [d] = await tx
    .select({ id: documentos.id })
    .from(documentos)
    .where(and(eq(documentos.solicitudId, solicitudId), eq(documentos.tipo, 'BOLETIN_NOTAS'), isNull(documentos.eliminadoEn)))
    .limit(1);
  return !!d;
}

/**
 * Anula las propuestas vigentes de una solicitud: cancela la entrevista que hubiera, devuelve
 * sus fechas a la agenda e invalida el enlace de la familia. La avisa quien llama, si toca.
 */
async function anularPropuestasVigentes(tx: Tx, solicitudId: string) {
  const anteriores = await tx
    .select()
    .from(propuestasCita)
    .where(and(eq(propuestasCita.solicitudId, solicitudId), inArray(propuestasCita.estado, ['PENDIENTE', 'CONFIRMADA', 'OTRA_FRANJA'])));
  let canceladaParaAvisar: Entrevista | null = null;
  for (const p of anteriores) {
    const e = await entrevistaActivaDe(tx, p.id);
    if (e) canceladaParaAvisar = await cancelarEntrevista(tx, e);
    await liberarFranjas(tx, p.id);
    await tx.update(propuestasCita).set({ estado: 'ANULADA' }).where(eq(propuestasCita.id, p.id));
  }
  await revocarTokens(tx, solicitudId, 'ELEGIR_CITA');
  return { anteriores, canceladaParaAvisar };
}

export const AVISO_NOTAS_HTML =
  '<p><strong>Recuerda subir el boletín de notas del último curso</strong> desde tu enlace antes de la entrevista.</p>';

// ── Secretaría: proponer de 1 a 3 fechas ────────────────────────────────────

export async function proponer(
  solicitudId: string,
  o: { inicios: string[]; duracion?: number; mensaje?: string | null },
  usuarioId: string,
) {
  const cfg = await agendaConfig();
  const duracion = o.duracion ?? cfg.duracionPorDefecto;
  if (!cfg.duraciones.includes(duracion)) throw badRequest('DURACION_NO_VALIDA', `La entrevista dura ${cfg.duraciones.join(' o ')} minutos.`);

  const inicios = [...new Set(o.inicios.map((x) => new Date(x).getTime()))].sort((a, b) => a - b).map((t) => new Date(t));
  if (inicios.length < 1 || inicios.length > 3) throw badRequest('FECHAS_INVALIDAS', 'Propón entre 1 y 3 fechas distintas.');
  const franjasNuevas = inicios.map((inicio) => ({ inicio, fin: sumarMin(inicio, duracion) }));

  const limite = new Date(Date.now() + cfg.antelacionMinHoras * 3_600_000);
  for (const f of franjasNuevas) {
    if (f.inicio < limite) throw badRequest('FECHA_DEMASIADO_PRONTO', `${textoFranja(f)}: propón fechas con al menos ${cfg.antelacionMinHoras} h de antelación.`);
    const fuera = dentroDeJornada(f.inicio, f.fin, cfg);
    if (fuera) throw badRequest('FUERA_DE_HORARIO', `${textoFranja(f)}: ${fuera}`);
  }
  for (let i = 1; i < franjasNuevas.length; i++) {
    if (franjasNuevas[i]!.inicio < franjasNuevas[i - 1]!.fin) throw badRequest('FECHAS_SOLAPADAS', 'Las fechas propuestas se solapan entre sí.');
  }

  return db.transaction(async (tx) => {
    const { s, via } = await obtenerSolicitud(tx, solicitudId, true);
    if (!ESTADOS_PUEDE_CITAR.includes(s.estado)) {
      throw conflict('ESTADO_NO_PERMITE', `No se puede citar una solicitud en estado “${ETIQUETA_ESTADO[s.estado]}”.`);
    }
    const revision = await calcularRevision(tx, s, via);
    if (!revision.puedeCitar) throw conflict('SOLICITUD_INCOMPLETA', 'Pide a la familia que la complete antes de citar a entrevista.', { faltan: revision.faltan });

    // "Cambiar la propuesta" / "Proponer nuevas fechas": se anula la anterior y se liberan sus fechas.
    const { anteriores, canceladaParaAvisar } = await anularPropuestasVigentes(tx, solicitudId);

    // Comprobación con mensaje claro; la restricción de la BD es la garantía final.
    const ocupadas = await ocupaciones(tx, franjasNuevas[0]!.inicio, franjasNuevas[franjasNuevas.length - 1]!.fin);
    const chocan = franjasNuevas.filter((f) => ocupadas.some((x) => x.inicio < f.fin && x.fin > f.inicio));
    if (chocan.length) {
      throw conflict('FRANJA_OCUPADA', `Ya no está libre: ${chocan.map(textoFranja).join(', ')}. Actualiza la agenda y elige otra.`, {
        inicios: chocan.map((f) => f.inicio.toISOString()),
      });
    }

    const ultimo = franjasNuevas[franjasNuevas.length - 1]!;
    const [p] = await tx
      .insert(propuestasCita)
      .values({ solicitudId, enviadaPorId: usuarioId, mensaje: o.mensaje ?? null, duracionMin: duracion, expiraEn: ultimo.inicio })
      .returning();
    let reservadas: FranjaAgenda[];
    try {
      reservadas = await tx
        .insert(franjasAgenda)
        .values(franjasNuevas.map((f, i) => ({ ...f, estado: 'RESERVADA' as const, propuestaId: p!.id, orden: i + 1, creadoPorId: usuarioId })))
        .returning();
    } catch (e) {
      if (esSolape(e)) throw conflict('FRANJA_OCUPADA', 'Alguna de las fechas se acaba de ocupar. Actualiza la agenda y elige otra.');
      throw e;
    }

    const token = await crearToken(tx, { proposito: 'ELEGIR_CITA', solicitudId, propuestaId: p!.id, expiraEn: sumarDias(ultimo.fin, 1) });
    await tx.update(solicitudes).set({ revision, revisadaEn: new Date() }).where(eq(solicitudes.id, solicitudId));

    const actor: Actor = { tipo: 'usuario', usuarioId };
    const detalle = { propuestaId: p!.id, duracion, fechas: franjasNuevas.map((f) => f.inicio.toISOString()), sustituye: anteriores.map((a) => a.id) };
    if (s.estado === 'CITACION_ENVIADA') await registrarEvento(tx, solicitudId, actor, 'CITACION_ENVIADA', { detalle });
    else await cambiarEstado(tx, s, 'CITACION_ENVIADA', actor, 'CITACION_ENVIADA', detalle);

    const base = datosCorreo(s, via);
    if (canceladaParaAvisar) {
      await enviarEvento(tx, 'CITA_CANCELADA', {
        para: s.email,
        vars: { ...base, fecha_entrevista: diaLargo(canceladaParaAvisar.inicio), hora: hora(canceladaParaAvisar.inicio), motivo: 'Te enviamos nuevas fechas en otro correo.' },
        adjuntos: [adjuntoIcs(canceladaParaAvisar, base.alumna, true)],
        solicitudId,
      });
    }
    const enlace = urlCita(token);
    await enviarEvento(tx, 'CITACION_PROPUESTA', {
      para: s.email,
      vars: {
        ...base,
        fechas_propuestas: lista(franjasNuevas.map(textoFranja)),
        duracion,
        sala: CENTRO.entrevista.lugar,
        con: CENTRO.entrevista.con.toLowerCase(),
        mensaje: o.mensaje ?? '',
        enlace,
        boton: boton(enlace, 'Elegir la fecha'),
      },
      solicitudId,
    });

    return {
      propuestaId: p!.id,
      duracion,
      reservadasHasta: p!.expiraEn,
      franjas: reservadas.map((f) => ({ id: f.id, inicio: f.inicio, fin: f.fin, dia: diaLargo(f.inicio), franja: franja(f.inicio, f.fin), estado: f.estado })),
    };
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

const cambioFueraDePlazo = () =>
  conflict(
    'CAMBIO_FUERA_DE_PLAZO',
    `Han pasado más de ${HORAS_PARA_CAMBIAR} horas desde que confirmaste la fecha. Para cambiarla, llama a secretaría (${CENTRO.telefono}).`,
  );

/** Estado de la página pública (mismo vocabulario que el mockup). */
export async function verCita(token: string) {
  const { t, p, s, via } = await contextoToken(db, token);
  await db.update(tokensPublicos).set({ ultimoUsoEn: new Date() }).where(eq(tokensPublicos.id, t.id));
  const fs = await franjasDe(db, p.id);
  const entrevista = await entrevistaActivaDe(db, p.id);
  const [notas] = await db
    .select()
    .from(documentos)
    .where(and(eq(documentos.solicitudId, s.id), eq(documentos.tipo, 'BOLETIN_NOTAS'), isNull(documentos.eliminadoEn)))
    .orderBy(desc(documentos.createdAt))
    .limit(1);
  const ahora = new Date();
  // Las fechas que ya se liberaron solo se pueden volver a elegir si siguen libres.
  const ocupadas = fs.length ? await ocupaciones(db, fs[0]!.inicio, fs[fs.length - 1]!.fin) : [];
  const libre = (f: FranjaAgenda) => !ocupadas.some((x) => x.id !== f.id && x.inicio < f.fin && x.fin > f.inicio);
  const hasta = limiteCambio(p);

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
    duracion: p.duracionMin,
    mensaje: p.mensaje,
    slots: fs.map((f) => {
      const elegido = entrevista?.franjaId === f.id;
      return {
        id: f.id,
        day: diaLargo(f.inicio),
        time: franja(f.inicio, f.fin),
        inicio: f.inicio,
        fin: f.fin,
        elegido,
        disponible: elegido || (f.inicio > ahora && (f.estado === 'RESERVADA' || (f.estado === 'LIBERADA' && libre(f)))),
      };
    }),
    elegida: entrevista ? { inicio: entrevista.inicio, fin: entrevista.fin, day: diaLargo(entrevista.inicio), time: franja(entrevista.inicio, entrevista.fin) } : null,
    alternativa: p.estado === 'OTRA_FRANJA' ? { franja: p.franjaSolicitada, prefiereLlamada: p.prefiereLlamada } : null,
    /** La familia solo puede cambiar durante las 24 h siguientes a aceptar. */
    puedeCambiar: !hasta || (ahora < hasta && (!entrevista || entrevista.inicio > ahora)),
    cambioHasta: hasta,
    notas: notas ? { nombre: notas.nombreOriginal, tamano: notas.tamano, subidoEn: notas.createdAt } : null,
    notasHasta: entrevista?.inicio ?? null,
  };
}

/**
 * La familia elige (o, dentro de las 24 h, cambia) la fecha. La cita aparece sola en el calendario.
 * Devuelve la cita completa (como GET /citas/:token) más `cambio`.
 */
export async function elegir(token: string, franjaId: string) {
  const { cambio } = await elegirEnTx(token, franjaId);
  return { ...(await verCita(token)), cambio };
}

async function elegirEnTx(token: string, franjaId: string) {
  return db.transaction(async (tx) => {
    const { t, p, s, via } = await contextoToken(tx, token, true);
    if (p.estado === 'CADUCADA') throw gone('PROPUESTA_CADUCADA', 'Las fechas propuestas ya han pasado. Indícanos otra franja.');
    const [elegida] = await tx.select().from(franjasAgenda).where(and(eq(franjasAgenda.id, franjaId), eq(franjasAgenda.propuestaId, p.id)));
    if (!elegida) throw badRequest('FECHA_NO_PROPUESTA', 'Esa fecha no está entre las propuestas.');

    const actual = await entrevistaActivaDe(tx, p.id);
    if (actual?.franjaId === franjaId) return { cambio: false };
    const ahora = new Date();
    const hasta = limiteCambio(p);
    if (hasta && ahora > hasta) throw cambioFueraDePlazo();
    if (elegida.inicio <= ahora) throw conflict('FECHA_PASADA', 'Esa fecha ya ha pasado. Elige otra.');

    // Las demás fechas de la propuesta vuelven a la agenda; la elegida se confirma.
    await liberarFranjas(tx, p.id, franjaId);
    try {
      const [ok] = await tx
        .update(franjasAgenda)
        .set({ estado: 'CONFIRMADA' })
        .where(and(eq(franjasAgenda.id, franjaId), inArray(franjasAgenda.estado, ['RESERVADA', 'LIBERADA'])))
        .returning({ id: franjasAgenda.id });
      if (!ok) throw conflict('HUECO_NO_DISPONIBLE', 'Esa fecha ya no está disponible.');
    } catch (e) {
      if (esSolape(e)) throw conflict('HUECO_NO_DISPONIBLE', 'Esa fecha ya no está disponible. Elige otra o indícanos qué franja te vendría bien.');
      throw e;
    }

    let entrevista: Entrevista;
    const cambio = !!actual;
    if (actual) {
      [entrevista] = (await tx
        .update(entrevistas)
        .set({ franjaId, inicio: elegida.inicio, fin: elegida.fin, estado: 'REPROGRAMADA', secuenciaIcs: actual.secuenciaIcs + 1, recordatorioEnviadoEn: null })
        .where(eq(entrevistas.id, actual.id))
        .returning()) as [Entrevista];
    } else {
      [entrevista] = (await tx
        .insert(entrevistas)
        .values({ solicitudId: s.id, propuestaId: p.id, franjaId, inicio: elegida.inicio, fin: elegida.fin, lugar: CENTRO.entrevista.lugar })
        .returning()) as [Entrevista];
    }

    // El plazo de 24 h cuenta desde la PRIMERA vez que acepta (cambiar no lo amplía).
    const confirmadaEn = p.confirmadaEn ?? ahora;
    await tx
      .update(propuestasCita)
      .set({ estado: 'CONFIRMADA', respondidaEn: ahora, confirmadaEn, franjaSolicitada: null, prefiereLlamada: false })
      .where(eq(propuestasCita.id, p.id));
    // El enlace sigue valiendo para subir las notas hasta el día de la entrevista.
    await tx.update(tokensPublicos).set({ expiraEn: sumarDias(elegida.fin, 1), ultimoUsoEn: ahora }).where(eq(tokensPublicos.id, t.id));

    const detalle = { entrevistaId: entrevista.id, inicio: elegida.inicio.toISOString(), cambio };
    if (s.estado === 'ENTREVISTA_PROGRAMADA') await registrarEvento(tx, s.id, { tipo: 'familia' }, 'CITA_CAMBIADA', { detalle });
    else await cambiarEstado(tx, s, 'ENTREVISTA_PROGRAMADA', { tipo: 'familia' }, 'CITA_CONFIRMADA', detalle);

    const base = datosCorreo(s, via);
    const enlace = urlCita(token);
    const limite = new Date(confirmadaEn.getTime() + HORAS_PARA_CAMBIAR * 3_600_000);
    await enviarEvento(tx, cambio ? 'CITA_CAMBIADA' : 'CITA_CONFIRMADA', {
      para: s.email,
      vars: {
        ...base,
        fecha_entrevista: diaLargo(elegida.inicio),
        hora: hora(elegida.inicio),
        hora_fin: hora(elegida.fin),
        sala: CENTRO.entrevista.lugar,
        con: CENTRO.entrevista.con.toLowerCase(),
        cambio_hasta: fechaHoraFrase(limite),
        aviso_notas: (await hayNotas(tx, s.id)) ? '' : AVISO_NOTAS_HTML,
        enlace,
        boton: boton(enlace, 'Ver o cambiar la cita'),
      },
      adjuntos: [adjuntoIcs(entrevista, base.alumna)],
      solicitudId: s.id,
    });

    return { cambio };
  });
}

/** "Ninguna me encaja": libera las fechas reservadas y avisa a secretaría. Devuelve la cita completa. */
export async function pedirOtraFranja(token: string, franjaTexto: string | null, prefiereLlamada: boolean) {
  if (!franjaTexto?.trim() && !prefiereLlamada) throw badRequest('FALTA_DISPONIBILIDAD', 'Elige una fecha o dinos qué franja te vendría bien.');
  await db.transaction(async (tx) => {
    const { t, p, s, via } = await contextoToken(tx, token, true);
    const ahora = new Date();
    const hasta = limiteCambio(p);
    if (hasta && ahora > hasta) throw cambioFueraDePlazo();

    const actual = await entrevistaActivaDe(tx, p.id);
    const cancelada = actual ? await cancelarEntrevista(tx, actual) : null;
    await liberarFranjas(tx, p.id);
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

    const base = datosCorreo(s, via);
    const urlSolicitud = `${env.PUBLIC_APP_URL}/admision?ref=${s.codigo}`;
    await enviarEvento(tx, 'AVISO_OTRA_FRANJA', {
      para: env.MAIL_SECRETARIA,
      vars: {
        ...base,
        tutor: s.tutorNombre,
        telefono: s.telefono,
        franja_solicitada: franjaTexto?.trim() || 'Sin indicar',
        prefiere_llamada: prefiereLlamada ? 'Sí' : 'No',
        enlace: urlSolicitud,
        boton: boton(urlSolicitud, 'Abrir la solicitud'),
      },
      solicitudId: s.id,
    });
    if (cancelada) {
      await enviarEvento(tx, 'CITA_CANCELADA', {
        para: s.email,
        vars: { ...base, fecha_entrevista: diaLargo(cancelada.inicio), hora: hora(cancelada.inicio), motivo: 'Has indicado que prefieres otra franja; te escribiremos con una nueva fecha.' },
        adjuntos: [adjuntoIcs(cancelada, base.alumna, true)],
        solicitudId: s.id,
      });
    }
  });
  return verCita(token);
}

/** .ics para "Añadir a mi calendario". */
export async function icsDeToken(token: string) {
  const { p, s } = await contextoToken(db, token);
  const e = await entrevistaActivaDe(db, p.id);
  if (!e) throw notFound('Aún no has elegido fecha.', 'SIN_CITA');
  return icsEntrevista(e, `${s.alumnaNombre} ${s.alumnaApellidos}`);
}

/** Para subir/quitar notas desde el enlace. */
export async function solicitudDeToken(token: string) {
  const { s, p } = await contextoToken(db, token);
  const e = await entrevistaActivaDe(db, p.id);
  if (e && e.fin < new Date()) throw gone('ENTREVISTA_PASADA', 'La entrevista ya se ha celebrado.');
  return s;
}

export { cancelarEntrevista, liberarFranjas, adjuntoIcs };

// ── Entrevista previa (paso 6 del diagrama) ─────────────────────────────────

/** Lugar con el que se guarda una entrevista hecha fuera de la plataforma: no ocupa la agenda. */
export const LUGAR_ENTREVISTA_PREVIA = 'Entrevista previa (registrada sin cita)';

export const entrevistaPreviaBody = z.object({
  /** Día en que se celebró (AAAA-MM-DD). Nunca futuro: si aún no se ha hecho, se cita. */
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD.'),
  /** Nota de la entrevista: no la ve la familia. */
  notas: z.string().trim().max(4000).optional().nullable(),
});

/**
 * «¿Ya tuvo entrevista? Sí»: se registra la entrevista ya celebrada, sin repetirla y sin
 * ocupar la agenda, y la solicitud pasa directa a «Evaluada · pendiente de decisión».
 * Si había fechas propuestas, se anulan y se liberan (sin correo: la familia ya fue entrevistada).
 */
export async function registrarEntrevistaPrevia(solicitudId: string, d: z.infer<typeof entrevistaPreviaBody>, usuarioId: string) {
  if (d.fecha > fechaLocal(new Date())) {
    throw badRequest('FECHA_FUTURA', 'La entrevista previa no puede tener fecha futura: si aún no se ha hecho, cita a la familia.');
  }
  const cfg = await agendaConfig();
  return db.transaction(async (tx) => {
    const { s, via } = await obtenerSolicitud(tx, solicitudId, true);
    if (!ESTADOS_ENTREVISTA_PREVIA.includes(s.estado)) {
      throw conflict('ESTADO_NO_PERMITE', `No se puede registrar una entrevista previa en una solicitud en estado “${ETIQUETA_ESTADO[s.estado]}”.`);
    }
    const revision = await calcularRevision(tx, s, via);
    if (!revision.puedeCitar) {
      throw conflict('SOLICITUD_INCOMPLETA', 'Completa los datos de la solicitud antes de registrar la entrevista.', { faltan: revision.faltan });
    }

    const { anteriores } = await anularPropuestasVigentes(tx, solicitudId);
    const inicio = horaLocalAUtc(d.fecha, '12:00');
    const [e] = await tx
      .insert(entrevistas)
      .values({
        solicitudId,
        inicio,
        fin: sumarMin(inicio, cfg.duracionPorDefecto),
        lugar: LUGAR_ENTREVISTA_PREVIA,
        estado: 'REALIZADA',
        notas: d.notas?.trim() || null,
      })
      .returning();
    await tx.update(solicitudes).set({ revision, revisadaEn: new Date() }).where(eq(solicitudes.id, solicitudId));
    await cambiarEstado(tx, s, 'ENTREVISTA_REALIZADA', { tipo: 'usuario', usuarioId }, 'ENTREVISTA_PREVIA', {
      entrevistaId: e!.id,
      fecha: d.fecha,
      sustituye: anteriores.map((a) => a.id),
    });

    return {
      estado: 'ENTREVISTA_REALIZADA' as const,
      estadoEtiqueta: ETIQUETA_ESTADO.ENTREVISTA_REALIZADA,
      entrevista: { id: e!.id, inicio: e!.inicio, fin: e!.fin, dia: diaLargo(e!.inicio), estado: e!.estado, lugar: e!.lugar, notas: e!.notas },
    };
  });
}
