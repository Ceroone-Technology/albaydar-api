import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { sql } from 'drizzle-orm';
import { env } from './config/env';
import { db } from './lib/db';
import { logger } from './lib/logger';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { agendaRouter } from './modules/agenda/agenda.routes';
import { authRouter } from './modules/auth/auth.routes';
import { catalogoRouter } from './modules/catalogo/catalogo.routes';
import { comunicacionesRouter } from './modules/comunicaciones/comunicaciones.routes';
import { rolesRouter } from './modules/permisos/permisos.routes';
import { entrevistasRouter } from './modules/entrevistas/entrevistas.routes';
import { publicoRouter } from './modules/publico/publico.routes';
import { solicitudesRouter } from './modules/solicitudes/solicitudes.routes';
import { usuariosRouter } from './modules/usuarios/usuarios.routes';

export function crearApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true, // para la cookie del refresh token
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  app.get('/health', async (_req, res) => {
    await db.execute(sql`select 1`);
    res.json({ ok: true });
  });

  const api = Router();
  api.use('/auth', authRouter);
  api.use('/public', publicoRouter);

  // Todo lo demás requiere sesión.
  const privado = Router();
  privado.use(requireAuth);
  privado.use('/solicitudes', solicitudesRouter);
  privado.use('/agenda', agendaRouter);
  privado.use('/entrevistas', entrevistasRouter);
  privado.use('/usuarios', usuariosRouter);
  privado.use('/roles', rolesRouter);
  privado.use('/comunicaciones', comunicacionesRouter);
  privado.use('/catalogo', catalogoRouter);
  api.use(privado);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
