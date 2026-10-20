import { env } from './config/env';

import { crearApp } from './app';
import { arrancarTareas } from './jobs/scheduler';
import { pool } from './lib/db';
import { logger } from './lib/logger';

// En Docker el contenedor arranca como root para preparar la carpeta de ficheros;
// el servidor se ejecuta siempre como usuario sin privilegios.
if (process.getuid?.() === 0 && process.env.RUN_AS_USER) {
  process.setgid!(process.env.RUN_AS_USER);
  process.setuid!(process.env.RUN_AS_USER);
}

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
