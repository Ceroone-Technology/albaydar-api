import { Router } from 'express';
import { and, arrayContains, asc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { rolEnum, usuarios } from '../../db/schema';
import { db } from '../../lib/db';
import { conflict, notFound } from '../../lib/errors';
import { requireRol } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { passwordSegura } from '../auth/auth.routes';
import { hashPassword, publico, revocarTodas } from '../auth/auth.service';

const idParam = z.object({ id: z.string().uuid() });
const crearBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  nombre: z.string().trim().min(1).max(120),
  roles: z.array(z.enum(rolEnum.enumValues)).min(1),
  password: passwordSegura,
});
const editarBody = z
  .object({
    nombre: z.string().trim().min(1).max(120).optional(),
    roles: z.array(z.enum(rolEnum.enumValues)).min(1).optional(),
    activo: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'Nada que actualizar.');
const resetBody = z.object({ password: passwordSegura });
const listarQuery = z.object({ rol: z.enum(rolEnum.enumValues).optional(), activos: z.enum(['true', 'false']).default('true') });

export const usuariosRouter = Router();

/** Lista para los selectores de responsable (chips de la bandeja). */
usuariosRouter.get('/', validate({ query: listarQuery }), async (req, res) => {
  const q = v<typeof listarQuery>(req, 'query');
  const c: SQL[] = [];
  if (q.activos === 'true') c.push(eq(usuarios.activo, true));
  if (q.rol) c.push(arrayContains(usuarios.roles, [q.rol]));
  const filas = await db.select().from(usuarios).where(and(...c)).orderBy(asc(usuarios.nombre));
  res.json({ items: filas.map((u) => ({ ...publico(u), activo: u.activo, ultimoAcceso: u.ultimoAcceso })) });
});

usuariosRouter.post('/', requireRol('ADMIN'), validate({ body: crearBody }), async (req, res) => {
  const d = v<typeof crearBody>(req, 'body');
  const [existe] = await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, d.email));
  if (existe) throw conflict('EMAIL_EN_USO', 'Ya existe un usuario con ese correo.');
  const [u] = await db.insert(usuarios).values({ email: d.email, nombre: d.nombre, roles: d.roles, passwordHash: await hashPassword(d.password) }).returning();
  res.status(201).json(publico(u!));
});

usuariosRouter.patch('/:id', requireRol('ADMIN'), validate({ params: idParam, body: editarBody }), async (req, res) => {
  const { id } = v<typeof idParam>(req, 'params');
  const d = v<typeof editarBody>(req, 'body');
  const [u] = await db.update(usuarios).set(d).where(eq(usuarios.id, id)).returning();
  if (!u) throw notFound('Usuario no encontrado.');
  if (d.activo === false || d.roles) await revocarTodas(id); // que los cambios de permisos apliquen ya
  res.json({ ...publico(u), activo: u.activo });
});

usuariosRouter.post('/:id/password', requireRol('ADMIN'), validate({ params: idParam, body: resetBody }), async (req, res) => {
  const { id } = v<typeof idParam>(req, 'params');
  const [u] = await db
    .update(usuarios)
    .set({ passwordHash: await hashPassword(v<typeof resetBody>(req, 'body').password), intentosFallidos: 0, bloqueadoHasta: null })
    .where(eq(usuarios.id, id))
    .returning({ id: usuarios.id });
  if (!u) throw notFound('Usuario no encontrado.');
  await revocarTodas(id);
  res.status(204).end();
});
