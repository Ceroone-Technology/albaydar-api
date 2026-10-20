import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../lib/db';

async function main() {
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
