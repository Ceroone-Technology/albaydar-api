import { Router } from 'express';
import { z } from 'zod';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { MODULOS, PERMISOS } from './catalogo';
import * as srv from './permisos.service';

const codigoParam = z.object({ codigo: z.string().trim().toUpperCase() });
const permisosBody = z.object({ permisos: z.array(z.string()) });
const celdaBody = z.object({ modulo: z.enum(MODULOS.map((m) => m.id) as [string, ...string[]]), ver: z.boolean(), editar: z.boolean() });

export const rolesRouter = Router();

/** Catálogo de módulos y permisos (para pintar la matriz). */
rolesRouter.get('/permisos', requirePermiso('configuracion.ver'), (_req, res) => {
  res.json({ modulos: MODULOS, permisos: PERMISOS });
});

rolesRouter.get('/', requirePermiso('configuracion.ver'), async (_req, res) => {
  res.json({ items: await srv.listarRoles() });
});

/** Matriz módulos × roles con ver/editar. */
rolesRouter.get('/matriz', requirePermiso('configuracion.ver'), async (_req, res) => {
  res.json(await srv.matriz());
});

/** Sustituye todos los permisos de un rol. */
rolesRouter.put('/:codigo/permisos', requirePermiso('configuracion.editar'), validate({ params: codigoParam, body: permisosBody }), async (req, res) => {
  const { codigo } = v<typeof codigoParam>(req, 'params');
  await srv.actualizarPermisos(codigo, v<typeof permisosBody>(req, 'body').permisos);
  res.json(await srv.matriz());
});

/** Cambia una celda de la matriz (un módulo de un rol): lo que hace un clic en la tabla. */
rolesRouter.patch('/:codigo/modulos', requirePermiso('configuracion.editar'), validate({ params: codigoParam, body: celdaBody }), async (req, res) => {
  const { codigo } = v<typeof codigoParam>(req, 'params');
  const c = v<typeof celdaBody>(req, 'body');
  const rol = (await srv.listarRoles()).find((r) => r.codigo === codigo);
  const actuales = new Set<string>(rol?.permisos ?? []);
  actuales.delete(`${c.modulo}.ver`);
  actuales.delete(`${c.modulo}.editar`);
  if (c.ver || c.editar) actuales.add(`${c.modulo}.ver`);
  if (c.editar) actuales.add(`${c.modulo}.editar`);
  await srv.actualizarPermisos(codigo, [...actuales]);
  res.json(await srv.matriz());
});
