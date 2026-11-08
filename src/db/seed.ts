/**
 * Datos iniciales.
 *  - Siempre: roles, plantillas de correo, horario de la agenda y el usuario
 *    de Dirección (superadministrador) inicial.
 *  - Solo en desarrollo o con SEED_DEMO=true: usuarios de ejemplo, vías y
 *    las solicitudes de la bandeja del mockup.
 * Es idempotente: se puede ejecutar varias veces.
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { env } from '../config/env';
import { db, pool } from '../lib/db';
import { hashPassword } from '../modules/auth/auth.service';
import { alumnaContactos, alumnaEventos, alumnas, familias, solicitudes, usuarios, vias } from './schema';
import { sembrarBase } from './datos-base';
import { siguienteCodigo, siguienteValor, registrarEvento } from '../modules/solicitudes/comun';
import { formatoExpediente } from '../modules/alumnado/dominio';

const CURSO_ESCOLAR = process.env.SEED_CURSO_ESCOLAR ?? '2027-2028';

async function usuario(email: string, nombre: string, roles: string[], password: string) {
  const [u] = await db.select().from(usuarios).where(eq(usuarios.email, email));
  if (u) return u;
  const [n] = await db.insert(usuarios).values({ email, nombre, roles, passwordHash: await hashPassword(password) }).returning();
  console.log(`  usuario ${email} (${roles.join(', ')})`);
  return n!;
}

/**
 * Alumnado de ejemplo del curso en marcha (2026-2027): personas, DNI y teléfonos ficticios,
 * correos @example.com. Solo si no hay ningún expediente.
 */
async function alumnadoDemo(usuarioId: string) {
  const [hay] = await db.select({ id: alumnas.id }).from(alumnas).limit(1);
  if (hay) return;
  const curso = '2026-2027';
  type Demo = Omit<typeof alumnas.$inferInsert, 'expediente' | 'origen' | 'fechaAlta' | 'cursoEscolar'> & {
    contactos: { parentesco: string; nombre: string; telefono: string; email?: string }[];
  };
  const demo: Demo[] = [
    { nombre: 'Clara', apellidos: 'Márquez Peña', documento: '49218734E', fechaNacimiento: '2009-04-12', familia: 'BACHILLERATO', curso: 2, estudios: 'Ciencias y Tecnología', estado: 'MATRICULADA', domicilio: 'C/ Asunción 18, 41011 Sevilla',
      contactos: [{ parentesco: 'Madre', nombre: 'Elena Peña Ríos', telefono: '+34 622 418 903', email: 'epena@example.com' }] },
    { nombre: 'Irene', apellidos: 'Castaño Ruiz', documento: '49330127A', fechaNacimiento: '2010-02-03', familia: 'BACHILLERATO', curso: 1, estudios: 'Humanidades y Ciencias Sociales', estado: 'MATRICULADA', promociona: true,
      contactos: [{ parentesco: 'Madre', nombre: 'Pilar Ruiz Ortega', telefono: '+34 655 120 334', email: 'pruiz@example.com' }, { parentesco: 'Padre', nombre: 'Javier Castaño León', telefono: '+34 655 120 335' }] },
    { nombre: 'Marina', apellidos: 'Serrano Pineda', documento: '48812655P', fechaNacimiento: '2010-11-27', familia: 'BACHILLERATO', curso: 1, estudios: 'Humanidades y Ciencias Sociales', estado: 'MATRICULADA',
      contactos: [{ parentesco: 'Madre', nombre: 'Rosa Pineda Gil', telefono: '+34 677 118 402', email: 'rpineda@example.com' }] },
    { nombre: 'Adriana', apellidos: 'Quesada Ferrer', documento: '47920318W', fechaNacimiento: '2008-05-03', familia: 'CICLOS_PRIVADOS_GS', curso: 1, estudios: 'Marketing y Publicidad', estado: 'MATRICULADA', promociona: true, email: 'adriana.quesada@example.com',
      contactos: [{ parentesco: 'Madre', nombre: 'Pilar Ferrer Ariza', telefono: '+34 690 118 774', email: 'pferrer@example.com' }] },
    { nombre: 'Nerea', apellidos: 'Domínguez Salas', documento: '49611042L', fechaNacimiento: '2008-09-19', familia: 'CICLOS_CONCERTADOS_GM', curso: 2, estudios: 'Sistemas Microinformáticos y Redes', estado: 'MATRICULADA',
      contactos: [{ parentesco: 'Padre', nombre: 'Manuel Domínguez Vera', telefono: '+34 611 447 208', email: 'mdominguez@example.com' }] },
    { nombre: 'Nadia', apellidos: 'Bouhouch El Amrani', documento: 'Y4821533B', fechaNacimiento: '2009-03-14', familia: 'CICLOS_CONCERTADOS_GS', curso: 1, estudios: 'Administración y Finanzas', estado: 'EN_PROCESO',
      contactos: [{ parentesco: 'Madre', nombre: 'Samira El Amrani', telefono: '+34 634 902 118', email: 'selamrani@example.com' }, { parentesco: 'Padre', nombre: 'Rachid Bouhouch', telefono: '+34 634 902 119' }] },
    { nombre: 'Lorena', apellidos: 'Vidal Campos', documento: '48207719H', fechaNacimiento: '2009-07-30', familia: 'BACHILLERATO', curso: 2, estudios: 'Ciencias y Tecnología', estado: 'BAJA', fechaBaja: '2026-10-15', motivoBaja: 'Traslado a otro centro',
      contactos: [{ parentesco: 'Madre', nombre: 'Inés Campos Mena', telefono: '+34 600 318 552', email: 'icampos@example.com' }] },
  ];
  for (const { contactos, ...d } of demo) {
    await db.transaction(async (tx) => {
      const [a] = await tx
        .insert(alumnas)
        .values({ ...d, expediente: formatoExpediente('2026', await siguienteValor(tx, 'expediente-2026')), cursoEscolar: curso, origen: 'MANUAL', fechaAlta: '2026-09-01', creadaPorId: usuarioId })
        .returning();
      await tx.insert(alumnaContactos).values(contactos.map((c, i) => ({ ...c, email: c.email ?? null, alumnaId: a!.id, principal: i === 0, orden: i })));
      await tx.insert(alumnaEventos).values({ alumnaId: a!.id, tipo: 'ALTA', usuarioId, texto: 'Alta manual · alumnado de ejemplo' });
      if (d.estado === 'BAJA') await tx.insert(alumnaEventos).values({ alumnaId: a!.id, tipo: 'BAJA', usuarioId, texto: d.motivoBaja });
      console.log(`  alumna ${a!.expediente} · ${d.nombre} ${d.apellidos}`);
    });
  }
}

async function main() {
  console.log('Sembrando datos…');
  await sembrarBase(db);
  console.log('  roles, plantillas de correo y horario de la agenda');
  const adminPass = process.env.SEED_ADMIN_PASSWORD ?? 'CambiaEsto-2026!';
  await usuario(process.env.SEED_ADMIN_EMAIL ?? 'admin@albaydar.org', 'Dirección (administrador)', ['DIRECCION'], adminPass);

  // En producción solo se crean los datos base, salvo que se pida explícitamente la demo
  // (SEED_DEMO=true, lo usa el docker compose local).
  if (env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') {
    console.log('Producción: solo datos base y usuario de Dirección.');
    return;
  }

  // Responsables que aparecen en los chips de la bandeja del mockup.
  const demoPass = 'Albaydar-2026';
  const maria = await usuario('maria.reyes@albaydar.org', 'María Reyes', ['SECRETARIA'], demoPass);
  await usuario('juan.diaz@albaydar.org', 'Juan Díaz', ['SECRETARIA'], demoPass);
  await usuario('dolores.ruiz@albaydar.org', 'Dolores Ruiz', ['SECRETARIA'], demoPass);
  await usuario('direccion@albaydar.org', 'Equipo directivo', ['DIRECCION'], demoPass);
  await usuario('administracion@albaydar.org', 'Administración', ['ADMINISTRACION'], demoPass);
  await usuario('comercial@albaydar.org', 'Promoción y marketing', ['COMERCIAL'], demoPass);

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

  // Hasta el 05/11/2026 la semilla usaba @correo.es, un dominio real: en una BD de demo ya
  // creada se pasan a @example.com (reservado, nunca entrega). Solo las filas de la semilla,
  // por correo y nombre exactos: nunca una familia real que use ese proveedor.
  await db.execute(sql`update familias set email = 'epena@example.com' where email = 'epena@correo.es' and nombre = 'Familia Márquez Peña'`);
  await db.execute(sql`update solicitudes set email = replace(email, '@correo.es', '@example.com')
    where (email, alumna_nombre, alumna_apellidos) in (('epena@correo.es', 'Lucía', 'Márquez Peña'), ('mromero@correo.es', 'Paula', 'Gil Romero'))`);

  // La hermana de Lucía ya es una alumna de verdad (abajo): el vínculo sale de su expediente.
  // Se quita la fila que la semilla ponía en `familias` antes del módulo de Alumnado (solo esa, exacta).
  await db.delete(familias).where(sql`email = 'epena@example.com' and nombre = 'Familia Márquez Peña' and vinculo = 'Hermana en 2º Bachillerato · Clara Márquez Peña'`);
  await alumnadoDemo(maria.id);

  const [hay] = await db.select({ id: solicitudes.id }).from(solicitudes).limit(1);
  if (!hay) {
    const ejemplos = [
      { viaId: via('BACHILLERATO', 1), alumnaNombre: 'Lucía', alumnaApellidos: 'Márquez Peña', tutorNombre: 'Elena Peña Ríos', email: 'epena@example.com', telefono: '+34 622 418 903', centroProcedencia: 'IES Martínez Montañés', modalidadInteres: 'Ciencias', canal: 'SOLICITUD_WEB' as const, asignadaSnec: false },
      // Correo incompleto a propósito, como en el mockup: la revisión lo marca y no deja citar.
      { viaId: via('CICLOS_CONCERTADOS_GS', 1), alumnaNombre: 'Daniel', alumnaApellidos: 'Ortiz Cano', tutorNombre: 'Andrés Ortiz Luque', email: 'aortiz@correo', telefono: '+34 611 902 447', centroProcedencia: 'IES Velázquez', modalidadInteres: null, canal: 'SOLICITUD_WEB' as const, asignadaSnec: true },
      { viaId: via('CICLOS_PRIVADOS_GS', 1), alumnaNombre: 'Paula', alumnaApellidos: 'Gil Romero', tutorNombre: 'Marta Romero Vela', email: 'mromero@example.com', telefono: '+34 687 330 128', centroProcedencia: 'Colegio Portaceli', modalidadInteres: 'Marketing y publicidad', canal: 'SOLICITUD_WEB' as const, asignadaSnec: false },
    ];
    for (const e of ejemplos) {
      await db.transaction(async (tx) => {
        const [s] = await tx
          .insert(solicitudes)
          .values({ ...e, codigo: await siguienteCodigo(tx, todas.find((x) => x.id === e.viaId)!.familia), consentimientoPrivacidad: true, consentimientoEn: new Date(), responsableId: maria.id })
          .returning();
        await registrarEvento(tx, s!.id, { tipo: 'familia' }, 'CREADA', { aEstado: 'RECIBIDA', detalle: { canal: e.canal, seed: true } });
        console.log(`  solicitud ${s!.codigo} · ${e.alumnaNombre} ${e.alumnaApellidos}`);
      });
    }
  }
  console.log(`Listo. Usuarios de demo: contraseña "${demoPass}". Dirección (superadmin): ${process.env.SEED_ADMIN_EMAIL ?? 'admin@albaydar.org'}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
