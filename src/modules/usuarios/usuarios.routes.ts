import { Router } from 'express';
import { and, arrayContains, arrayOverlaps, asc, eq, ilike, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { usuarios, type Usuario } from '../../db/schema';
import { db } from '../../lib/db';
import { badRequest, codigoPg, conflict, notFound } from '../../lib/errors';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { passwordSegura } from '../auth/auth.routes';
import { hashPassword, publico, revocarTodas } from '../auth/auth.service';
import { codigosSuperadmin, existenRoles } from '../permisos/permisos.service';

const idParam = z.object({ id: z.string().uuid() });
const rolesSchema = z.array(z.string().trim().toUpperCase().min(1)).min(1, 'Asigna al menos un rol.');
const crearBody = z.object({
  email: z.string().trim().toLowerCase().email('Correo no válido.'),
  nombre: z.string().trim().min(1).max(120),
  roles: rolesSchema,
  password: passwordSegura,
});
const editarBody = z
  .object({
    email: z.string().trim().toLowerCase().email('Correo no válido.').optional(),
    nombre: z.string().trim().min(1).max(120).optional(),
    roles: rolesSchema.optional(),
    activo: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'Nada que actualizar.');
const resetBody = z.object({ password: passwordSegura });
const listarQuery = z.object({
  rol: z.string().trim().toUpperCase().optional(),
  q: z.string().trim().max(100).optional(),
  estado: z.enum(['activos', 'inactivos', 'todos']).default('activos'),
});

const vista = (u: Usuario) => ({ ...publico(u), activo: u.activo, ultimoAcceso: u.ultimoAcceso, creadoEn: u.createdAt });

/** Impide quedarse sin ningún superadministrador activo (y bloqueado fuera del sistema). */
async function comprobarQuedaSuperadmin(excluirId: string) {
  const sa = await codigosSuperadmin();
  const otros = await db
    .select({ id: usuarios.id })
    .from(usuarios)
    .where(and(eq(usuarios.activo, true), ne(usuarios.id, excluirId), arrayOverlaps(usuarios.roles, sa)))
    .limit(1);
  if (!otros.length) throw conflict('ULTIMO_SUPERADMIN', 'Debe quedar al menos un usuario activo de Dirección (superadministrador).');
}

export const usuariosRouter = Router();
const verConfig = requirePermiso('configuracion.ver');
const editarConfig = requirePermiso('configuracion.editar');

/** Selector de responsable en la bandeja (lo necesita quien gestiona solicitudes). */
usuariosRouter.get('/responsables', requirePermiso('solicitudes.ver'), async (_req, res) => {
  const filas = await db.select().from(usuarios).where(eq(usuarios.activo, true)).orderBy(asc(usuarios.nombre));
  res.json({ items: filas.map((u) => ({ id: u.id, nombre: u.nombre, roles: u.roles })) });
});

usuariosRouter.get('/', verConfig, validate({ query: listarQuery }), async (req, res) => {
  const q = v<typeof listarQuery>(req, 'query');
  const c: SQL[] = [];
  if (q.estado !== 'todos') c.push(eq(usuarios.activo, q.estado === 'activos'));
  if (q.rol) c.push(arrayContains(usuarios.roles, [q.rol]));
  if (q.q) c.push(or(ilike(usuarios.nombre, `%${q.q}%`), ilike(usuarios.email, `%${q.q}%`))!);
  const filas = await db.select().from(usuarios).where(and(...c)).orderBy(asc(usuarios.nombre));
  res.json({ items: filas.map(vista) });
});

usuariosRouter.get('/:id', verConfig, validate({ params: idParam }), async (req, res) => {
  const [u] = await db.select().from(usuarios).where(eq(usuarios.id, v<typeof idParam>(req, 'params').id));
  if (!u) throw notFound('Usuario no encontrado.');
  res.json(vista(u));
});

/** Registrar usuario con sus roles. */
usuariosRouter.post('/', editarConfig, validate({ body: crearBody }), async (req, res) => {
  const d = v<typeof crearBody>(req, 'body');
  await existenRoles(d.roles);
  const [existe] = await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, d.email));
  if (existe) throw conflict('EMAIL_EN_USO', 'Ya existe un usuario con ese correo.');
  const [u] = await db.insert(usuarios).values({ email: d.email, nombre: d.nombre, roles: [...new Set(d.roles)], passwordHash: await hashPassword(d.password) }).returning();
  res.status(201).json(vista(u!));
});

usuariosRouter.patch('/:id', editarConfig, validate({ params: idParam, body: editarBody }), async (req, res) => {
  const { id } = v<typeof idParam>(req, 'params');
  const d = v<typeof editarBody>(req, 'body');
  const [actual] = await db.select().from(usuarios).where(eq(usuarios.id, id));
  if (!actual) throw notFound('Usuario no encontrado.');
  if (d.roles) await existenRoles(d.roles);
  if (d.email && d.email !== actual.email) {
    const [otro] = await db.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.email, d.email));
    if (otro) throw conflict('EMAIL_EN_USO', 'Ya existe un usuario con ese correo.');
  }
  const sa = await codigosSuperadmin();
  const eraSuper = actual.activo && actual.roles.some((r) => sa.includes(r));
  const seguiraSuper = (d.activo ?? actual.activo) && (d.roles ?? actual.roles).some((r) => sa.includes(r));
  if (eraSuper && !seguiraSuper) await comprobarQuedaSuperadmin(id);
  if (d.activo === false && id === req.user!.id) throw badRequest('NO_AUTODESACTIVAR', 'No puedes desactivar tu propio usuario.');

  const [u] = await db.update(usuarios).set({ ...d, ...(d.roles ? { roles: [...new Set(d.roles)] } : {}) }).where(eq(usuarios.id, id)).returning();
  // Cambios de permisos o desactivación: cerrar sus sesiones para que apliquen ya.
  if (d.activo === false || d.roles || d.email) await revocarTodas(id);
  res.json(vista(u!));
});

/** Restablecer contraseña (la comunica Dirección al usuario). */
usuariosRouter.post('/:id/password', editarConfig, validate({ params: idParam, body: resetBody }), async (req, res) => {
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

/**
 * Eliminar: si el usuario no tiene actividad se borra; si ya figura en el historial
 * (solicitudes, citas, plantillas…) se desactiva para no perder la trazabilidad.
 */
usuariosRouter.delete('/:id', editarConfig, validate({ params: idParam }), async (req, res) => {
  const { id } = v<typeof idParam>(req, 'params');
  if (id === req.user!.id) throw badRequest('NO_AUTOELIMINAR', 'No puedes eliminar tu propio usuario.');
  const [u] = await db.select().from(usuarios).where(eq(usuarios.id, id));
  if (!u) throw notFound('Usuario no encontrado.');
  const sa = await codigosSuperadmin();
  if (u.activo && u.roles.some((r) => sa.includes(r))) await comprobarQuedaSuperadmin(id);
  try {
    await db.delete(usuarios).where(eq(usuarios.id, id));
    res.json({ eliminado: true, desactivado: false });
  } catch (e) {
    if (codigoPg(e) !== '23503') throw e;
    await db.update(usuarios).set({ activo: false }).where(eq(usuarios.id, id));
    await revocarTodas(id);
    res.json({ eliminado: false, desactivado: true, motivo: 'El usuario tiene actividad registrada: se ha desactivado para conservar el historial.' });
  }
});
