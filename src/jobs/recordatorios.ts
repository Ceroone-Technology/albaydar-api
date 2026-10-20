import { and, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import { CENTRO, env } from '../config/env';
import { documentos, entrevistas, franjasAgenda, propuestasCita, tokensPublicos } from '../db/schema';
import { db, type Tx } from '../lib/db';
import { diaLargo, fechaLocal, franja, hora, sumarDias } from '../lib/fechas';
import { logger } from '../lib/logger';
import { enviarEvento } from '../correo/enviar';
import { boton, lista } from '../correo/plantillas';
import { AVISO_NOTAS_HTML, liberarFranjas } from '../modules/citacion/citacion.service';
import { cambiarEstado, crearToken, datosCorreo, obtenerSolicitud, registrarEvento, urlCita } from '../modules/solicitudes/comun';

/**
 * Como los tokens solo se guardan hasheados, los recordatorios llevan un enlace
 * NUEVO a la misma propuesta (el anterior sigue valiendo).
 */
async function enlaceNuevo(tx: Tx, solicitudId: string, propuestaId: string) {
  const [t] = await tx
    .select({ expiraEn: tokensPublicos.expiraEn })
    .from(tokensPublicos)
    .where(and(eq(tokensPublicos.propuestaId, propuestaId), isNull(tokensPublicos.revocadoEn)))
    .limit(1);
  const token = await crearToken(tx, { proposito: 'ELEGIR_CITA', solicitudId, propuestaId, expiraEn: t?.expiraEn ?? sumarDias(new Date(), env.CITA_TOKEN_TTL_DAYS) });
  return urlCita(token);
}

/** "Si no responde en 3 días, se le envía un recordatorio." Uno solo por propuesta. */
export async function recordatoriosPropuesta(ahora = new Date()) {
  const limite = sumarDias(ahora, -env.RECORDATORIO_CITA_DIAS);
  const ps = await db
    .select({ id: propuestasCita.id, solicitudId: propuestasCita.solicitudId })
    .from(propuestasCita)
    .where(and(eq(propuestasCita.estado, 'PENDIENTE'), lte(propuestasCita.createdAt, limite), isNull(propuestasCita.recordatorioEnviadoEn), gt(propuestasCita.expiraEn, ahora)));

  let enviados = 0;
  for (const { id, solicitudId } of ps) {
    await db.transaction(async (tx) => {
      // Reclamar la propuesta: si otra instancia ya lo hizo, no se duplica.
      const r = await tx
        .update(propuestasCita)
        .set({ recordatorioEnviadoEn: ahora })
        .where(and(eq(propuestasCita.id, id), isNull(propuestasCita.recordatorioEnviadoEn), eq(propuestasCita.estado, 'PENDIENTE')))
        .returning({ id: propuestasCita.id });
      if (!r.length) return;
      const fs = await tx
        .select()
        .from(franjasAgenda)
        .where(and(eq(franjasAgenda.propuestaId, id), eq(franjasAgenda.estado, 'RESERVADA'), gt(franjasAgenda.inicio, ahora)))
        .orderBy(franjasAgenda.inicio);
      if (!fs.length) return;
      const { s, via } = await obtenerSolicitud(tx, solicitudId);
      const enlace = await enlaceNuevo(tx, solicitudId, id);
      const enviado = await enviarEvento(tx, 'CITACION_RECORDATORIO', {
        para: s.email,
        vars: {
          ...datosCorreo(s, via),
          fechas_propuestas: lista(fs.map((f) => `${diaLargo(f.inicio)} · ${franja(f.inicio, f.fin)}`)),
          sala: CENTRO.entrevista.lugar,
          enlace,
          boton: boton(enlace, 'Elegir la fecha'),
        },
        solicitudId,
      });
      await registrarEvento(tx, solicitudId, { tipo: 'sistema' }, 'RECORDATORIO_CITACION', { detalle: { propuestaId: id, enviado } });
      if (enviado) enviados++;
    });
  }
  return enviados;
}

/** Recordatorio el día antes de la entrevista, a partir de las 10:00 (hora de Madrid). */
export async function recordatoriosEntrevista(ahora = new Date()) {
  const horaMadrid = Number(new Intl.DateTimeFormat('es-ES', { timeZone: env.TZ_CENTRO, hour: '2-digit', hourCycle: 'h23' }).format(ahora));
  if (horaMadrid < 10) return 0;
  const manana = fechaLocal(sumarDias(ahora, 1));
  const candidatas = await db
    .select()
    .from(entrevistas)
    .where(and(inArray(entrevistas.estado, ['PROGRAMADA', 'REPROGRAMADA']), isNull(entrevistas.recordatorioEnviadoEn), gt(entrevistas.inicio, ahora), lt(entrevistas.inicio, sumarDias(ahora, 2))));

  let enviados = 0;
  for (const e of candidatas.filter((x) => fechaLocal(x.inicio) === manana)) {
    await db.transaction(async (tx) => {
      const r = await tx
        .update(entrevistas)
        .set({ recordatorioEnviadoEn: ahora })
        .where(and(eq(entrevistas.id, e.id), isNull(entrevistas.recordatorioEnviadoEn)))
        .returning({ id: entrevistas.id });
      if (!r.length) return;
      const { s, via } = await obtenerSolicitud(tx, e.solicitudId);
      const [notas] = await tx
        .select({ id: documentos.id })
        .from(documentos)
        .where(and(eq(documentos.solicitudId, s.id), eq(documentos.tipo, 'BOLETIN_NOTAS'), isNull(documentos.eliminadoEn)))
        .limit(1);
      const enlace = e.propuestaId ? await enlaceNuevo(tx, s.id, e.propuestaId) : env.PUBLIC_APP_URL;
      const enviado = await enviarEvento(tx, 'ENTREVISTA_RECORDATORIO', {
        para: s.email,
        vars: {
          ...datosCorreo(s, via),
          fecha_entrevista: diaLargo(e.inicio),
          hora: hora(e.inicio),
          hora_fin: hora(e.fin),
          sala: e.lugar,
          con: CENTRO.entrevista.con.toLowerCase(),
          aviso_notas: notas ? '' : AVISO_NOTAS_HTML,
          enlace,
          boton: boton(enlace, 'Ver la cita'),
        },
        solicitudId: s.id,
      });
      await registrarEvento(tx, s.id, { tipo: 'sistema' }, 'RECORDATORIO_ENTREVISTA', { detalle: { entrevistaId: e.id, enviado } });
      if (enviado) enviados++;
    });
  }
  return enviados;
}

/** Propuestas cuyas fechas ya pasaron sin respuesta: caducan, se liberan y la solicitud vuelve a revisión. */
export async function caducarPropuestas(ahora = new Date()) {
  const ps = await db
    .select({ id: propuestasCita.id, solicitudId: propuestasCita.solicitudId })
    .from(propuestasCita)
    .where(and(eq(propuestasCita.estado, 'PENDIENTE'), lte(propuestasCita.expiraEn, ahora)));
  for (const p of ps) {
    await db.transaction(async (tx) => {
      const r = await tx
        .update(propuestasCita)
        .set({ estado: 'CADUCADA' })
        .where(and(eq(propuestasCita.id, p.id), eq(propuestasCita.estado, 'PENDIENTE')))
        .returning({ id: propuestasCita.id });
      if (!r.length) return;
      await liberarFranjas(tx, p.id);
      const { s } = await obtenerSolicitud(tx, p.solicitudId, true);
      if (s.estado === 'CITACION_ENVIADA') await cambiarEstado(tx, s, 'EN_REVISION', { tipo: 'sistema' }, 'PROPUESTA_CADUCADA', { propuestaId: p.id });
    });
  }
  if (ps.length) logger.info({ n: ps.length }, 'Propuestas de cita caducadas');
  return ps.length;
}
