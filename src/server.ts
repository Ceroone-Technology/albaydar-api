import { env } from './config/env';
import { crearApp } from './app';
import { arrancarTareas } from './jobs/scheduler';
import { pool } from './lib/db';
import { logger } from './lib/logger';

const app = crearApp();
const server = app.listen(env.PORT, () => logger.info(`API de Albaydar escuchando en http://localhost:${env.PORT}`));
const pararTareas = env.WORKERS_ENABLED ? arrancarTareas() : () => undefined;

async function apagar(senal: string) {
  logger.info(`${senal} recibido: cerrando…`);
  pararTareas();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void apagar('SIGTERM'));
process.on('SIGINT', () => void apagar('SIGINT'));
