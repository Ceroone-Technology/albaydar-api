import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../../config/env';
import { refreshTokens, usuarios, type Usuario } from '../../db/schema';
import { db } from '../../lib/db';
import { AppError, unauthorized } from '../../lib/errors';
import { hashToken, nuevoToken } from '../../lib/crypto';
import { logger } from '../../lib/logger';
import { firmarAccess } from './auth.tokens';

const MAX_INTENTOS = 5;
const BLOQUEO_MIN = 15;
const BCRYPT_COSTE = 12;
// Hash ficticio para que un email inexistente tarde lo mismo que uno real.
const HASH_FICTICIO = bcrypt.hashSync('albaydar-no-existe', BCRYPT_COSTE);

export const hashPassword = (p: string) => bcrypt.hash(p, BCRYPT_COSTE);

export interface Contexto {
  ip?: string;
  userAgent?: string;
}

export interface Sesion {
  accessToken: string;
  refreshToken: string;
  refreshExpira: Date;
  usuario: UsuarioPublico;
}

export type UsuarioPublico = Pick<Usuario, 'id' | 'email' | 'nombre' | 'roles'>;
export const publico = (u: Usuario): UsuarioPublico => ({ id: u.id, email: u.email, nombre: u.nombre, roles: u.roles });

async function emitirSesion(u: Usuario, familia: string, ctx: Contexto): Promise<Sesion & { refreshId: string }> {
  const refreshToken = nuevoToken(48);
  const refreshExpira = new Date(Date.now() + env.REFRESH_TTL_DAYS * 86_400_000);
  const [fila] = await db.insert(refreshTokens).values({
    usuarioId: u.id,
    familia,
    tokenHash: hashToken(refreshToken),
    expiraEn: refreshExpira,
    ip: ctx.ip,
    userAgent: ctx.userAgent?.slice(0, 300),
  }).returning({ id: refreshTokens.id });
  const accessToken = firmarAccess({ sub: u.id, email: u.email, nombre: u.nombre, roles: u.roles });
  return { accessToken, refreshToken, refreshExpira, usuario: publico(u), refreshId: fila!.id };
}

export async function login(email: string, password: string, ctx: Contexto): Promise<Sesion> {
  const correo = email.trim().toLowerCase();
  const [u] = await db.select().from(usuarios).where(eq(usuarios.email, correo)).limit(1);

  if (!u || !u.activo) {
    await bcrypt.compare(password, HASH_FICTICIO);
    throw unauthorized('Correo o contraseña incorrectos.', 'CREDENCIALES_INVALIDAS');
  }
  if (u.bloqueadoHasta && u.bloqueadoHasta > new Date()) {
    throw new AppError(423, 'CUENTA_BLOQUEADA', 'Demasiados intentos. Vuelve a probar en unos minutos.');
  }

  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) {
    const intentos = u.intentosFallidos + 1;
    const bloquear = intentos >= MAX_INTENTOS;
    await db
      .update(usuarios)
      .set({
        intentosFallidos: bloquear ? 0 : intentos,
        bloqueadoHasta: bloquear ? new Date(Date.now() + BLOQUEO_MIN * 60_000) : null,
      })
      .where(eq(usuarios.id, u.id));
    if (bloquear) logger.warn({ usuarioId: u.id, ip: ctx.ip }, 'Cuenta bloqueada por intentos fallidos');
    throw unauthorized('Correo o contraseña incorrectos.', 'CREDENCIALES_INVALIDAS');
  }

  await db
    .update(usuarios)
    .set({ intentosFallidos: 0, bloqueadoHasta: null, ultimoAcceso: new Date() })
    .where(eq(usuarios.id, u.id));

  return emitirSesion(u, randomUUID(), ctx);
}

/**
 * Rotación de refresh token. Si llega un token ya rotado o revocado,
 * se asume robo y se revoca toda la sesión (familia).
 */
export async function refrescar(token: string | undefined, ctx: Contexto): Promise<Sesion> {
  if (!token) throw unauthorized('No hay sesión.', 'SIN_SESION');
  const [rt] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(token))).limit(1);
  if (!rt) throw unauthorized('Sesión no válida.', 'SESION_INVALIDA');

  if (rt.revocadoEn) {
    await revocarFamilia(rt.familia);
    logger.warn({ usuarioId: rt.usuarioId, familia: rt.familia, ip: ctx.ip }, 'Reutilización de refresh token: sesión revocada');
    throw unauthorized('La sesión se ha cerrado por seguridad. Vuelve a iniciar sesión.', 'SESION_REVOCADA');
  }
  if (rt.expiraEn < new Date()) throw unauthorized('La sesión ha caducado.', 'SESION_CADUCADA');

  const [u] = await db.select().from(usuarios).where(eq(usuarios.id, rt.usuarioId)).limit(1);
  if (!u || !u.activo) {
    await revocarFamilia(rt.familia);
    throw unauthorized('Usuario desactivado.', 'USUARIO_INACTIVO');
  }

  // Marcar el actual como usado de forma atómica: si dos peticiones llegan a la vez, solo una gana.
  const marcados = await db
    .update(refreshTokens)
    .set({ revocadoEn: new Date() })
    .where(and(eq(refreshTokens.id, rt.id), isNull(refreshTokens.revocadoEn)))
    .returning({ id: refreshTokens.id });
  if (marcados.length === 0) throw unauthorized('Sesión no válida.', 'SESION_INVALIDA');

  const sesion = await emitirSesion(u, rt.familia, ctx);
  await db.update(refreshTokens).set({ reemplazadoPor: sesion.refreshId }).where(eq(refreshTokens.id, rt.id));
  return sesion;
}

export async function logout(token: string | undefined) {
  if (!token) return;
  const [rt] = await db
    .select({ familia: refreshTokens.familia })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(token)))
    .limit(1);
  if (rt) await revocarFamilia(rt.familia);
}

async function revocarFamilia(familia: string) {
  await db
    .update(refreshTokens)
    .set({ revocadoEn: new Date() })
    .where(and(eq(refreshTokens.familia, familia), isNull(refreshTokens.revocadoEn)));
}

export async function revocarTodas(usuarioId: string) {
  await db
    .update(refreshTokens)
    .set({ revocadoEn: new Date() })
    .where(and(eq(refreshTokens.usuarioId, usuarioId), isNull(refreshTokens.revocadoEn)));
}

export async function cambiarPassword(usuarioId: string, actual: string, nueva: string, ctx: Contexto): Promise<Sesion> {
  const [u] = await db.select().from(usuarios).where(eq(usuarios.id, usuarioId)).limit(1);
  if (!u) throw unauthorized();
  if (!(await bcrypt.compare(actual, u.passwordHash))) {
    throw new AppError(400, 'PASSWORD_ACTUAL_INCORRECTA', 'La contraseña actual no es correcta.');
  }
  const [actualizado] = await db
    .update(usuarios)
    .set({ passwordHash: await hashPassword(nueva) })
    .where(eq(usuarios.id, usuarioId))
    .returning();
  // Cierra el resto de sesiones abiertas y entrega una nueva para este dispositivo.
  await revocarTodas(usuarioId);
  return emitirSesion(actualizado!, randomUUID(), ctx);
}

export async function obtenerUsuario(id: string): Promise<UsuarioPublico> {
  const [u] = await db.select().from(usuarios).where(eq(usuarios.id, id)).limit(1);
  if (!u || !u.activo) throw unauthorized();
  return publico(u);
}
