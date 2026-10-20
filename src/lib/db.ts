import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import * as schema from '../db/schema';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

export type Db = NodePgDatabase<typeof schema>;
/** Transacción o conexión normal: los servicios aceptan cualquiera de las dos. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;
