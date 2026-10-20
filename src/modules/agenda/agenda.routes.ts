import { Router } from 'express';
import { z } from 'zod';
import { requireRol } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import * as srv from './agenda.service';

const idParam = z.object({ id: z.string().uuid() });

export const agendaRouter = Router();
const gestion = requireRol('SECRETARIA', 'DIRECCION');

/** GET /api/agenda/huecos?desde=2026-08-31&hasta=2026-09-04 */
agendaRouter.get('/huecos', validate({ query: srv.rangoQuery }), async (req, res) => {
  const q = v<typeof srv.rangoQuery>(req, 'query');
  res.json({ items: await srv.listarHuecos(q.desde, q.hasta) });
});

agendaRouter.post('/huecos', gestion, validate({ body: srv.crearHuecoBody }), async (req, res) => {
  res.status(201).json(await srv.crearHueco(v<typeof srv.crearHuecoBody>(req, 'body'), req.user!.id));
});

/** Genera huecos para varias semanas (por defecto L–V a las 09:00, 10:00, 12:30 y 17:00). */
agendaRouter.post('/huecos/generar', gestion, validate({ body: srv.generarBody }), async (req, res) => {
  res.status(201).json(await srv.generarHuecos(v<typeof srv.generarBody>(req, 'body'), req.user!.id));
});

agendaRouter.patch('/huecos/:id', gestion, validate({ params: idParam, body: srv.estadoHuecoBody }), async (req, res) => {
  res.json(await srv.cambiarEstadoHueco(v<typeof idParam>(req, 'params').id, v<typeof srv.estadoHuecoBody>(req, 'body').estado));
});

agendaRouter.delete('/huecos/:id', gestion, validate({ params: idParam }), async (req, res) => {
  await srv.eliminarHueco(v<typeof idParam>(req, 'params').id);
  res.status(204).end();
});
