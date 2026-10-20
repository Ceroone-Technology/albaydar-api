import { and, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import { env } from '../config/env';
import { documentos, entrevistas, huecosAgenda, propuestaHuecos, propuestasCita, tokensPublicos } from '../db/schema';
import { db } from '../lib/db';
import { diaLargo, fechaLocal, franja, sumarDias } from '../lib/fechas';
import { logger } from '../lib/logger';
import { encolarCorreo } from '../correo/outbox';
import * as plantillas from '../correo/plantillas';
import { cambiarEstado, crearToken, datosCorreo, obtenerSolicitud, registrarEvento, urlCita } from '../modules/solicitudes/comun';

/**
 * Como los tokens solo se guardan hasheados, los recordatorios llevan un enlace
 * NUEVO a la misma propuesta (el anterior sigue valiendo).
 */
async function enlaceNuevo(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], solicitudId: string, propuestaId: string) {
  const [t] = await tx
    .select({ expiraEn: tokensPublicos.expiraEn })
    .from(tokensPublicos)
    .where(and(eq(tokensPublicos.propuestaId, propuestaId), isNull(tokensPublicos.revocadoEn)))
    .limit(1);
  const token = await crearToken(tx, { proposito: 'ELEGIR_CITA', solicitudId, propuestaId, expiraEn: t?.expiraEn ?? sumarDias(new Date(), env.CITA_TOKEN_TTL_DAYS) });
  return urlCita(token);
}

/** "Si no responde en 3 días, se le envía un recordatorio." Un solo recordatorio por propuesta. */
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
      const huecos = await tx
        .select({ inicio: huecosAgenda.inicio, fin: huecosAgenda.fin })
        .from(propuestaHuecos)
        .innerJoin(huecosAgenda, eq(huecosAgenda.id, propuestaHuecos.huecoId))
        .where(and(eq(propuestaHuecos.propuestaId, id), eq(huecosAgenda.estado, 'LIBRE'), gt(huecosAgenda.inicio, ahora)))
        .orderBy(huecosAgenda.inicio);
      const { s, via } = await obtenerSolicitud(tx, solicitudId);
      await encolarCorreo(tx, {
        plantilla: 'citacion-recordatorio',
        para: s.email,
        correo: plantillas.propuestaCita({
          ...datosCorreo(s, via),
          huecos: huecos.map((h) => ({ dia: diaLargo(h.inicio), franja: franja(h.inicio, h.fin) })),
          enlace: await enlaceNuevo(tx, solicitudId, id),
          recordatorio: true,
        }),
        solicitudId,
      });
      await registrarEvento(tx, solicitudId, { tipo: 'sistema' }, 'RECORDATORIO_CITACION', { detalle: { propuestaId: id } });
      enviados++;
    });
  }
  return enviados;
}

/** Recordatorio "el día antes" a partir de las 10:00 (hora de Madrid). */
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
      await encolarCorreo(tx, {
        plantilla: 'entrevista-recordatorio',
        para: s.email,
        correo: plantillas.recordatorioEntrevista({
          ...datosCorreo(s, via),
          dia: diaLargo(e.inicio),
          franja: franja(e.inicio, e.fin),
          enlace: e.propuestaId ? await enlaceNuevo(tx, s.id, e.propuestaId) : `${env.PUBLIC_APP_URL}`,
          faltanNotas: !notas,
        }),
        solicitudId: s.id,
      });
      await registrarEvento(tx, s.id, { tipo: 'sistema' }, 'RECORDATORIO_ENTREVISTA', { detalle: { entrevistaId: e.id } });
      enviados++;
    });
  }
  return enviados;
}

/** Propuestas cuyas fechas ya pasaron sin respuesta: caducan y la solicitud vuelve a revisión. */
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
      const { s } = await obtenerSolicitud(tx, p.solicitudId, true);
      if (s.estado === 'CITACION_ENVIADA') await cambiarEstado(tx, s, 'EN_REVISION', { tipo: 'sistema' }, 'PROPUESTA_CADUCADA', { propuestaId: p.id });
    });
  }
  if (ps.length) logger.info({ n: ps.length }, 'Propuestas de cita caducadas');
  return ps.length;
}
