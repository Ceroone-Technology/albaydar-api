import { Router } from 'express';
import { z } from 'zod';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { agendaConfig, agendaConfigSchema, guardarAgendaConfig } from '../ajustes/ajustes.service';
import * as srv from './agenda.service';

const idParam = z.object({ id: z.string().uuid() });

export const agendaRouter = Router();
const ver = requirePermiso('entrevistas.ver', 'solicitudes.editar');
const editar = requirePermiso('entrevistas.editar');

/**
 * Horas libres para proponer a una familia (panel "Citar a entrevista").
 * GET /api/agenda/disponibilidad?desde=2026-11-02&hasta=2026-11-06&duracion=60
 */
agendaRouter.get('/disponibilidad', ver, validate({ query: srv.rangoQuery }), async (req, res) => {
  const q = v<typeof srv.rangoQuery>(req, 'query');
  res.json(await srv.disponibilidad(q.desde, q.hasta, q.duracion));
});

/** Qué ocupa la agenda: reservas de propuestas, entrevistas y bloqueos. */
agendaRouter.get('/ocupacion', ver, validate({ query: srv.rangoQuery }), async (req, res) => {
  const q = v<typeof srv.rangoQuery>(req, 'query');
  res.json({ items: await srv.ocupacionDetallada(q.desde, q.hasta) });
});

agendaRouter.post('/bloqueos', editar, validate({ body: srv.bloqueoBody }), async (req, res) => {
  res.status(201).json(await srv.crearBloqueo(v<typeof srv.bloqueoBody>(req, 'body'), req.user!.id));
});

agendaRouter.delete('/bloqueos/:id', editar, validate({ params: idParam }), async (req, res) => {
  await srv.quitarBloqueo(v<typeof idParam>(req, 'params').id);
  res.status(204).end();
});

/** Horario de entrevistas (jornada, duraciones, días no lectivos). También lo lee Configuración. */
agendaRouter.get('/configuracion', requirePermiso('entrevistas.ver', 'solicitudes.editar', 'configuracion.ver'), async (_req, res) => {
  res.json(await agendaConfig());
});

agendaRouter.put('/configuracion', requirePermiso('configuracion.editar'), validate({ body: agendaConfigSchema }), async (req, res) => {
  res.json(await guardarAgendaConfig(v<typeof agendaConfigSchema>(req, 'body'), req.user!.id));
});
