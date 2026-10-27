import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermiso } from '../../middleware/auth';
import { forbidden } from '../../lib/errors';
import type { Permiso } from '../permisos/catalogo';
import { permisosDe } from '../permisos/permisos.service';
import { v, validate } from '../../middleware/validate';
import * as citacion from '../citacion/citacion.service';
import * as documentosSrv from '../documentos/documentos.service';
import { decidir, decisionBody, previaDecisionBody, previsualizar } from '../evaluacion/evaluacion.service';
import { DECISIONES_ADMISION } from './dominio';
import * as srv from './solicitudes.service';
import {
  cambiarEstadoBody,
  gestionBody,
  idParam,
  listarQuery,
  pedirCompletarBody,
  pipelineQuery,
  respuestasVistasBody,
  solicitudInternaBody,
} from './solicitudes.schemas';

const citarBody = z.object({
  /** Horas de inicio elegidas en la disponibilidad (ISO 8601). */
  inicios: z.array(z.iso.datetime({ offset: true, error: 'Fecha y hora no válidas.' })).min(1, 'Selecciona al menos una fecha.').max(3, 'Máximo 3 fechas.'),
  /** 45 o 60 minutos (según la configuración de la agenda). */
  duracion: z.number().int().optional(),
  mensaje: z.string().trim().max(1000).optional().nullable(),
});

export const solicitudesRouter = Router();
const ver = requirePermiso('solicitudes.ver');
const gestion = requirePermiso('solicitudes.editar');

/** Qué puede hacer el usuario: decide las transiciones que se ofrecen en cada tarjeta (`siguientes`). */
async function permisos(req: Request): Promise<srv.Permisos> {
  const ef = await permisosDe(req.user!.roles);
  const tiene = (p: Permiso) => ef.superadmin || ef.permisos.includes(p);
  return { editar: tiene('solicitudes.editar'), evaluar: tiene('evaluacion.editar'), cobrar: tiene('cobros.editar') };
}

/** Lista con filtros. ?vista=bandeja para la bandeja de admisión; ?columna=… para paginar el kanban. */
solicitudesRouter.get('/', ver, validate({ query: listarQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof listarQuery>(req, 'query'), await permisos(req)));
});

/** Kanban: totales y primeras tarjetas por columna. */
solicitudesRouter.get('/pipeline', ver, validate({ query: pipelineQuery }), async (req, res) => {
  res.json(await srv.pipeline(v<typeof pipelineQuery>(req, 'query'), await permisos(req)));
});

solicitudesRouter.get('/contadores', ver, async (_req, res) => {
  res.json(await srv.contadores());
});

/** Aviso "la familia ya eligió fecha": respuestas que este usuario aún no ha visto. */
solicitudesRouter.get('/respuestas-familia', ver, async (req, res) => {
  res.json(await srv.respuestasFamilia(req.user!.id));
});

solicitudesRouter.post('/respuestas-familia/visto', ver, validate({ body: respuestasVistasBody }), async (req, res) => {
  await srv.marcarRespuestasVistas(req.user!.id, v<typeof respuestasVistasBody>(req, 'body').eventoIds);
  res.status(204).end();
});

/** Alta interna: teléfono, presencial, puertas abiertas o asignada por la Junta. */
solicitudesRouter.post('/', gestion, validate({ body: solicitudInternaBody }), async (req, res) => {
  res.status(201).json(await srv.crearInterna(v<typeof solicitudInternaBody>(req, 'body'), req.user!.id));
});

solicitudesRouter.get('/:id', ver, validate({ params: idParam }), async (req, res) => {
  res.json(await srv.detalle(v<typeof idParam>(req, 'params').id, await permisos(req)));
});

/** Responsable, observaciones internas, origen. */
solicitudesRouter.patch('/:id', gestion, validate({ params: idParam, body: gestionBody }), async (req, res) => {
  res.json(await srv.actualizarGestion(v<typeof idParam>(req, 'params').id, v<typeof gestionBody>(req, 'body'), req.user!.id));
});

/** Ejecuta y guarda las cinco comprobaciones. */
solicitudesRouter.post('/:id/revisar', gestion, validate({ params: idParam }), async (req, res) => {
  res.json(await srv.revisar(v<typeof idParam>(req, 'params').id, req.user!.id));
});

/** "Pedir que complete" / "Reenviar aviso". */
solicitudesRouter.post('/:id/pedir-completar', gestion, validate({ params: idParam, body: pedirCompletarBody }), async (req, res) => {
  res.json(await srv.pedirQueComplete(v<typeof idParam>(req, 'params').id, v<typeof pedirCompletarBody>(req, 'body'), req.user!.id));
});

/** "Citar a entrevista": propone de 1 a 3 huecos y envía el enlace a la familia. */
solicitudesRouter.post('/:id/citar', gestion, validate({ params: idParam, body: citarBody }), async (req, res) => {
  const b = v<typeof citarBody>(req, 'body');
  res.status(201).json(await citacion.proponer(v<typeof idParam>(req, 'params').id, { inicios: b.inicios, duracion: b.duracion, mensaje: b.mensaje }, req.user!.id));
});

/** «¿Ya tuvo entrevista? Sí»: registra la entrevista hecha fuera de la plataforma y pasa a decisión. */
solicitudesRouter.post('/:id/entrevista-previa', gestion, validate({ params: idParam, body: citacion.entrevistaPreviaBody }), async (req, res) => {
  res.status(201).json(await citacion.registrarEntrevistaPrevia(v<typeof idParam>(req, 'params').id, v<typeof citacion.entrevistaPreviaBody>(req, 'body'), req.user!.id));
});

/** Vista previa del correo de la decisión con los datos reales de la familia. No cambia nada. */
solicitudesRouter.post('/:id/decision/previsualizar', requirePermiso('evaluacion.ver'), validate({ params: idParam, body: previaDecisionBody }), async (req, res) => {
  res.json(await previsualizar(v<typeof idParam>(req, 'params').id, v<typeof previaDecisionBody>(req, 'body')));
});

/** "Registrar decisión y notificar": Admitida (crea la reserva), En espera o No admitida. */
solicitudesRouter.post('/:id/decision', requirePermiso('evaluacion.editar'), validate({ params: idParam, body: decisionBody }), async (req, res) => {
  res.json(await decidir(v<typeof idParam>(req, 'params').id, v<typeof decisionBody>(req, 'body'), req.user!.id));
});

/** Mover de columna. Si el destino requiere una acción (citar, decidir, cobrar…), responde 409 ACCION_REQUERIDA. */
solicitudesRouter.patch('/:id/estado', gestion, validate({ params: idParam, body: cambiarEstadoBody }), async (req, res) => {
  if (DECISIONES_ADMISION.includes(v<typeof cambiarEstadoBody>(req, 'body').estado) && !(await permisos(req)).evaluar) {
    throw forbidden('Registrar la decisión de admisión requiere el permiso de Evaluación.');
  }
  res.json(await srv.cambiarEstadoManual(v<typeof idParam>(req, 'params').id, v<typeof cambiarEstadoBody>(req, 'body'), req.user!.id));
});

const docParams = z.object({ id: z.string().uuid(), docId: z.string().uuid() });
solicitudesRouter.get('/:id/documentos/:docId', ver, validate({ params: docParams }), async (req, res) => {
  const p = v<typeof docParams>(req, 'params');
  const { doc, datos } = await documentosSrv.descargar(p.id, p.docId);
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.nombreOriginal)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(datos);
});
