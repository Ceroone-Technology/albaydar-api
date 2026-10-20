import { Router } from 'express';
import { z } from 'zod';
import { requireRol } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import * as citacion from '../citacion/citacion.service';
import * as documentosSrv from '../documentos/documentos.service';
import * as srv from './solicitudes.service';
import {
  cambiarEstadoBody,
  gestionBody,
  idParam,
  listarQuery,
  pedirCompletarBody,
  pipelineQuery,
  solicitudInternaBody,
} from './solicitudes.schemas';

const citarBody = z.object({
  huecoIds: z.array(z.string().uuid()).min(1, 'Selecciona al menos un hueco.').max(3, 'Máximo 3 huecos.'),
  mensaje: z.string().trim().max(1000).optional().nullable(),
});

export const solicitudesRouter = Router();
const gestion = requireRol('SECRETARIA', 'DIRECCION');

/** Lista con filtros. ?vista=bandeja para la bandeja de admisión; ?columna=… para paginar el kanban. */
solicitudesRouter.get('/', validate({ query: listarQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof listarQuery>(req, 'query')));
});

/** Kanban: totales y primeras tarjetas por columna. */
solicitudesRouter.get('/pipeline', validate({ query: pipelineQuery }), async (req, res) => {
  res.json(await srv.pipeline(v<typeof pipelineQuery>(req, 'query')));
});

solicitudesRouter.get('/contadores', async (_req, res) => {
  res.json(await srv.contadores());
});

/** Alta interna: teléfono, presencial, puertas abiertas o asignada por la Junta. */
solicitudesRouter.post('/', gestion, validate({ body: solicitudInternaBody }), async (req, res) => {
  res.status(201).json(await srv.crearInterna(v<typeof solicitudInternaBody>(req, 'body'), req.user!.id));
});

solicitudesRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  res.json(await srv.detalle(v<typeof idParam>(req, 'params').id));
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
  res.status(201).json(await citacion.proponer(v<typeof idParam>(req, 'params').id, b.huecoIds, b.mensaje, req.user!.id));
});

/** Mover de columna / decisión. Si el destino requiere una acción, responde 409 ACCION_REQUERIDA. */
solicitudesRouter.patch('/:id/estado', gestion, validate({ params: idParam, body: cambiarEstadoBody }), async (req, res) => {
  res.json(await srv.cambiarEstadoManual(v<typeof idParam>(req, 'params').id, v<typeof cambiarEstadoBody>(req, 'body'), req.user!.id));
});

const docParams = z.object({ id: z.string().uuid(), docId: z.string().uuid() });
solicitudesRouter.get('/:id/documentos/:docId', validate({ params: docParams }), async (req, res) => {
  const p = v<typeof docParams>(req, 'params');
  const { doc, datos } = await documentosSrv.descargar(p.id, p.docId);
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.nombreOriginal)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(datos);
});
