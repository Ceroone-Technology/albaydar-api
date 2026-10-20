import { asc, eq, inArray, sql } from 'drizzle-orm';
import { roles, usuarios } from '../../db/schema';
import { db } from '../../lib/db';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { MODULOS, PERMISOS, esPermiso, type Permiso } from './catalogo';

/**
 * Los permisos efectivos se leen de la BD en cada petición (con una caché corta),
 * así que un cambio en la matriz se aplica en segundos sin volver a iniciar sesión.
 */
const CACHE_MS = 10_000;
let cache: { en: number; porRol: Map<string, { superadmin: boolean; permisos: Set<string> }> } | null = null;

async function rolesEnCache() {
  if (cache && Date.now() - cache.en < CACHE_MS) return cache.porRol;
  const filas = await db.select().from(roles);
  cache = { en: Date.now(), porRol: new Map(filas.map((r) => [r.codigo, { superadmin: r.esSuperadmin, permisos: new Set(r.permisos) }])) };
  return cache.porRol;
}
export const invalidarCachePermisos = () => {
  cache = null;
};

export interface Efectivos {
  superadmin: boolean;
  permisos: Permiso[];
}

export async function permisosDe(codigosRol: string[]): Promise<Efectivos> {
  const porRol = await rolesEnCache();
  const asignados = codigosRol.map((c) => porRol.get(c)).filter((x) => !!x);
  if (asignados.some((r) => r.superadmin)) return { superadmin: true, permisos: PERMISOS.map((p) => p.clave) };
  const set = new Set<Permiso>();
  for (const r of asignados) for (const p of r.permisos) if (esPermiso(p)) set.add(p);
  // Quien puede editar un módulo también puede verlo.
  for (const p of [...set]) if (p.endsWith('.editar')) set.add(p.replace('.editar', '.ver') as Permiso);
  return { superadmin: false, permisos: PERMISOS.map((p) => p.clave).filter((p) => set.has(p)) };
}

// ── Gestión de roles (Configuración) ────────────────────────────────────────

export async function listarRoles() {
  const filas = await db.select().from(roles).orderBy(asc(roles.orden));
  const conteo = await db
    .select({ rol: sql<string>`unnest(${usuarios.roles})`, n: sql<number>`count(*)::int` })
    .from(usuarios)
    .where(eq(usuarios.activo, true))
    .groupBy(sql`1`);
  const usuariosPorRol = new Map(conteo.map((c) => [c.rol, c.n]));
  return filas.map((r) => ({
    codigo: r.codigo,
    nombre: r.nombre,
    descripcion: r.descripcion,
    esSuperadmin: r.esSuperadmin,
    permisos: r.esSuperadmin ? PERMISOS.map((p) => p.clave) : r.permisos.filter(esPermiso),
    usuariosActivos: usuariosPorRol.get(r.codigo) ?? 0,
  }));
}

/** Matriz para la pantalla de permisos: filas = módulos, columnas = roles. */
export async function matriz() {
  const rs = await listarRoles();
  return {
    roles: rs.map((r) => ({ codigo: r.codigo, nombre: r.nombre, esSuperadmin: r.esSuperadmin, usuariosActivos: r.usuariosActivos })),
    modulos: MODULOS.map((m) => ({
      id: m.id,
      nombre: m.nombre,
      porRol: Object.fromEntries(rs.map((r) => [r.codigo, { ver: r.permisos.includes(`${m.id}.ver`), editar: r.permisos.includes(`${m.id}.editar`) }])),
    })),
  };
}

export async function actualizarPermisos(codigo: string, permisos: string[]) {
  const invalidos = permisos.filter((p) => !esPermiso(p));
  if (invalidos.length) throw badRequest('PERMISO_DESCONOCIDO', 'Hay permisos que no existen.', { invalidos });
  const [r] = await db.select().from(roles).where(eq(roles.codigo, codigo));
  if (!r) throw notFound('Rol no encontrado.');
  if (r.esSuperadmin) throw conflict('ROL_SUPERADMIN', 'Dirección es superadministrador: siempre tiene todos los permisos.');
  // "editar" implica "ver".
  const set = new Set(permisos);
  for (const p of [...set]) if (p.endsWith('.editar')) set.add(p.replace('.editar', '.ver'));
  const [act] = await db.update(roles).set({ permisos: [...set] }).where(eq(roles.codigo, codigo)).returning();
  invalidarCachePermisos();
  return act!;
}

export async function existenRoles(codigos: string[]) {
  if (!codigos.length) return;
  const filas = await db.select({ codigo: roles.codigo }).from(roles).where(inArray(roles.codigo, codigos));
  const faltan = codigos.filter((c) => !filas.some((f) => f.codigo === c));
  if (faltan.length) throw badRequest('ROL_DESCONOCIDO', `Rol desconocido: ${faltan.join(', ')}.`);
}

export async function codigosSuperadmin() {
  const filas = await db.select({ codigo: roles.codigo }).from(roles).where(eq(roles.esSuperadmin, true));
  return filas.map((f) => f.codigo);
}
