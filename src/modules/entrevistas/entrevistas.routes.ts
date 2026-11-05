import { Router } from 'express';
import { z } from 'zod';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import * as srv from './entrevistas.service';
import { MAX_FILAS_EXPORTACION } from '../../lib/csv';
import { COLUMNAS_ENTREVISTAS } from '../exportaciones/columnas';
import { responderCsv } from '../exportaciones/exportar';

const idParam = z.object({ id: z.string().uuid() });

export const entrevistasRouter = Router();
const ver = requirePermiso('entrevistas.ver');
const gestion = requirePermiso('entrevistas.editar');

/** Calendario semanal y lista: GET /api/entrevistas?desde=…&hasta=…&familiaVia=BACHILLERATO&q=… */
entrevistasRouter.get('/', ver, validate({ query: srv.listarEntrevistasQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof srv.listarEntrevistasQuery>(req, 'query')));
});

/** CSV de las entrevistas del periodo, con su ficha: GET /entrevistas/exportar?desde&hasta… (sin las fechas sin confirmar). */
entrevistasRouter.get('/exportar', ver, validate({ query: srv.listarEntrevistasQuery }), async (req, res) => {
  const q = v<typeof srv.listarEntrevistasQuery>(req, 'query');
  const { items } = await srv.listar({ ...q, incluirPendientes: false });
  responderCsv(req, res, 'entrevistas', COLUMNAS_ENTREVISTAS, items.slice(0, MAX_FILAS_EXPORTACION));
});

/** Marcar realizada / no presentada y notas de la entrevista. */
entrevistasRouter.patch('/:id', gestion, validate({ params: idParam, body: srv.actualizarEntrevistaBody }), async (req, res) => {
  res.json(await srv.actualizar(v<typeof idParam>(req, 'params').id, v<typeof srv.actualizarEntrevistaBody>(req, 'body'), req.user!.id));
});

entrevistasRouter.post('/:id/cancelar', gestion, validate({ params: idParam, body: srv.cancelarBody }), async (req, res) => {
  res.json(await srv.cancelar(v<typeof idParam>(req, 'params').id, v<typeof srv.cancelarBody>(req, 'body'), req.user!.id));
});
