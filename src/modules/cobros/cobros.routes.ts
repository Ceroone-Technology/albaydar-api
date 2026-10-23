import { Router } from 'express';
import { z } from 'zod';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import * as srv from './cobros.service';

const idParam = z.object({ id: z.string().uuid() });

export const cobrosRouter = Router();

/** Pestaña "Pagos". */
cobrosRouter.get('/', requirePermiso('cobros.ver'), validate({ query: srv.listarCobrosQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof srv.listarCobrosQuery>(req, 'query')));
});

/** KPIs: cobrado (en el periodo), pendiente y parcial. */
cobrosRouter.get('/resumen', requirePermiso('cobros.ver'), validate({ query: srv.resumenQuery }), async (req, res) => {
  res.json(await srv.resumen(v<typeof srv.resumenQuery>(req, 'query')));
});

/** Recibo imprimible en HTML (el navegador lo guarda como PDF). */
cobrosRouter.get('/:id/recibo', requirePermiso('cobros.ver'), validate({ params: idParam }), async (req, res) => {
  const r = await srv.recibo(v<typeof idParam>(req, 'params').id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${r.nombre}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  // El recibo solo carga el logo del centro: sin scripts.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https:; style-src 'unsafe-inline'");
  res.send(r.html);
});

/** "Registrar cobro manual". Si cubre la reserva, la solicitud pasa a "Plaza reservada". */
cobrosRouter.post('/', requirePermiso('cobros.editar'), validate({ body: srv.registrarCobroBody }), async (req, res) => {
  res.status(201).json(await srv.registrar(v<typeof srv.registrarCobroBody>(req, 'body'), req.user!.id));
});

/** Anula un cobro con motivo (nunca se borra). */
cobrosRouter.post('/:id/anular', requirePermiso('cobros.editar'), validate({ params: idParam, body: srv.anularCobroBody }), async (req, res) => {
  res.json(await srv.anular(v<typeof idParam>(req, 'params').id, v<typeof srv.anularCobroBody>(req, 'body').motivo, req.user!.id));
});
