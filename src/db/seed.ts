/**
 * Datos iniciales: administrador, equipo de secretaría/dirección del mockup,
 * las vías del curso que viene y las solicitudes de ejemplo de la bandeja.
 * Es idempotente: se puede ejecutar varias veces.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { env } from '../config/env';
import { db, pool } from '../lib/db';
import { hashPassword } from '../modules/auth/auth.service';
import { familias, solicitudes, usuarios, vias, type Rol } from './schema';
import { siguienteCodigo, registrarEvento } from '../modules/solicitudes/comun';

const CURSO_ESCOLAR = process.env.SEED_CURSO_ESCOLAR ?? '2027-2028';

async function usuario(email: string, nombre: string, roles: Rol[], password: string) {
  const [u] = await db.select().from(usuarios).where(eq(usuarios.email, email));
  if (u) return u;
  const [n] = await db.insert(usuarios).values({ email, nombre, roles, passwordHash: await hashPassword(password) }).returning();
  console.log(`  usuario ${email} (${roles.join(', ')})`);
  return n!;
}

async function main() {
  console.log('Sembrando datos…');
  const adminPass = process.env.SEED_ADMIN_PASSWORD ?? 'CambiaEsto-2026!';
  await usuario(process.env.SEED_ADMIN_EMAIL ?? 'admin@albaydar.org', 'Administración del sistema', ['ADMIN'], adminPass);

  // En producción solo se crea el administrador, salvo que se pida explícitamente la demo
  // (SEED_DEMO=true, lo usa el docker compose local).
  if (env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') {
    console.log('Producción: solo se crea el administrador.');
    return;
  }

  // Responsables que aparecen en los chips de la bandeja del mockup.
  const demoPass = 'Albaydar-2026';
  const maria = await usuario('maria.reyes@albaydar.org', 'María Reyes', ['SECRETARIA'], demoPass);
  await usuario('juan.diaz@albaydar.org', 'Juan Díaz', ['SECRETARIA'], demoPass);
  await usuario('dolores.ruiz@albaydar.org', 'Dolores Ruiz', ['SECRETARIA'], demoPass);
  await usuario('direccion@albaydar.org', 'Equipo directivo', ['DIRECCION'], demoPass);
  await usuario('administracion@albaydar.org', 'Administración', ['ADMINISTRACION'], demoPass);

  // Vías: plazas de ejemplo para que la comprobación devuelva los textos del mockup
  // ("6 plazas libres", "3 plazas libres", "cupo asignado por la Junta", "9 plazas libres").
  const defs = [
    { familia: 'BACHILLERATO', curso: 1, nombre: '1º Bachillerato', plazas: 6 },
    { familia: 'BACHILLERATO', curso: 2, nombre: '2º Bachillerato', plazas: 4 },
    { familia: 'CICLOS_CONCERTADOS_GM', curso: 1, nombre: 'GM concertado 1º', plazas: 3 },
    { familia: 'CICLOS_CONCERTADOS_GM', curso: 2, nombre: 'GM concertado 2º', plazas: 3 },
    { familia: 'CICLOS_CONCERTADOS_GS', curso: 1, nombre: 'GS concertado 1º', plazas: 0, junta: true },
    { familia: 'CICLOS_CONCERTADOS_GS', curso: 2, nombre: 'GS concertado 2º', plazas: 0, junta: true },
    { familia: 'CICLOS_PRIVADOS_GS', curso: 1, nombre: 'GS privado 1º', plazas: 9 },
    { familia: 'CICLOS_PRIVADOS_GS', curso: 2, nombre: 'GS privado 2º', plazas: 9 },
  ] as const;
  for (const d of defs) {
    await db
      .insert(vias)
      .values({ familia: d.familia, curso: d.curso, nombre: d.nombre, cursoEscolar: CURSO_ESCOLAR, plazas: d.plazas, plazasAsignadasPorJunta: 'junta' in d })
      .onConflictDoNothing();
  }
  const todas = await db.select().from(vias).where(eq(vias.cursoEscolar, CURSO_ESCOLAR));
  const via = (f: string, c: number) => todas.find((x) => x.familia === f && x.curso === c)!.id;

  await db.insert(familias).values({ email: 'epena@correo.es', nombre: 'Familia Márquez Peña', vinculo: 'Hermana en 2º Bachillerato · Clara Márquez Peña' }).onConflictDoNothing();

  const [hay] = await db.select({ id: solicitudes.id }).from(solicitudes).limit(1);
  if (!hay) {
    const ejemplos = [
      { viaId: via('BACHILLERATO', 1), alumnaNombre: 'Lucía', alumnaApellidos: 'Márquez Peña', tutorNombre: 'Elena Peña Ríos', email: 'epena@correo.es', telefono: '+34 622 418 903', centroProcedencia: 'IES Martínez Montañés', modalidadInteres: 'Ciencias', canal: 'SOLICITUD_WEB' as const, asignadaSnec: false },
      // Correo incompleto a propósito, como en el mockup: la revisión lo marca y no deja citar.
      { viaId: via('CICLOS_CONCERTADOS_GS', 1), alumnaNombre: 'Daniel', alumnaApellidos: 'Ortiz Cano', tutorNombre: 'Andrés Ortiz Luque', email: 'aortiz@correo', telefono: '+34 611 902 447', centroProcedencia: 'IES Velázquez', modalidadInteres: null, canal: 'SOLICITUD_WEB' as const, asignadaSnec: true },
      { viaId: via('CICLOS_PRIVADOS_GS', 1), alumnaNombre: 'Paula', alumnaApellidos: 'Gil Romero', tutorNombre: 'Marta Romero Vela', email: 'mromero@correo.es', telefono: '+34 687 330 128', centroProcedencia: 'Colegio Portaceli', modalidadInteres: 'Marketing y publicidad', canal: 'SOLICITUD_WEB' as const, asignadaSnec: false },
    ];
    for (const e of ejemplos) {
      await db.transaction(async (tx) => {
        const [s] = await tx
          .insert(solicitudes)
          .values({ ...e, codigo: await siguienteCodigo(tx), consentimientoPrivacidad: true, consentimientoEn: new Date(), responsableId: maria.id })
          .returning();
        await registrarEvento(tx, s!.id, { tipo: 'familia' }, 'CREADA', { aEstado: 'RECIBIDA', detalle: { canal: e.canal, seed: true } });
        console.log(`  solicitud ${s!.codigo} · ${e.alumnaNombre} ${e.alumnaApellidos}`);
      });
    }
  }
  console.log(`Listo. Usuarios de demo: contraseña "${demoPass}". Admin: ${process.env.SEED_ADMIN_EMAIL ?? 'admin@albaydar.org'}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
