import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors';
import { verificarAccess } from '../modules/auth/auth.tokens';
import type { Permiso } from '../modules/permisos/catalogo';
import { permisosDe } from '../modules/permisos/permisos.service';

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

/**
 * Exige un permiso de la matriz (p. ej. "solicitudes.editar").
 * Los permisos se leen de la BD, así que un cambio en la matriz aplica enseguida.
 * Con varios, basta con tener uno.
 */
export const requirePermiso =
  (...permisos: Permiso[]) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const ef = await permisosDe(req.user?.roles ?? []);
      if (ef.superadmin || permisos.some((p) => ef.permisos.includes(p))) return next();
      next(forbidden());
    } catch (e) {
      next(e);
    }
  };
