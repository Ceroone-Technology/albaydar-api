import cron, { type ScheduledTask } from 'node-cron';
import { pool } from '../lib/db';
import { logger } from '../lib/logger';
import { liberarAtascados, procesarOutbox } from '../correo/outbox';
import { recordatoriosPago, vencerReservas } from '../modules/reservas/reservas.service';
import { caducarPropuestas, recordatoriosEntrevista, recordatoriosPropuesta } from './recordatorios';

/**
 * Ejecuta una tarea solo si esta instancia consigue el candado de Postgres.
 * Con varias réplicas de la API, cada tarea corre en una sola a la vez.
 */
async function conCandado(nombre: string, fn: () => Promise<unknown>) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [nombre]);
    if (!rows[0]?.ok) return;
    try {
      await fn();
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [nombre]);
    }
  } catch (err) {
    logger.error({ err, tarea: nombre }, 'Fallo en tarea programada');
  } finally {
    client.release();
  }
}

export function arrancarTareas(): () => void {
  const tareas: ScheduledTask[] = [
    // Cola de correo: cada 15 segundos
    cron.schedule('*/15 * * * * *', () =>
      conCandado('outbox', async () => {
        const r = await procesarOutbox();
        if (r.enviados || r.fallidos) logger.info(r, 'Correos procesados');
      }),
    ),
    // Recordatorios y caducidades: cada 10 minutos
    cron.schedule('*/10 * * * *', () =>
      conCandado('recordatorios', async () => {
        await liberarAtascados();
        await caducarPropuestas();
        const p = await recordatoriosPropuesta();
        const e = await recordatoriosEntrevista();
        await vencerReservas();
        const pagos = await recordatoriosPago();
        if (p || e || pagos) logger.info({ propuestas: p, entrevistas: e, pagos }, 'Recordatorios encolados');
      }),
    ),
  ];
  logger.info('Tareas programadas en marcha');
  return () => tareas.forEach((t) => t.stop());
}

