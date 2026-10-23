import { Router } from 'express';
import { z } from 'zod';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { guardarReservaConfig, reservaConfig, reservaConfigSchema } from '../ajustes/ajustes.service';
import * as srv from './reservas.service';

const idParam = z.object({ id: z.string().uuid() });

export const reservasRouter = Router();

/**
 * "Control de reservas" (Evaluación y reserva) y "Reservas por vencer" (Cobros › Por hacer).
 * GET /api/reservas?estado=PENDIENTE&porVencer=true
 */
reservasRouter.get('/', requirePermiso('cobros.ver', 'evaluacion.ver'), validate({ query: srv.listarReservasQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof srv.listarReservasQuery>(req, 'query')));
});

/** Botón "Recordar": envía ya el recordatorio de pago a la familia. */
reservasRouter.post('/:id/recordar', requirePermiso('cobros.editar', 'solicitudes.editar'), validate({ params: idParam }), async (req, res) => {
  res.json(await srv.recordar(v<typeof idParam>(req, 'params').id, req.user!.id));
});

/** Importe (en céntimos), IBAN, titular, plazo y formas de pago. */
reservasRouter.get('/configuracion', requirePermiso('configuracion.ver', 'cobros.ver', 'evaluacion.ver'), async (_req, res) => {
  res.json(await reservaConfig());
});

reservasRouter.put('/configuracion', requirePermiso('configuracion.editar'), validate({ body: reservaConfigSchema }), async (req, res) => {
  res.json(await guardarReservaConfig(v<typeof reservaConfigSchema>(req, 'body'), req.user!.id));
});
