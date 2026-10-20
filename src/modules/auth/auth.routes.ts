import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { requireAuth } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { forbidden } from '../../lib/errors';
import * as auth from './auth.service';

export const COOKIE_REFRESH = 'alb_rt';
const COOKIE_PATH = '/api/auth';

export const passwordSegura = z
  .string()
  .min(10, 'Mínimo 10 caracteres.')
  .max(128)
  .regex(/[a-zA-Z]/, 'Debe incluir alguna letra.')
  .regex(/\d/, 'Debe incluir algún número.');

const loginBody = z.object({
  email: z.string().trim().email('Correo no válido.'),
  password: z.string().min(1, 'Introduce la contraseña.').max(128),
});
const cambiarBody = z.object({ actual: z.string().min(1), nueva: passwordSegura });

const ctx = (req: Request): auth.Contexto => ({ ip: req.ip, userAgent: req.get('user-agent') ?? undefined });

function ponerCookie(res: Response, s: auth.Sesion) {
  res.cookie(COOKIE_REFRESH, s.refreshToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: COOKIE_PATH,
    expires: s.refreshExpira,
  });
}
const respuesta = async (s: auth.Sesion) => ({ accessToken: s.accessToken, usuario: await auth.conPermisos(s.usuario) });

/**
 * Las rutas que leen la cookie solo aceptan peticiones desde los orígenes del front.
 * Junto con SameSite, evita que otra web dispare un refresh o un logout (CSRF).
 */
function origenPermitido(req: Request) {
  const origin = req.get('origin');
  if (!origin) return env.NODE_ENV !== 'production'; // herramientas locales (curl, Postman)
  return env.CORS_ORIGINS.includes(origin);
}

const limiteLogin = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'DEMASIADAS_PETICIONES', message: 'Demasiados intentos. Espera unos minutos.' } },
});

export const authRouter = Router();

/** POST /api/auth/login → { accessToken, usuario } + cookie httpOnly con el refresh token */
authRouter.post('/login', limiteLogin, validate({ body: loginBody }), async (req, res) => {
  const { email, password } = v<typeof loginBody>(req, 'body');
  const s = await auth.login(email, password, ctx(req));
  ponerCookie(res, s);
  res.json(await respuesta(s));
});

/** POST /api/auth/refresh → rota el refresh token y devuelve un access token nuevo */
authRouter.post('/refresh', async (req, res) => {
  if (!origenPermitido(req)) throw forbidden('Origen no permitido.');
  try {
    const s = await auth.refrescar(req.cookies?.[COOKIE_REFRESH], ctx(req));
    ponerCookie(res, s);
    res.json(await respuesta(s));
  } catch (e) {
    res.clearCookie(COOKIE_REFRESH, { path: COOKIE_PATH, domain: env.COOKIE_DOMAIN });
    throw e;
  }
});

authRouter.post('/logout', async (req, res) => {
  if (!origenPermitido(req)) throw forbidden('Origen no permitido.');
  await auth.logout(req.cookies?.[COOKIE_REFRESH]);
  res.clearCookie(COOKIE_REFRESH, { path: COOKIE_PATH, domain: env.COOKIE_DOMAIN });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ usuario: await auth.obtenerUsuario(req.user!.id) });
});

authRouter.post('/cambiar-password', requireAuth, validate({ body: cambiarBody }), async (req, res) => {
  const { actual, nueva } = v<typeof cambiarBody>(req, 'body');
  const s = await auth.cambiarPassword(req.user!.id, actual, nueva, ctx(req));
  ponerCookie(res, s);
  res.json(await respuesta(s));
});
