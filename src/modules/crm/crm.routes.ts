import { Router } from 'express';
import { z } from 'zod';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import * as srv from './crm.service';

const idParam = z.object({ id: z.string().uuid() });

/** CRM básico (18/11/2026): interesados antes de la solicitud. Permisos «crm.ver» / «crm.editar». */
export const crmRouter = Router();

/** Listado: GET /interesados?estado=&origen=&asesorId=&q=&vencidas=&page=&pageSize= (con totales por estado). */
crmRouter.get('/', requirePermiso('crm.ver'), validate({ query: srv.listarQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof srv.listarQuery>(req, 'query')));
});

/** Quién puede llevar interesados (antes de /:id). */
crmRouter.get('/asesores', requirePermiso('crm.ver'), async (_req, res) => {
  res.json(await srv.asesores());
});

crmRouter.get('/:id', requirePermiso('crm.ver'), validate({ params: idParam }), async (req, res) => {
  res.json(await srv.detalle(v<typeof idParam>(req, 'params').id));
});

/** Alta (con el correo de bienvenida si hay correo). 409 INTERESADO_DUPLICADO salvo `forzar`. */
crmRouter.post('/', requirePermiso('crm.editar'), validate({ body: srv.crearBody }), async (req, res) => {
  const r = await srv.crear(v<typeof srv.crearBody>(req, 'body'), req.user!.id);
  res.status(201).json({ ...(await srv.detalle(r.id)), bienvenidaEnviada: r.bienvenidaEnviada });
});

/** Datos, cualificación, asesor, próxima acción y estado (perdido con motivo). */
crmRouter.patch('/:id', requirePermiso('crm.editar'), validate({ params: idParam, body: srv.editarBody }), async (req, res) => {
  res.json(await srv.editar(v<typeof idParam>(req, 'params').id, v<typeof srv.editarBody>(req, 'body'), req.user!.id));
});

/** Registrar una llamada (contesta / no contesta) o una nota, con la próxima acción. */
crmRouter.post('/:id/seguimiento', requirePermiso('crm.editar'), validate({ params: idParam, body: srv.seguimientoBody }), async (req, res) => {
  res.json(await srv.seguimiento(v<typeof idParam>(req, 'params').id, v<typeof srv.seguimientoBody>(req, 'body'), req.user!.id));
});
