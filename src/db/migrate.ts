import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../lib/db';

/** Espera a que PostgreSQL acepte conexiones (útil al arrancar con Docker). */
async function esperarBaseDeDatos(intentos = 30, esperaMs = 2000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (e) {
      if (i === intentos) throw e;
      // eslint-disable-next-line no-console
      console.log(`Esperando a la base de datos (${i}/${intentos})…`);
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
}

async function main() {
  await esperarBaseDeDatos();
  await migrate(db, { migrationsFolder: './drizzle' });
  // eslint-disable-next-line no-console
  console.log('Migraciones aplicadas.');
  await pool.end();
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  await pool.end();
  process.exit(1);
});
