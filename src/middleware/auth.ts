import type { NextFunction, Request, Response } from 'express';
import type { Rol } from '../db/schema';
import { forbidden, unauthorized } from '../lib/errors';
import { verificarAccess } from '../modules/auth/auth.tokens';

/**
 * Exige `Authorization: Bearer <accessToken>`.
 * El access token vive en memoria en el front (no en localStorage);
 * el refresh token va en cookie httpOnly.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(unauthorized());
  try {
    const p = verificarAccess(h.slice(7));
    req.user = { id: p.sub, email: p.email, nombre: p.nombre, roles: p.roles };
    next();
  } catch (e) {
    const expirado = (e as Error).name === 'TokenExpiredError';
    next(unauthorized(expirado ? 'La sesión ha caducado.' : 'Sesión no válida.', expirado ? 'TOKEN_CADUCADO' : 'TOKEN_INVALIDO'));
  }
}

/** Permite el paso si el usuario tiene AL MENOS uno de los roles. ADMIN siempre pasa. */
export const requireRol =
  (...roles: Rol[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const r = req.user?.roles ?? [];
    if (r.includes('ADMIN') || roles.some((x) => r.includes(x))) return next();
    next(forbidden());
  };
