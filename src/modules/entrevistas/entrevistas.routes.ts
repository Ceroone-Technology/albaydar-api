import { Router } from 'express';
import { z } from 'zod';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import * as srv from './entrevistas.service';

const idParam = z.object({ id: z.string().uuid() });

export const entrevistasRouter = Router();
const ver = requirePermiso('entrevistas.ver');
const gestion = requirePermiso('entrevistas.editar');

/** Calendario semanal y lista: GET /api/entrevistas?desde=…&hasta=…&familiaVia=BACHILLERATO&q=… */
entrevistasRouter.get('/', ver, validate({ query: srv.listarEntrevistasQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof srv.listarEntrevistasQuery>(req, 'query')));
});

/** Marcar realizada / no presentada y notas de la entrevista. */
entrevistasRouter.patch('/:id', gestion, validate({ params: idParam, body: srv.actualizarEntrevistaBody }), async (req, res) => {
  res.json(await srv.actualizar(v<typeof idParam>(req, 'params').id, v<typeof srv.actualizarEntrevistaBody>(req, 'body'), req.user!.id));
});

entrevistasRouter.post('/:id/cancelar', gestion, validate({ params: idParam, body: srv.cancelarBody }), async (req, res) => {
  res.json(await srv.cancelar(v<typeof idParam>(req, 'params').id, v<typeof srv.cancelarBody>(req, 'body'), req.user!.id));
});
