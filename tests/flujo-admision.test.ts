/**
 * Recorre por HTTP el flujo de admisión contra PostgreSQL real, con un SMTP falso.
 *
 *  roles y permisos → solicitud web → alta telefónica incompleta → pedir que complete →
 *  agenda por jornada → citar (fechas RESERVADAS) → la familia elige (las otras se liberan) →
 *  cambio dentro de 24 h / bloqueado después → notas → recordatorios con plantillas HTML →
 *  ninguna me encaja → nuevas fechas → plantillas editables (CRUD, borrador, prueba, histórico)
 */
import { readFile, rm } from 'node:fs/promises';
import type { Transporter } from 'nodemailer';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { crearApp } from '../src/app';
import { db, pool } from '../src/lib/db';
import { correosSalientes, entrevistas, franjasAgenda, propuestasCita, reservas, solicitudes, usuarios, vias } from '../src/db/schema';
import { recordatoriosPago, vencerReservas } from '../src/modules/reservas/reservas.service';
import { sembrarBase } from '../src/db/datos-base';
import { encolarCorreo, procesarOutbox, setTransporter } from '../src/correo/outbox';
import { recordatoriosEntrevista, recordatoriosPropuesta } from '../src/jobs/recordatorios';
import { hashPassword } from '../src/modules/auth/auth.service';
import { invalidarCachePermisos } from '../src/modules/permisos/permisos.service';
import { fechaLocal, horaLocalAUtc, sumarDias } from '../src/lib/fechas';

const app = crearApp();
const ORIGIN = 'http://localhost:4200';
const PASS = 'Albaydar-2026';
type Mail = { to: string; replyTo: string; subject: string; text: string; html: string; attachments: { filename: string; content: Buffer }[] };
const buzon: Mail[] = [];

const enviarCorreos = () => procesarOutbox(100);
const ultimoPara = (to: string) => [...buzon].reverse().find((m) => m.to === to)!;
const tokenDe = (texto: string, ruta: string) => {
  const m = texto.match(new RegExp(`${ruta}/([A-Za-z0-9_-]{20,})`));
  if (!m) throw new Error(`No hay enlace ${ruta} en el correo`);
  return m[1]!;
};

const tokens: Record<string, string> = {};
const auth = (quien = 'secretaria') => ({ Authorization: `Bearer ${tokens[quien]}` });
async function login(quien: string, email: string) {
  const r = await request(app).post('/api/auth/login').send({ email, password: PASS });
  expect(r.status).toBe(200);
  tokens[quien] = r.body.accessToken;
  return r.body.usuario;
}

let viaBach = '';
/** Lunes de la semana que viene (siempre en el futuro y en día laborable). */
const lunes = (() => {
  let d = sumarDias(new Date(), 1);
  while (new Date(`${fechaLocal(d)}T12:00:00Z`).getUTCDay() !== 1) d = sumarDias(d, 1);
  return fechaLocal(d);
})();
const dia = (n: number) => fechaLocal(sumarDias(horaLocalAUtc(lunes, '12:00'), n));
const iso = (fecha: string, h: string) => horaLocalAUtc(fecha, h).toISOString();

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await migrate(db, { migrationsFolder: './drizzle' });
  await sembrarBase(db);
  invalidarCachePermisos();
  const h = await hashPassword(PASS);
  await db.insert(usuarios).values([
    { email: 'direccion@albaydar.org', nombre: 'Equipo directivo', roles: ['DIRECCION'], passwordHash: h },
    { email: 'maria.reyes@albaydar.org', nombre: 'María Reyes', roles: ['SECRETARIA'], passwordHash: h },
    { email: 'juan.diaz@albaydar.org', nombre: 'Juan Díaz', roles: ['SECRETARIA'], passwordHash: h },
    { email: 'administracion@albaydar.org', nombre: 'Administración', roles: ['ADMINISTRACION'], passwordHash: h },
    { email: 'comercial@albaydar.org', nombre: 'Promoción', roles: ['COMERCIAL'], passwordHash: h },
  ]);
  const [v] = await db.insert(vias).values({ familia: 'BACHILLERATO', curso: 1, nombre: '1º Bachillerato', cursoEscolar: '2027-2028', plazas: 6 }).returning();
  viaBach = v!.id;

  setTransporter({
    sendMail: async (m: Record<string, unknown>) => {
      buzon.push({
        to: String(m.to),
        replyTo: String(m.replyTo),
        subject: String(m.subject),
        text: String(m.text),
        html: String(m.html),
        attachments: ((m.attachments as { filename: string; content: Buffer }[]) ?? []).map((a) => ({ filename: a.filename, content: a.content })),
      });
      return { messageId: String(buzon.length) };
    },
    verify: async () => true,
  } as unknown as Transporter);
});

afterAll(async () => {
  setTransporter(null);
  await rm('./storage/test-uploads', { recursive: true, force: true });
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Autenticación', () => {
  let cookie = '';

  it('rechaza credenciales incorrectas sin decir si el correo existe', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'maria.reyes@albaydar.org', password: 'mal' });
    expect(r.body.error.code).toBe('CREDENCIALES_INVALIDAS');
    const r2 = await request(app).post('/api/auth/login').send({ email: 'nadie@albaydar.org', password: 'mal' });
    expect(r2.body.error.code).toBe('CREDENCIALES_INVALIDAS');
  });

  it('login devuelve token, cookie httpOnly y los permisos para el menú', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'Maria.Reyes@albaydar.org', password: PASS });
    expect(r.body.usuario).toMatchObject({ roles: ['SECRETARIA'], superadmin: false });
    expect(r.body.usuario.permisos).toContain('solicitudes.editar');
    expect(r.body.usuario.permisos).toContain('evaluacion.ver');
    expect(r.body.usuario.permisos).not.toContain('evaluacion.editar');
    expect(r.body.usuario.permisos).not.toContain('cobros.ver');
    tokens.secretaria = r.body.accessToken;
    cookie = r.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/alb_rt=.*HttpOnly/);
  });

  it('refresh rota el token y detecta su reutilización', async () => {
    const r1 = await request(app).post('/api/auth/refresh').set('Origin', ORIGIN).set('Cookie', cookie);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/auth/refresh').set('Origin', ORIGIN).set('Cookie', cookie);
    expect(r2.body.error.code).toBe('SESION_REVOCADA');
  });

  it('inicia sesión con los cinco perfiles', async () => {
    await login('secretaria', 'maria.reyes@albaydar.org');
    await login('secretaria2', 'juan.diaz@albaydar.org');
    const d = await login('direccion', 'direccion@albaydar.org');
    expect(d.superadmin).toBe(true);
    await login('administracion', 'administracion@albaydar.org');
    await login('comercial', 'comercial@albaydar.org');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Usuarios, roles y permisos', () => {
  it('Secretaría y Comercial no pueden gestionar usuarios', async () => {
    expect((await request(app).get('/api/usuarios').set(auth('secretaria'))).status).toBe(403);
    expect((await request(app).get('/api/usuarios').set(auth('comercial'))).status).toBe(403);
  });

  it('Dirección registra un usuario con rol y lo puede editar', async () => {
    const r = await request(app).post('/api/usuarios').set(auth('direccion')).send({ email: 'Nuevo@albaydar.org', nombre: 'Nueva Persona', roles: ['comercial'], password: 'OtraClave-2026' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: 'nuevo@albaydar.org', roles: ['COMERCIAL'], activo: true });
    const e = await request(app).patch(`/api/usuarios/${r.body.id}`).set(auth('direccion')).send({ roles: ['SECRETARIA', 'COMERCIAL'] });
    expect(e.body.roles).toEqual(['SECRETARIA', 'COMERCIAL']);
    const borrar = await request(app).delete(`/api/usuarios/${r.body.id}`).set(auth('direccion'));
    expect(borrar.body.eliminado).toBe(true);
  });

  it('rechaza roles inexistentes y correos repetidos', async () => {
    const r = await request(app).post('/api/usuarios').set(auth('direccion')).send({ email: 'x@albaydar.org', nombre: 'X', roles: ['SOPORTE'], password: 'OtraClave-2026' });
    expect(r.body.error.code).toBe('ROL_DESCONOCIDO');
    const r2 = await request(app).post('/api/usuarios').set(auth('direccion')).send({ email: 'maria.reyes@albaydar.org', nombre: 'X', roles: ['SECRETARIA'], password: 'OtraClave-2026' });
    expect(r2.body.error.code).toBe('EMAIL_EN_USO');
  });

  it('no deja quitar el último superadministrador', async () => {
    const [d] = await db.select().from(usuarios).where(eq(usuarios.email, 'direccion@albaydar.org'));
    const r = await request(app).patch(`/api/usuarios/${d!.id}`).set(auth('direccion')).send({ roles: ['SECRETARIA'] });
    expect(r.body.error.code).toBe('ULTIMO_SUPERADMIN');
  });

  it('la matriz tiene los cuatro roles acordados y Dirección la puede cambiar en caliente', async () => {
    const m = await request(app).get('/api/roles/matriz').set(auth('direccion'));
    expect(m.body.roles.map((r: { codigo: string }) => r.codigo)).toEqual(['DIRECCION', 'SECRETARIA', 'ADMINISTRACION', 'COMERCIAL']);
    expect(m.body.modulos.find((x: { id: string }) => x.id === 'solicitudes').porRol.COMERCIAL).toEqual({ ver: true, editar: true });

    expect((await request(app).get('/api/comunicaciones/plantillas').set(auth('comercial'))).status).toBe(403);
    const c = await request(app).patch('/api/roles/COMERCIAL/modulos').set(auth('direccion')).send({ modulo: 'comunicaciones', ver: true, editar: false });
    expect(c.body.modulos.find((x: { id: string }) => x.id === 'comunicaciones').porRol.COMERCIAL).toEqual({ ver: true, editar: false });
    // Sin volver a iniciar sesión:
    expect((await request(app).get('/api/comunicaciones/plantillas').set(auth('comercial'))).status).toBe(200);
    expect((await request(app).patch('/api/roles/DIRECCION/modulos').set(auth('direccion')).send({ modulo: 'cobros', ver: false, editar: false })).body.error.code).toBe('ROL_SUPERADMIN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Admisión y citación', () => {
  let lucia = '';
  let paula = '';
  let tokenCita = '';
  let codigoLucia = '';

  it('el formulario web exige todos los campos menos la modalidad', async () => {
    const base = { viaId: viaBach, alumnaNombre: 'Paula', alumnaApellidos: 'Gil Romero', tutorNombre: 'Marta Romero Vela', email: 'mromero@correo.es', telefono: '+34 687 330 128', consentimientoPrivacidad: true };
    const sinCentro = await request(app).post('/api/public/solicitudes').send(base);
    expect(sinCentro.status).toBe(400);
    expect(sinCentro.body.error.details.map((d: { campo: string }) => d.campo)).toContain('centroProcedencia');
    const ok = await request(app).post('/api/public/solicitudes').send({ ...base, centroProcedencia: 'Colegio Portaceli' });
    expect(ok.status).toBe(201);
    await enviarCorreos();
    const acuse = ultimoPara('mromero@correo.es');
    expect(acuse.subject).toContain(ok.body.codigo);
    expect(acuse.html).toContain('cropped-logo-final.png'); // diseño común
    paula = (await request(app).get('/api/solicitudes?q=Paula').set(auth())).body.items[0].id;
  });

  it('alta telefónica sin centro → incompleta → pedir que complete → la familia completa', async () => {
    const r = await request(app).post('/api/solicitudes').set(auth()).send({
      viaId: viaBach, alumnaNombre: 'Lucía', alumnaApellidos: 'Márquez Peña', tutorNombre: 'Elena Peña Ríos',
      email: 'epena@correo.es', telefono: '+34 622 418 903', canal: 'TELEFONO', consentimientoPrivacidad: true,
    });
    expect(r.status).toBe(201);
    lucia = r.body.id;
    codigoLucia = r.body.codigo;
    const rev = await request(app).post(`/api/solicitudes/${lucia}/revisar`).set(auth());
    expect(rev.body.faltan).toEqual(['Centro de procedencia']);
    expect((await request(app).post(`/api/solicitudes/${lucia}/citar`).set(auth()).send({ inicios: [iso(dia(0), '11:00')] })).body.error.code).toBe('SOLICITUD_INCOMPLETA');

    await request(app).post(`/api/solicitudes/${lucia}/pedir-completar`).set(auth()).send({ mensaje: 'Indícanos el centro actual.' });
    await enviarCorreos();
    const m = ultimoPara('epena@correo.es');
    expect(m.html).toContain('<li style="margin:5px 0">Centro de procedencia</li>');
    expect(m.html).toContain('Indícanos el centro actual.');
    const t = tokenDe(m.text, '/solicitud/completar');
    const c = await request(app).patch(`/api/public/solicitudes/completar/${t}`).send({ centroProcedencia: 'IES Martínez Montañés' });
    expect(c.body.completa).toBe(true);
  });

  it('la agenda va de lunes a viernes de 8:00 a 18:00, en tramos de 45 o 60 minutos', async () => {
    const r = await request(app).get(`/api/agenda/disponibilidad?desde=${dia(0)}&hasta=${dia(6)}&duracion=60`).set(auth());
    expect(r.body.dias.map((d: { fecha: string }) => d.fecha)).toEqual([dia(0), dia(1), dia(2), dia(3), dia(4)]); // sin fin de semana
    const lun = r.body.dias[0];
    expect(lun.huecos[0].franja).toBe('08:00 – 09:00');
    expect(lun.huecos[lun.huecos.length - 1].franja).toBe('17:00 – 18:00');
    expect((await request(app).get(`/api/agenda/disponibilidad?desde=${dia(0)}&hasta=${dia(0)}&duracion=30`).set(auth())).body.error.code).toBe('DURACION_NO_VALIDA');
  });

  it('no deja citar fuera de la jornada', async () => {
    const tarde = await request(app).post(`/api/solicitudes/${lucia}/citar`).set(auth()).send({ inicios: [iso(dia(0), '17:30')], duracion: 60 });
    expect(tarde.body.error.code).toBe('FUERA_DE_HORARIO');
    const sabado = await request(app).post(`/api/solicitudes/${lucia}/citar`).set(auth()).send({ inicios: [iso(dia(5), '10:00')] });
    expect(sabado.body.error.code).toBe('FUERA_DE_HORARIO');
    const cuatro = await request(app).post(`/api/solicitudes/${lucia}/citar`).set(auth()).send({ inicios: ['08:00', '09:00', '10:00', '11:00'].map((h) => iso(dia(0), h)) });
    expect(cuatro.status).toBe(400);
  });

  it('citar con 3 fechas: quedan RESERVADAS y nadie más puede usarlas', async () => {
    const r = await request(app).post(`/api/solicitudes/${lucia}/citar`).set(auth()).send({ inicios: [iso(dia(0), '11:00'), iso(dia(1), '12:00'), iso(dia(2), '16:00')], duracion: 60 });
    expect(r.status).toBe(201);
    expect(r.body.franjas.map((f: { estado: string; franja: string }) => [f.estado, f.franja])).toEqual([
      ['RESERVADA', '11:00 – 12:00'],
      ['RESERVADA', '12:00 – 13:00'],
      ['RESERVADA', '16:00 – 17:00'],
    ]);
    // En la disponibilidad aparecen ocupadas…
    const disp = await request(app).get(`/api/agenda/disponibilidad?desde=${dia(1)}&hasta=${dia(1)}&duracion=45`).set(auth());
    expect(disp.body.dias[0].huecos.find((h: { hora: string }) => h.hora === '12:00')).toMatchObject({ disponible: false, motivo: 'Ocupado' });
    expect(disp.body.dias[0].huecos.find((h: { hora: string }) => h.hora === '11:30')).toMatchObject({ disponible: false }); // 11:30–12:15 pisa 12:00
    // …y otra solicitud no puede proponerlas.
    const otra = await request(app).post(`/api/solicitudes/${paula}/citar`).set(auth()).send({ inicios: [iso(dia(1), '12:30')], duracion: 45 });
    expect(otra.body.error.code).toBe('FRANJA_OCUPADA');

    await enviarCorreos();
    const m = ultimoPara('epena@correo.es');
    expect(m.subject).toBe(`Elige la fecha de la entrevista de Lucía Márquez Peña · ${codigoLucia}`);
    expect(m.html).toContain('11:00 – 12:00');
    tokenCita = tokenDe(m.text, '/cita');
  });

  it('dos secretarias citan la misma hora a la vez: solo una lo consigue', async () => {
    const carmen = await request(app).post('/api/solicitudes').set(auth()).send({
      viaId: viaBach, alumnaNombre: 'Carmen', alumnaApellidos: 'Vega Salas', tutorNombre: 'Rocío Salas', email: 'rsalas@correo.es',
      telefono: '+34 600 111 222', centroProcedencia: 'IES Murillo', canal: 'PRESENCIAL', consentimientoPrivacidad: true,
    });
    const [a, b] = await Promise.all([
      request(app).post(`/api/solicitudes/${paula}/citar`).set(auth('secretaria')).send({ inicios: [iso(dia(3), '10:00')] }),
      request(app).post(`/api/solicitudes/${carmen.body.id}/citar`).set(auth('secretaria2')).send({ inicios: [iso(dia(3), '10:15')] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('la página de cita muestra el mockup (Presencial · Equipo directivo · Sala de Dirección)', async () => {
    const r = await request(app).get(`/api/public/citas/${tokenCita}`);
    expect(r.body).toMatchObject({ ref: codigoLucia, tutor: 'Elena', curso: 'Bachillerato 1º', estado: 'propuesta', duracion: 60, puedeCambiar: true, cambioHasta: null });
    expect(r.body.info).toEqual([
      { k: 'Tipo', v: 'Presencial' },
      { k: 'Con', v: 'Equipo directivo' },
      { k: 'Lugar', v: 'Sala de reuniones de Dirección · Avda. de la Palmera, 36' },
    ]);
    expect(r.body.slots.map((s: { time: string; disponible: boolean }) => [s.time, s.disponible])).toEqual([
      ['11:00 – 12:00', true],
      ['12:00 – 13:00', true],
      ['16:00 – 17:00', true],
    ]);
  });

  it('la familia elige: su fecha se confirma, las otras dos se liberan y llega la plantilla con .ics', async () => {
    const pagina = await request(app).get(`/api/public/citas/${tokenCita}`);
    const martes = pagina.body.slots[1];
    const r = await request(app).post(`/api/public/citas/${tokenCita}/elegir`).send({ huecoId: martes.id });
    expect(r.status).toBe(200);
    expect(r.body.cambio).toBe(false);

    const fs = await db.select().from(franjasAgenda).where(eq(franjasAgenda.propuestaId, (await db.select().from(propuestasCita).where(eq(propuestasCita.solicitudId, lucia)))[0]!.id));
    expect(fs.map((f) => f.estado).sort()).toEqual(['CONFIRMADA', 'LIBERADA', 'LIBERADA']);
    // El lunes a las 11:00 vuelve a estar libre para otras familias.
    const disp = await request(app).get(`/api/agenda/disponibilidad?desde=${dia(0)}&hasta=${dia(0)}&duracion=60`).set(auth());
    expect(disp.body.dias[0].huecos.find((h: { hora: string }) => h.hora === '11:00').disponible).toBe(true);

    await enviarCorreos();
    const m = ultimoPara('epena@correo.es');
    expect(m.subject).toMatch(/^Entrevista de admisión · Lucía Márquez Peña · /);
    expect(m.html).toContain('Rogamos traigan el DNI'); // texto de la plantilla del mockup
    expect(m.html).toContain('Recuerda subir el boletín de notas');
    expect(m.attachments[0]!.filename).toBe('entrevista-albaydar.ics');

    const det = await request(app).get(`/api/solicitudes/${lucia}`).set(auth());
    expect(det.body.estado).toBe('ENTREVISTA_PROGRAMADA');
    const cal = await request(app).get(`/api/entrevistas?desde=${dia(0)}&hasta=${dia(4)}`).set(auth());
    expect(cal.body.items.find((e: { solicitud: { id: string } }) => e.solicitud.id === lucia)).toMatchObject({ estadoEtiqueta: 'Confirmada', con: 'Equipo directivo' });
  });

  it('dentro de las 24 h puede cambiar a otra de las fechas propuestas', async () => {
    const pagina = await request(app).get(`/api/public/citas/${tokenCita}`);
    expect(pagina.body.estado).toBe('elegida');
    expect(pagina.body.puedeCambiar).toBe(true);
    const miercoles = pagina.body.slots[2];
    const r = await request(app).post(`/api/public/citas/${tokenCita}/elegir`).send({ huecoId: miercoles.id });
    expect(r.body.cambio).toBe(true);
    const [e] = await db.select().from(entrevistas).where(eq(entrevistas.solicitudId, lucia));
    expect(e).toMatchObject({ estado: 'REPROGRAMADA', secuenciaIcs: 1 });
    await enviarCorreos();
    expect(ultimoPara('epena@correo.es').subject).toMatch(/^Nueva fecha de entrevista/);
  });

  it('pasadas 24 h desde que aceptó, ya no puede cambiar ni pedir otra franja', async () => {
    await db.update(propuestasCita).set({ confirmadaEn: sumarDias(new Date(), -1.05) }).where(eq(propuestasCita.solicitudId, lucia));
    const pagina = await request(app).get(`/api/public/citas/${tokenCita}`);
    expect(pagina.body.puedeCambiar).toBe(false);
    const r = await request(app).post(`/api/public/citas/${tokenCita}/elegir`).send({ huecoId: pagina.body.slots[1].id });
    expect(r.body.error.code).toBe('CAMBIO_FUERA_DE_PLAZO');
    const o = await request(app).post(`/api/public/citas/${tokenCita}/otra-franja`).send({ franja: 'Otro día', prefiereLlamada: false });
    expect(o.body.error.code).toBe('CAMBIO_FUERA_DE_PLAZO');
    await db.update(propuestasCita).set({ confirmadaEn: new Date() }).where(eq(propuestasCita.solicitudId, lucia));
  });

  it('sube el boletín de notas (solo PDF o imagen)', async () => {
    expect((await request(app).post(`/api/public/citas/${tokenCita}/notas`).attach('archivo', Buffer.from('MZ\x90\x00'), 'virus.pdf')).status).toBe(400);
    expect((await request(app).post(`/api/public/citas/${tokenCita}/notas`).attach('archivo', Buffer.from('%PDF-1.7\n%prueba\n'), 'boletin-notas.pdf')).status).toBe(201);
    expect((await request(app).get(`/api/public/citas/${tokenCita}`)).body.notas.nombre).toBe('boletin-notas.pdf');
  });

  it('recordatorio del día antes con la plantilla HTML (y sin aviso de notas)', async () => {
    const [e] = await db.select().from(entrevistas).where(eq(entrevistas.solicitudId, lucia));
    const ahora = sumarDias(e!.inicio, -1);
    expect(await recordatoriosEntrevista(ahora)).toBe(1);
    expect(await recordatoriosEntrevista(ahora)).toBe(0);
    await enviarCorreos();
    const m = ultimoPara('epena@correo.es');
    expect(m.subject).toBe('Mañana: entrevista de admisión de Lucía Márquez Peña a las 16:00');
    expect(m.html).not.toContain('Recuerda subir el boletín');
  });

  it('"Ninguna me encaja": libera la fecha, anula en el calendario y avisa a secretaría', async () => {
    const r = await request(app).post(`/api/public/citas/${tokenCita}/otra-franja`).send({ franja: 'Martes o jueves a partir de las 17:00', prefiereLlamada: true });
    expect(r.body.estado).toBe('alternativa');
    const activas = await db.select().from(franjasAgenda).where(and(sql`${franjasAgenda.estado} <> 'LIBERADA'`, eq(franjasAgenda.propuestaId, (await db.select().from(propuestasCita).where(eq(propuestasCita.solicitudId, lucia)))[0]!.id)));
    expect(activas).toHaveLength(0);
    await enviarCorreos();
    expect(ultimoPara('secretaria@albaydar.org').html).toContain('Martes o jueves a partir de las 17:00');
    expect(ultimoPara('epena@correo.es').attachments[0]!.content.toString()).toContain('METHOD:CANCEL');
  });

  it('"Proponer nuevas fechas" invalida el enlace anterior', async () => {
    const r = await request(app).post(`/api/solicitudes/${lucia}/citar`).set(auth()).send({ inicios: [iso(dia(3), '17:00'), iso(dia(4), '08:00')], duracion: 45 });
    expect(r.status).toBe(201);
    expect((await request(app).get(`/api/public/citas/${tokenCita}`)).body.error.code).toBe('PROPUESTA_SUSTITUIDA');
    await enviarCorreos();
    tokenCita = tokenDe(ultimoPara('epena@correo.es').text, '/cita');
  });

  it('sin respuesta en 3 días: un único recordatorio con plantilla HTML', async () => {
    await db.update(propuestasCita).set({ createdAt: sumarDias(new Date(), -4) }).where(eq(propuestasCita.estado, 'PENDIENTE'));
    expect(await recordatoriosPropuesta()).toBeGreaterThanOrEqual(1);
    expect(await recordatoriosPropuesta()).toBe(0);
    await enviarCorreos();
    const m = ultimoPara('epena@correo.es');
    expect(m.subject).toBe('Recordatorio: elige la fecha de la entrevista de Lucía Márquez Peña');
    expect(m.html).toContain('Te las tenemos reservadas');
    expect((await request(app).get(`/api/public/citas/${tokenDe(m.text, '/cita')}`)).status).toBe(200);
  });

  it('solo Dirección registra la decisión de admisión', async () => {
    const [e] = await db.select().from(entrevistas).where(eq(entrevistas.solicitudId, paula));
    expect(e).toBeUndefined();
    const r = await request(app).patch(`/api/solicitudes/${paula}/estado`).set(auth()).send({ estado: 'ADMITIDA' });
    expect(r.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Plantillas de correo (Comunicaciones)', () => {
  let idPropuesta = '';
  let idRecordatorio = '';

  it('lista una plantilla por evento, con las de fases futuras en borrador', async () => {
    const r = await request(app).get('/api/comunicaciones/plantillas').set(auth());
    const porEvento = Object.fromEntries(r.body.items.map((p: { evento: string; estado: string }) => [p.evento, p.estado]));
    expect(porEvento).toMatchObject({
      CITA_CONFIRMADA: 'ACTIVADA', CITACION_RECORDATORIO: 'ACTIVADA', ENTREVISTA_RECORDATORIO: 'ACTIVADA',
      ADMITIDA: 'ACTIVADA', EN_ESPERA: 'ACTIVADA', NO_ADMITIDA: 'ACTIVADA', RECORDATORIO_PAGO: 'ACTIVADA', RESERVA_VENCIDA: 'ACTIVADA',
      MATRICULA_CONFIRMADA: 'BORRADOR',
    });
    idPropuesta = r.body.items.find((p: { evento: string }) => p.evento === 'CITACION_PROPUESTA').id;
    idRecordatorio = r.body.items.find((p: { evento: string }) => p.evento === 'CITACION_RECORDATORIO').id;
    const ev = await request(app).get('/api/comunicaciones/eventos').set(auth());
    expect(ev.body.items.find((e: { clave: string }) => e.clave === 'CITA_CONFIRMADA').variables.map((x: { nombre: string }) => x.nombre)).toEqual(
      expect.arrayContaining(['alumna', 'fecha_entrevista', 'hora', 'sala', 'boton']),
    );
  });

  it('valida variables y elimina código peligroso al guardar', async () => {
    const mala = await request(app).patch(`/api/comunicaciones/plantillas/${idPropuesta}`).set(auth()).send({ asunto: 'Hola {{alumno}}' });
    expect(mala.body.error).toMatchObject({ code: 'VARIABLES_DESCONOCIDAS' });
    const r = await request(app)
      .patch(`/api/comunicaciones/plantillas/${idPropuesta}`)
      .set(auth())
      .send({ asunto: '{{alumna}}: elige tu entrevista', cuerpoHtml: '<p onclick="x()">Hola {{tutor}}</p><script>alert(1)</script>{{fechas_propuestas}}<p><a href="{{enlace}}">Elegir</a></p>' });
    expect(r.status).toBe(200);
    expect(r.body.cuerpoHtml).not.toContain('script');
    expect(r.body.cuerpoHtml).not.toContain('onclick');
    expect(r.body.cuerpoHtml).toContain('href="{{enlace}}"');
  });

  it('vista previa con datos de ejemplo', async () => {
    const r = await request(app).post('/api/comunicaciones/plantillas/previsualizar').set(auth()).send({ evento: 'CITA_CONFIRMADA', asunto: 'Cita {{fecha_entrevista}}', cuerpoHtml: '<p>{{alumna}} a las {{hora}}</p>' });
    expect(r.body.asunto).toBe('Cita Martes 3 de noviembre');
    expect(r.body.html).toContain('Lucía Márquez Peña a las 10:00');
  });

  it('el siguiente correo del flujo usa la plantilla editada', async () => {
    const s = (await request(app).get('/api/solicitudes?q=Carmen').set(auth())).body.items[0];
    const r = await request(app).post(`/api/solicitudes/${s.id}/citar`).set(auth()).send({ inicios: [iso(dia(4), '09:00')] });
    expect(r.status).toBe(201);
    await enviarCorreos();
    const m = ultimoPara('rsalas@correo.es');
    expect(m.subject).toBe('Carmen Vega Salas: elige tu entrevista');
    expect(m.html).toMatch(/<a href="http:\/\/localhost:4200\/cita\/[A-Za-z0-9_-]+">Elegir<\/a>/);
  });

  it('en borrador, el recordatorio no se envía; un correo imprescindible sí (con la predeterminada)', async () => {
    await request(app).patch(`/api/comunicaciones/plantillas/${idRecordatorio}`).set(auth()).send({ estado: 'BORRADOR' });
    await db.update(propuestasCita).set({ createdAt: sumarDias(new Date(), -4), recordatorioEnviadoEn: null }).where(eq(propuestasCita.estado, 'PENDIENTE'));
    expect(await recordatoriosPropuesta()).toBe(0);

    const del = await request(app).delete(`/api/comunicaciones/plantillas/${idPropuesta}`).set(auth());
    expect(del.body.aviso).toMatch(/imprescindible/);
    const s = (await request(app).get('/api/solicitudes?q=Carmen').set(auth())).body.items[0];
    await request(app).post(`/api/solicitudes/${s.id}/citar`).set(auth()).send({ inicios: [iso(dia(4), '13:00')] });
    await enviarCorreos();
    expect(ultimoPara('rsalas@correo.es').subject).toMatch(/^Elige la fecha de la entrevista de Carmen/);
  });

  it('crear una plantilla activada pasa la anterior del evento a borrador', async () => {
    const r = await request(app).post('/api/comunicaciones/plantillas').set(auth()).send({ evento: 'SOLICITUD_RECIBIDA', nombre: 'Acuse v2', asunto: 'Gracias, {{tutor}}', cuerpoHtml: '<p>Recibido: {{codigo}}</p>', estado: 'ACTIVADA' });
    expect(r.body.estado).toBe('ACTIVADA');
    const lista = (await request(app).get('/api/comunicaciones/plantillas').set(auth())).body.items.filter((p: { evento: string }) => p.evento === 'SOLICITUD_RECIBIDA');
    expect(lista.map((p: { estado: string }) => p.estado).sort()).toEqual(['ACTIVADA', 'BORRADOR']);
  });

  it('"Enviar prueba" y el histórico de envíos', async () => {
    const r = await request(app).post(`/api/comunicaciones/plantillas/${idRecordatorio}/prueba`).set(auth()).send({});
    expect(r.body.para).toBe('maria.reyes@albaydar.org');
    await enviarCorreos();
    expect(ultimoPara('maria.reyes@albaydar.org').subject).toMatch(/^\[Prueba\] Recordatorio/);
    const h = await request(app).get('/api/comunicaciones/envios?pageSize=5').set(auth());
    expect(h.body.total).toBeGreaterThan(10);
    expect(h.body.items[0]).toMatchObject({ evento: 'PRUEBA', estado: 'ENVIADO' });
    const res = await request(app).get('/api/comunicaciones/envios/resumen').set(auth());
    expect(res.body.porcentajeEntrega).toBe(100);
    const pend = await db.select().from(correosSalientes).where(eq(correosSalientes.estado, 'PENDIENTE'));
    expect(pend).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Contrato con el front: bandeja, kanban y avisos', () => {
  let ana = '';
  let elena = '';
  let tokenAna = '';
  const pdf = Buffer.from('%PDF-1.7\n%prueba\n');

  it('una ruta inexistente responde 404 (no 401, que cerraría la sesión)', async () => {
    expect((await request(app).post(`/api/public/citas/${'x'.repeat(40)}/reopen`)).status).toBe(404);
    expect((await request(app).get('/api/no-existe')).status).toBe(404);
    expect((await request(app).get('/api/solicitudes')).status).toBe(401);
  });

  it('el formulario público acepta "Asignada por la Junta (SNEC)"', async () => {
    const r = await request(app).post('/api/public/solicitudes').send({
      viaId: viaBach, alumnaNombre: 'Ana', alumnaApellidos: 'Ruiz Campos', centroProcedencia: 'IES Bécquer', tutorNombre: 'Pilar Campos Ortega',
      email: 'pcampos@correo.es', telefono: '+34 655 210 334', consentimientoPrivacidad: true, asignadaSnec: true, website: '',
    });
    expect(r.status).toBe(201);
    const [item] = (await request(app).get('/api/solicitudes?q=Ana Ruiz').set(auth())).body.items;
    ana = item.id;
    expect(item).toMatchObject({ asignadaSnec: true, origen: 'Asignada por la Junta (SNEC)', propuesta: null, entrevista: null, notasSubidas: false });
    expect(item.revision.checks.find((c: { id: string }) => c.id === 'snec').resultado).toBe('aviso');
    expect(item.siguientes).toContainEqual({ estado: 'CITACION_ENVIADA', columna: 'entrevista', accion: 'CITAR_A_ENTREVISTA' });
  });

  it('bandeja: cada solicitud trae sus comprobaciones y la propuesta vigente', async () => {
    await request(app).post(`/api/solicitudes/${ana}/citar`).set(auth()).send({ inicios: [iso(dia(7), '10:00'), iso(dia(8), '10:00')], duracion: 45 });
    const bandeja = await request(app).get('/api/solicitudes?vista=bandeja&pageSize=200').set(auth());
    expect(bandeja.body.items.every((i: { revision: unknown }) => i.revision !== null)).toBe(true);
    const item = bandeja.body.items.find((i: { id: string }) => i.id === ana);
    expect(item.propuesta).toMatchObject({ estado: 'PENDIENTE', duracion: 45 });
    expect(item.propuesta.fechas.map((f: { franja: string; estado: string }) => [f.franja, f.estado])).toEqual([
      ['10:00 – 10:45', 'RESERVADA'],
      ['10:00 – 10:45', 'RESERVADA'],
    ]);
    await enviarCorreos();
    tokenAna = tokenDe(ultimoPara('pcampos@correo.es').text, '/cita');
  });

  it('elegir devuelve la cita completa, como GET /citas/:token', async () => {
    const pagina = await request(app).get(`/api/public/citas/${tokenAna}`);
    const r = await request(app).post(`/api/public/citas/${tokenAna}/elegir`).send({ huecoId: pagina.body.slots[0].id });
    expect(r.body).toMatchObject({ ref: pagina.body.ref, estado: 'elegida', cambio: false, puedeCambiar: true });
    expect(r.body.slots[0]).toMatchObject({ elegido: true });
    expect(r.body.elegida.time).toBe('10:00 – 10:45');
  });

  it('kanban: "Entrevista sin notas", con fecha de la entrevista, total y coincidencias', async () => {
    const k = await request(app).get('/api/solicitudes/pipeline?notasPendientes=true').set(auth());
    const tarjetas = k.body.columnas.flatMap((c: { items: unknown[] }) => c.items);
    const tarjeta = tarjetas.find((i: { id: string }) => i.id === ana);
    expect(tarjeta).toMatchObject({ estado: 'ENTREVISTA_PROGRAMADA', notasSubidas: false, entrevista: { franja: '10:00 – 10:45', estadoEtiqueta: 'Confirmada' } });
    expect(tarjetas.every((i: { estado: string }) => i.estado === 'ENTREVISTA_PROGRAMADA')).toBe(true);
    expect(k.body.coinciden).toBe(tarjetas.length);
    expect(k.body.total).toBeGreaterThanOrEqual(k.body.coinciden);

    await request(app).post(`/api/public/citas/${tokenAna}/notas`).attach('archivo', pdf, 'boletin.pdf');
    const k2 = await request(app).get('/api/solicitudes/pipeline?notasPendientes=true').set(auth());
    expect(k2.body.columnas.flatMap((c: { items: { id: string }[] }) => c.items).map((i: { id: string }) => i.id)).not.toContain(ana);
  });

  it('kanban: "Familia ya vinculada" usa la misma regla que la revisión', async () => {
    const r = await request(app).post('/api/solicitudes').set(auth()).send({
      viaId: viaBach, alumnaNombre: 'Elena', alumnaApellidos: 'Ruiz Campos', tutorNombre: 'Pilar Campos Ortega', email: '',
      telefono: '+34 655 210 334', centroProcedencia: 'IES Bécquer', canal: 'HERMANA_EN_EL_CENTRO', consentimientoPrivacidad: true,
    });
    elena = r.body.id;
    const k = await request(app).get('/api/solicitudes/pipeline?familiaVinculada=true').set(auth());
    const ids = k.body.columnas.flatMap((c: { items: { id: string }[] }) => c.items).map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([ana, elena]));
    const ficha = await request(app).get(`/api/solicitudes/${elena}`).set(auth());
    expect(ficha.body.revision.checks.find((c: { id: string }) => c.id === 'familia').resultado).toBe('aviso');

    // Dos altas telefónicas sin correo no son la misma familia.
    const sinCorreo = (nombre: string, tel: string) =>
      request(app).post('/api/solicitudes').set(auth()).send({
        viaId: viaBach, alumnaNombre: nombre, alumnaApellidos: 'Prueba Sin Correo', tutorNombre: 'Tutor', email: '', telefono: tel,
        centroProcedencia: 'IES Murillo', canal: 'TELEFONO', consentimientoPrivacidad: true,
      });
    const a = await sinCorreo('Irene', '+34 600 000 001');
    await sinCorreo('Rocío', '+34 600 000 002');
    const fa = await request(app).get(`/api/solicitudes/${a.body.id}`).set(auth());
    expect(fa.body.revision.checks.find((c: { id: string }) => c.id === 'familia').resultado).toBe('ok');
  });

  it('las transiciones de cada tarjeta dependen de los permisos del usuario', async () => {
    await db.update(solicitudes).set({ estado: 'ENTREVISTA_REALIZADA' }).where(eq(solicitudes.id, elena));
    const sec = await request(app).get(`/api/solicitudes/${elena}`).set(auth('secretaria'));
    expect(sec.body.siguientes).toEqual([]);
    const dir = await request(app).get(`/api/solicitudes/${elena}`).set(auth('direccion'));
    expect(dir.body.siguientes.map((s: { estado: string }) => s.estado)).toEqual(['ADMITIDA', 'EN_ESPERA', 'NO_ADMITIDA']);
  });

  it('aviso "la familia ya eligió": una vez por usuario', async () => {
    const r = await request(app).get('/api/solicitudes/respuestas-familia').set(auth('secretaria'));
    const aviso = r.body.items.find((i: { solicitud: { id: string } }) => i.solicitud.id === ana);
    expect(aviso).toMatchObject({ tipo: 'CITA_CONFIRMADA', solicitud: { alumna: 'Ana Ruiz Campos' }, cita: { franja: '10:00 – 10:45' } });

    const visto = await request(app)
      .post('/api/solicitudes/respuestas-familia/visto')
      .set(auth('secretaria'))
      .send({ eventoIds: [aviso.eventoId, '00000000-0000-4000-8000-000000000000'] });
    expect(visto.status).toBe(204);
    const despues = await request(app).get('/api/solicitudes/respuestas-familia').set(auth('secretaria'));
    expect(despues.body.items.map((i: { eventoId: string }) => i.eventoId)).not.toContain(aviso.eventoId);
    // Otra secretaria todavía no lo ha visto.
    const otra = await request(app).get('/api/solicitudes/respuestas-familia').set(auth('secretaria2'));
    expect(otra.body.items.map((i: { eventoId: string }) => i.eventoId)).toContain(aviso.eventoId);
  });

  it('entrevistas: cada ítem trae su nota', async () => {
    const cal = await request(app).get(`/api/entrevistas?desde=${dia(7)}&hasta=${dia(8)}`).set(auth());
    const e = cal.body.items.find((i: { solicitud: { id: string } }) => i.solicitud.id === ana);
    expect(e.notas).toBeNull();
    await request(app).patch(`/api/entrevistas/${e.id}`).set(auth()).send({ notas: 'Interesada en el bachillerato de Ciencias.' });
    const cal2 = await request(app).get(`/api/entrevistas?desde=${dia(7)}&hasta=${dia(8)}`).set(auth());
    expect(cal2.body.items.find((i: { id: string }) => i.id === e.id).notas).toBe('Interesada en el bachillerato de Ciencias.');
  });

  it('responsables: solo quien puede gestionar solicitudes', async () => {
    const r = await request(app).get('/api/usuarios/responsables').set(auth());
    const nombres = r.body.items.map((u: { nombre: string }) => u.nombre);
    expect(nombres).toEqual(expect.arrayContaining(['María Reyes', 'Juan Díaz', 'Equipo directivo', 'Promoción']));
    expect(nombres).not.toContain('Administración');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Fase 03: decisión de admisión, reserva de plaza y cobros', () => {
  const IBAN = 'ES91 2100 0418 4502 0005 1332';
  let sara = { id: '', email: '' };
  let lucas = { id: '', email: '' };
  let primerCobro = '';
  let telefono = 0;

  /** Solicitud con la entrevista ya hecha, lista para decidir (alta interna: no gasta el límite del formulario público). */
  async function evaluada(nombre: string) {
    const email = `${nombre.toLowerCase()}.f3@correo.es`;
    const r = await request(app)
      .post('/api/solicitudes')
      .set(auth())
      .send({
        viaId: viaBach, alumnaNombre: nombre, alumnaApellidos: 'Fase Tres', tutorNombre: `Familia de ${nombre}`, email,
        telefono: `+34 611 300 ${String(++telefono).padStart(3, '0')}`, centroProcedencia: 'IES Bécquer', canal: 'PRESENCIAL', consentimientoPrivacidad: true,
      });
    await db.update(solicitudes).set({ estado: 'ENTREVISTA_REALIZADA' }).where(eq(solicitudes.id, r.body.id));
    return { id: r.body.id as string, email };
  }
  const decidir = (id: string, body: Record<string, unknown>, quien = 'direccion') => request(app).post(`/api/solicitudes/${id}/decision`).set(auth(quien)).send(body);
  const cobrar = (body: Record<string, unknown>, quien = 'administracion') => request(app).post('/api/cobros').set(auth(quien)).send(body);
  const ficha = async (id: string) => (await request(app).get(`/api/solicitudes/${id}`).set(auth('direccion'))).body;

  it('las decisiones no se hacen arrastrando la tarjeta: van por "Registrar decisión"', async () => {
    sara = await evaluada('Sara');
    const r = await request(app).patch(`/api/solicitudes/${sara.id}/estado`).set(auth('direccion')).send({ estado: 'ADMITIDA' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'ACCION_REQUERIDA', details: { accion: 'DECIDIR' } });
    expect((await decidir(sara.id, { decision: 'ADMITIDA' }, 'secretaria')).status).toBe(403);
  });

  it('admitir crea la reserva de 300 € a 15 días y envía el IBAN a la familia', async () => {
    const r = await decidir(sara.id, { decision: 'ADMITIDA', notificar: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'ADMITIDA', notificada: true });
    expect(r.body.reserva).toMatchObject({ importe: 30000, pendiente: 30000, estado: 'PENDIENTE', diasRestantes: 15, fechaLimite: fechaLocal(sumarDias(new Date(), 15)) });
    await enviarCorreos();
    const m = ultimoPara(sara.email);
    expect(m.subject).toMatch(/^Plaza admitida para Sara Fase Tres · reserva antes del /);
    expect(m.html).toContain(IBAN);
    expect(m.html).toContain('300,00');
    expect(m.html).toContain('transferencia o en efectivo');
    const f = await ficha(sara.id);
    expect(f.reserva).toMatchObject({ estado: 'PENDIENTE', importe: 30000 });
    expect(f.siguientes).toContainEqual({ estado: 'PLAZA_RESERVADA', columna: 'reserva', accion: 'REGISTRAR_COBRO' });
  });

  it('cobro parcial: la reserva sigue pendiente y no se puede cobrar más de lo que falta', async () => {
    expect((await cobrar({ solicitudId: sara.id, importe: 10000, metodo: 'EFECTIVO' }, 'secretaria')).status).toBe(403);
    const r = await cobrar({ solicitudId: sara.id, importe: 10000, metodo: 'EFECTIVO' });
    expect(r.status).toBe(201);
    expect(r.body.cobro).toMatchObject({ importe: 10000, metodo: 'EFECTIVO', conceptoEtiqueta: 'Reserva de plaza', registradoPor: { nombre: 'Administración' } });
    expect(r.body.cobro.reciboNumero).toMatch(/^R-\d{4}-0001$/);
    expect(r.body.reserva).toMatchObject({ estado: 'PENDIENTE', pagado: 10000, pendiente: 20000 });
    primerCobro = r.body.cobro.id;
    expect((await ficha(sara.id)).estado).toBe('ADMITIDA');
    const demasiado = await cobrar({ solicitudId: sara.id, importe: 25000, metodo: 'TRANSFERENCIA' });
    expect(demasiado.body.error).toMatchObject({ code: 'IMPORTE_SUPERIOR_AL_PENDIENTE', details: { pendiente: 20000 } });
  });

  it('al completar el pago la plaza queda reservada', async () => {
    const r = await cobrar({ solicitudId: sara.id, importe: 20000, metodo: 'TRANSFERENCIA', observaciones: 'Transferencia del 20/10' });
    expect(r.body.reserva).toMatchObject({ estado: 'PAGADA', pendiente: 0 });
    expect(r.body.cobro.reciboNumero).toMatch(/^R-\d{4}-0002$/);
    expect((await ficha(sara.id)).estado).toBe('PLAZA_RESERVADA');
    const pagos = await request(app).get(`/api/cobros?solicitudId=${sara.id}`).set(auth('administracion'));
    expect(pagos.body).toMatchObject({ total: 2, suma: 30000 });
  });

  it('anular un cobro reabre la reserva y la plaza vuelve a "Admitida"', async () => {
    const segundo = (await request(app).get(`/api/cobros?solicitudId=${sara.id}`).set(auth('administracion'))).body.items.find((c: { id: string }) => c.id !== primerCobro);
    expect((await request(app).post(`/api/cobros/${segundo.id}/anular`).set(auth('administracion')).send({})).status).toBe(400); // sin motivo
    const r = await request(app).post(`/api/cobros/${segundo.id}/anular`).set(auth('administracion')).send({ motivo: 'Transferencia devuelta por el banco' });
    expect(r.body.cobro.anulado).toMatchObject({ motivo: 'Transferencia devuelta por el banco', por: 'Administración' });
    expect(r.body.reserva).toMatchObject({ estado: 'PENDIENTE', pagado: 10000 });
    expect((await ficha(sara.id)).estado).toBe('ADMITIDA');
    expect((await request(app).post(`/api/cobros/${segundo.id}/anular`).set(auth('administracion')).send({ motivo: 'otra vez' })).body.error.code).toBe('COBRO_YA_ANULADO');
    expect((await request(app).get(`/api/cobros?solicitudId=${sara.id}`).set(auth('administracion'))).body.suma).toBe(10000);
  });

  it('cambiar la decisión de una admitida con cobros exige anularlos antes', async () => {
    const r = await decidir(sara.id, { decision: 'EN_ESPERA' });
    expect(r.body.error.code).toBe('RESERVA_CON_COBROS');
  });

  it('recordatorio de pago a 3 días del plazo, una sola vez', async () => {
    lucas = await evaluada('Lucas');
    await decidir(lucas.id, { decision: 'ADMITIDA', notificar: false });
    await db.update(reservas).set({ fechaLimite: fechaLocal(sumarDias(new Date(), 2)) }).where(eq(reservas.solicitudId, lucas.id));
    const mediodia = horaLocalAUtc(fechaLocal(new Date()), '12:00');
    expect(await recordatoriosPago(mediodia)).toBeGreaterThanOrEqual(1);
    expect(await recordatoriosPago(mediodia)).toBe(0);
    await enviarCorreos();
    const m = ultimoPara(lucas.email);
    expect(m.subject).toBe('Recordatorio: la reserva de plaza de Lucas Fase Tres');
    expect(m.html).toContain(IBAN);
    expect((await request(app).get('/api/reservas?porVencer=true').set(auth('administracion'))).body.items.map((x: { solicitud: { id: string } }) => x.solicitud.id)).toContain(lucas.id);
  });

  it('pasado el plazo: reserva vencida, aviso a secretaría y administración, y aún se puede pagar', async () => {
    await db.update(reservas).set({ fechaLimite: fechaLocal(sumarDias(new Date(), -1)) }).where(eq(reservas.solicitudId, lucas.id));
    expect(await vencerReservas()).toBe(1);
    await enviarCorreos();
    expect(ultimoPara('secretaria@albaydar.org').subject).toBe(`Reserva vencida sin pagar · Lucas Fase Tres · ${(await ficha(lucas.id)).codigo}`);
    expect(ultimoPara('administracion@albaydar.org').subject).toMatch(/^Reserva vencida sin pagar · Lucas/);
    const k = await request(app).get('/api/solicitudes/pipeline?reservaPorVencer=true').set(auth('direccion'));
    const tarjeta = k.body.columnas.flatMap((c: { items: { id: string }[] }) => c.items).find((i: { id: string }) => i.id === lucas.id);
    expect(tarjeta.reserva).toMatchObject({ estado: 'VENCIDA', diasRestantes: -1 });
    // La plaza no se libera sola: si la familia paga tarde, se registra igual.
    const r = await cobrar({ solicitudId: lucas.id, importe: 30000, metodo: 'TRANSFERENCIA' });
    expect(r.body.reserva.estado).toBe('PAGADA');
    expect((await ficha(lucas.id)).estado).toBe('PLAZA_RESERVADA');
  });

  it('lista de espera: posición por vía y correo con la posición', async () => {
    const primera = await evaluada('Irene');
    const segunda = await evaluada('Berta');
    expect((await decidir(primera.id, { decision: 'EN_ESPERA' })).body.posicionEspera).toBe(1);
    const r = await decidir(segunda.id, { decision: 'EN_ESPERA', motivo: 'El grupo está completo.' });
    expect(r.body).toMatchObject({ estado: 'EN_ESPERA', posicionEspera: 2, notificada: true });
    await enviarCorreos();
    const m = ultimoPara(segunda.email);
    expect(m.html).toContain('posición <strong>2</strong>');
    expect(m.html).toContain('El grupo está completo.');
    // Se libera una plaza: la primera pasa a admitida y la segunda sube al puesto 1.
    const admitida = await decidir(primera.id, { decision: 'ADMITIDA', notificar: false });
    expect(admitida.body.reserva.estado).toBe('PENDIENTE');
    expect((await ficha(segunda.id)).posicionEspera).toBe(1);
    // Descartar una admitida sin cobros anula su reserva.
    await request(app).patch(`/api/solicitudes/${primera.id}/estado`).set(auth('direccion')).send({ estado: 'DESCARTADA' });
    const anuladas = await request(app).get('/api/reservas?estado=ANULADA').set(auth('administracion'));
    expect(anuladas.body.items.map((x: { solicitud: { id: string } }) => x.solicitud.id)).toContain(primera.id);
  });

  it('no admitida: correo con el motivo', async () => {
    const carlos = await evaluada('Carla');
    const r = await decidir(carlos.id, { decision: 'NO_ADMITIDA', motivo: 'No quedan plazas en la vía solicitada.' });
    expect(r.body).toMatchObject({ estado: 'NO_ADMITIDA', reserva: null, notificada: true });
    await enviarCorreos();
    const m = ultimoPara(carlos.email);
    expect(m.subject).toBe(`Resolución de la solicitud de Carla Fase Tres · ${(await ficha(carlos.id)).codigo}`);
    expect(m.html).toContain('No quedan plazas en la vía solicitada.');
  });

  it('configuración de la reserva: IBAN validado e importe por vía', async () => {
    const cfg = await request(app).get('/api/reservas/configuracion').set(auth('administracion'));
    expect(cfg.body).toMatchObject({ importe: 30000, iban: 'ES9121000418450200051332', plazoDias: 15, metodos: ['TRANSFERENCIA', 'EFECTIVO'] });
    expect((await request(app).put('/api/reservas/configuracion').set(auth('administracion')).send(cfg.body)).status).toBe(403);
    const mal = await request(app).put('/api/reservas/configuracion').set(auth('direccion')).send({ ...cfg.body, iban: 'ES92 2100 0418 4502 0005 1332' });
    expect(mal.body.error.details[0]).toMatchObject({ campo: 'iban' });
    const ok = await request(app).put('/api/reservas/configuracion').set(auth('direccion')).send({ ...cfg.body, importesPorVia: { BACHILLERATO: 25000 } });
    expect(ok.status).toBe(200);
    const dani = await evaluada('Daniela');
    expect((await decidir(dani.id, { decision: 'ADMITIDA', notificar: false })).body.reserva.importe).toBe(25000);
  });

  // ── Lo que pidió el front al conectar la fase 03 ──
  let nora = { id: '', email: '' };
  let reservaNora = '';

  it('vista previa de la decisión con los datos reales de la familia, sin cambiar nada', async () => {
    nora = await evaluada('Nora');
    const previa = (body: Record<string, unknown>, quien = 'direccion') => request(app).post(`/api/solicitudes/${nora.id}/decision/previsualizar`).set(auth(quien)).send(body);
    const r = await previa({ decision: 'ADMITIDA' });
    expect(r.body).toMatchObject({ para: nora.email, seEnviaria: true });
    expect(r.body.asunto).toMatch(/^Plaza admitida para Nora Fase Tres · reserva antes del /);
    expect(r.body.html).toContain(IBAN);
    expect(r.body.html).toContain('250,00'); // importe de su vía (excepción configurada arriba)
    const espera = await previa({ decision: 'EN_ESPERA', motivo: 'Grupo completo.' }, 'secretaria'); // Secretaría ve Evaluación
    expect(espera.body.html).toContain('posición <strong>2</strong>'); // Berta ya está la 1.ª
    expect((await previa({ decision: 'ADMITIDA' }, 'comercial')).status).toBe(403);
    // Nada ha cambiado.
    expect(await ficha(nora.id)).toMatchObject({ estado: 'ENTREVISTA_REALIZADA', reserva: null });
    const recibida = (await request(app).post('/api/solicitudes').set(auth()).send({
      viaId: viaBach, alumnaNombre: 'Sin', alumnaApellidos: 'Entrevista', tutorNombre: 'Tutor', email: 'sin.entrevista@correo.es',
      telefono: '+34 611 399 999', centroProcedencia: 'IES Bécquer', canal: 'PRESENCIAL', consentimientoPrivacidad: true,
    })).body;
    expect((await request(app).post(`/api/solicitudes/${recibida.id}/decision/previsualizar`).set(auth('direccion')).send({ decision: 'ADMITIDA' })).body.error.code).toBe('TRANSICION_NO_PERMITIDA');
  });

  it('"Recordar": envía ya el recordatorio, no se repite en una hora y el automático ya no sale', async () => {
    reservaNora = (await decidir(nora.id, { decision: 'ADMITIDA', notificar: false })).body.reserva.id;
    const r = await request(app).post(`/api/reservas/${reservaNora}/recordar`).set(auth('secretaria'));
    expect(r.status).toBe(200);
    expect(r.body.recordatorioEnviadoEn).not.toBeNull();
    await enviarCorreos();
    expect(ultimoPara(nora.email).subject).toBe('Recordatorio: la reserva de plaza de Nora Fase Tres');
    expect((await request(app).post(`/api/reservas/${reservaNora}/recordar`).set(auth('administracion'))).body.error.code).toBe('RECORDATORIO_RECIENTE');
    await db.update(reservas).set({ fechaLimite: fechaLocal(sumarDias(new Date(), 2)) }).where(eq(reservas.id, reservaNora));
    expect(await recordatoriosPago(horaLocalAUtc(fechaLocal(new Date()), '12:00'))).toBe(0);
  });

  it('resumen de Cobros: cobrado, pendiente y pagos parciales', async () => {
    // Cobrado: Sara 100 € (el cobro de 200 € está anulado) + Lucas 300 €. Pendiente: Sara 200 €, Daniela 250 €, Nora 250 €.
    const r = await request(app).get('/api/cobros/resumen').set(auth('administracion'));
    expect(r.body).toMatchObject({ cobrado: 40000, pendiente: 70000, reservasPendientes: 3, parcial: { familias: 1, cobrado: 10000, pendiente: 20000 } });
    expect(r.body.cobradoTexto).toBe('400,00 €');
    expect((await request(app).get('/api/cobros/resumen').set(auth('secretaria'))).status).toBe(403);
  });

  it('recibo imprimible: escapa lo que escribe el usuario y marca los anulados', async () => {
    const pago = await cobrar({ solicitudId: nora.id, importe: 25000, metodo: 'EFECTIVO', observaciones: '<script>alert(1)</script>' });
    const r = await request(app).get(`/api/cobros/${pago.body.cobro.id}/recibo`).set(auth('administracion'));
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.text).toContain(pago.body.cobro.reciboNumero);
    expect(r.text).toContain('250,00');
    expect(r.text).toContain('exenta de IVA');
    expect(r.text).toContain('&lt;script&gt;');
    expect(r.text).not.toContain('<script>');
    const anulado = (await request(app).get(`/api/cobros?solicitudId=${sara.id}`).set(auth('administracion'))).body.items.find((c: { anulado: unknown }) => c.anulado);
    expect((await request(app).get(`/api/cobros/${anulado.id}/recibo`).set(auth('administracion'))).text).toContain('RECIBO ANULADO');
    expect((await request(app).get(`/api/cobros/${anulado.id}/recibo`).set(auth('secretaria'))).status).toBe(403);
  });

  it('la ficha y el listado traen la nota de la entrevista', async () => {
    const [item] = (await request(app).get('/api/solicitudes?q=Ana Ruiz').set(auth())).body.items;
    expect(item.entrevista.notas).toBe('Interesada en el bachillerato de Ciencias.');
    expect((await ficha(item.id)).entrevista.notas).toBe('Interesada en el bachillerato de Ciencias.');
  });

  it('migración 0004: las admitidas sin reserva reciben la suya (sin correo) y ya se les puede cobrar', async () => {
    const olga = await evaluada('Olga');
    await db.update(solicitudes).set({ estado: 'ADMITIDA' }).where(eq(solicitudes.id, olga.id)); // como con el PATCH antiguo
    expect((await ficha(olga.id)).siguientes.map((s: { estado: string }) => s.estado)).not.toContain('PLAZA_RESERVADA');
    const correosAntes = buzon.length;
    await db.execute(sql.raw(await readFile('./drizzle/0004_reservas_admitidas_antiguas.sql', 'utf8')));
    const f = await ficha(olga.id);
    expect(f.reserva).toMatchObject({ estado: 'PENDIENTE', importe: 25000, diasRestantes: 15 });
    expect(f.siguientes).toContainEqual({ estado: 'PLAZA_RESERVADA', columna: 'reserva', accion: 'REGISTRAR_COBRO' });
    expect(f.eventos.map((e: { tipo: string }) => e.tipo)).toContain('RESERVA_CREADA');
    await enviarCorreos();
    expect(buzon.length).toBe(correosAntes);
    // Es idempotente: volver a ejecutarla no crea otra.
    await db.execute(sql.raw(await readFile('./drizzle/0004_reservas_admitidas_antiguas.sql', 'utf8')));
    expect((await db.select().from(reservas).where(eq(reservas.solicitudId, olga.id))).length).toBe(1);
  });
});

describe('Cola de correos', () => {
  it('envía en el orden en que se encolaron, también dentro de una misma transacción', async () => {
    await enviarCorreos();
    const para = 'orden.cola@example.com';
    const asuntos = Array.from({ length: 15 }, (_, i) => `Correo ${String(i + 1).padStart(2, '0')}`);
    await db.transaction(async (tx) => {
      for (const asunto of asuntos) {
        await encolarCorreo(tx, { plantilla: 'PRUEBA', para, correo: { asunto, html: `<p>${asunto}</p>`, texto: asunto } });
      }
    });
    await enviarCorreos();
    expect(buzon.filter((m) => m.to === para).map((m) => m.subject)).toEqual(asuntos);
  });

  it('respeta la hora programada aunque se encolaran en otro orden', async () => {
    await enviarCorreos();
    const para = 'orden.programado@example.com';
    const base = Date.now() - 60_000;
    // Se encolan del último al primero: el orden físico de las filas es el inverso al de envío.
    for (let i = 15; i >= 1; i--) {
      const asunto = `Programado ${String(i).padStart(2, '0')}`;
      await db.transaction((tx) =>
        encolarCorreo(tx, { plantilla: 'PRUEBA', para, correo: { asunto, html: `<p>${asunto}</p>`, texto: asunto }, programadoPara: new Date(base + i * 1000) }),
      );
    }
    await enviarCorreos();
    expect(buzon.filter((m) => m.to === para).map((m) => m.subject)).toEqual(
      Array.from({ length: 15 }, (_, i) => `Programado ${String(i + 1).padStart(2, '0')}`),
    );
  });
});

describe('Código de la solicitud por tipo (reunión del 21/10/2026)', () => {
  const alta = (viaId: string, nombre: string) =>
    request(app).post('/api/solicitudes').set(auth()).send({
      viaId, alumnaNombre: nombre, alumnaApellidos: 'Código Prueba', tutorNombre: 'Tutora Prueba',
      email: `${nombre.toLowerCase()}@example.com`, telefono: '+34 600 000 000', canal: 'TELEFONO', consentimientoPrivacidad: true,
    });

  it('B para Bachillerato y C para Ciclos, cada letra con su contador por año', async () => {
    const anio = new Date().getFullYear();
    const [gm] = await db.insert(vias).values({ familia: 'CICLOS_CONCERTADOS_GM', curso: 1, nombre: 'GM concertado 1º', cursoEscolar: '2027-2028', plazas: 20 }).returning();

    const ciclo = await alta(gm!.id, 'Ciclo');
    expect(ciclo.status).toBe(201);
    expect(ciclo.body.codigo).toBe(`C-${anio}-0001`);
    expect((await alta(gm!.id, 'Ciclodos')).body.codigo).toBe(`C-${anio}-0002`);

    // Bachillerato sigue su propia serie: ya hay solicitudes de antes en este fichero.
    const bach = (await alta(viaBach, 'Bachi')).body.codigo as string;
    expect(bach).toMatch(new RegExp(`^B-${anio}-\\d{4}$`));
    expect(bach).not.toBe(`B-${anio}-0001`);
  });
});

describe('Entrevista previa: «¿Ya tuvo entrevista? Sí» (paso 6 del diagrama)', () => {
  let telefono = 0;
  const alta = async (nombre: string, extra: Record<string, unknown> = {}) =>
    (
      await request(app)
        .post('/api/solicitudes')
        .set(auth())
        .send({
          viaId: viaBach, alumnaNombre: nombre, alumnaApellidos: 'Entrevista Previa', tutorNombre: `Familia de ${nombre}`,
          email: `${nombre.toLowerCase()}.previa@example.com`, telefono: `+34 611 400 ${String(++telefono).padStart(3, '0')}`,
          centroProcedencia: 'IES Previa', canal: 'PRESENCIAL', consentimientoPrivacidad: true, ...extra,
        })
    ).body.id as string;
  const previa = (id: string, body: Record<string, unknown>) =>
    request(app).post(`/api/solicitudes/${id}/entrevista-previa`).set(auth()).send(body);
  const ficha = async (id: string) => (await request(app).get(`/api/solicitudes/${id}`).set(auth('direccion'))).body;
  const ayer = fechaLocal(sumarDias(new Date(), -1));

  it('se registra sin cita y la solicitud pasa directa a decisión', async () => {
    const id = await alta('Previa');
    expect((await ficha(id)).siguientes).toContainEqual({ estado: 'ENTREVISTA_REALIZADA', columna: 'evaluada', accion: 'REGISTRAR_ENTREVISTA_PREVIA' });

    const r = await previa(id, { fecha: ayer, notas: 'Entrevistada en las jornadas de puertas abiertas.' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ estado: 'ENTREVISTA_REALIZADA', entrevista: { estado: 'REALIZADA', notas: 'Entrevistada en las jornadas de puertas abiertas.' } });

    const f = await ficha(id);
    expect(f.estado).toBe('ENTREVISTA_REALIZADA');
    expect(f.eventos.map((e: { tipo: string }) => e.tipo)).toContain('ENTREVISTA_PREVIA');
    expect(f.siguientes.map((s: { accion?: string }) => s.accion)).toContain('DECIDIR');

    // En el calendario consta como realizada, sin ocupar la agenda.
    const cal = (await request(app).get(`/api/entrevistas?desde=${ayer}&hasta=${ayer}`).set(auth())).body;
    expect(cal.items.find((e: { solicitud: { id: string } }) => e.solicitud.id === id)).toMatchObject({
      estado: 'REALIZADA',
      lugar: 'Entrevista previa (registrada sin cita)',
    });
  });

  it('anula las fechas que se le habían propuesto y las devuelve a la agenda', async () => {
    const id = await alta('Propuesta');
    expect((await request(app).post(`/api/solicitudes/${id}/citar`).set(auth()).send({ inicios: [iso(dia(9), '10:00')], duracion: 45 })).status).toBe(201);
    expect((await previa(id, { fecha: ayer })).status).toBe(201);
    const disp = (await request(app).get(`/api/agenda/disponibilidad?desde=${dia(9)}&hasta=${dia(9)}&duracion=45`).set(auth())).body;
    expect(disp.dias[0].huecos.find((h: { hora: string }) => h.hora === '10:00')).toMatchObject({ disponible: true });
  });

  it('nunca con fecha futura, ni incompleta, ni con la entrevista ya programada', async () => {
    const id = await alta('Futura');
    expect((await previa(id, { fecha: fechaLocal(sumarDias(new Date(), 2)) })).body.error.code).toBe('FECHA_FUTURA');

    const incompleta = await alta('Incompleta', { centroProcedencia: undefined });
    expect((await previa(incompleta, { fecha: ayer })).body.error.code).toBe('SOLICITUD_INCOMPLETA');

    await db.update(solicitudes).set({ estado: 'ENTREVISTA_PROGRAMADA' }).where(eq(solicitudes.id, id));
    expect((await previa(id, { fecha: ayer })).body.error.code).toBe('ESTADO_NO_PERMITE');
  });
});

describe('La familia cancela su cita desde el enlace (reunión del 21/10/2026)', () => {
  let telefono = 0;
  const email = (nombre: string) => `${nombre.toLowerCase()}.cancela@example.com`;
  /** Solicitud con la cita ya elegida por la familia: devuelve su id y el token del enlace. */
  async function conCita(nombre: string, dias: number) {
    const id = (
      await request(app)
        .post('/api/solicitudes')
        .set(auth())
        .send({
          viaId: viaBach, alumnaNombre: nombre, alumnaApellidos: 'Cancela Cita', tutorNombre: `Familia de ${nombre}`, email: email(nombre),
          telefono: `+34 611 500 ${String(++telefono).padStart(3, '0')}`, centroProcedencia: 'IES Cancela', canal: 'PRESENCIAL', consentimientoPrivacidad: true,
        })
    ).body.id as string;
    const cita = await request(app).post(`/api/solicitudes/${id}/citar`).set(auth()).send({ inicios: [iso(dia(dias), '09:00')], duracion: 45 });
    expect(cita.status).toBe(201);
    await enviarCorreos();
    const token = tokenDe(ultimoPara(email(nombre)).text, '/cita');
    const pagina = await request(app).get(`/api/public/citas/${token}`);
    expect((await request(app).post(`/api/public/citas/${token}/elegir`).send({ huecoId: pagina.body.slots[0].id })).status).toBe(200);
    return { id, token };
  }

  it('libera la hora, vuelve a revisión y avisa a secretaría', async () => {
    const { id, token } = await conCita('Irene', 11);
    expect((await request(app).get(`/api/public/citas/${token}`)).body).toMatchObject({ estado: 'elegida', puedeCancelar: true });
    await enviarCorreos();

    const r = await request(app).post(`/api/public/citas/${token}/cancelar`).send({ motivo: 'Coincide con un viaje familiar.' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'cancelada', puedeCancelar: false, puedeCambiar: false });
    expect(r.body.slots.every((s: { disponible: boolean }) => !s.disponible)).toBe(true);

    // La solicitud vuelve a la bandeja para proponer otras fechas y la hora queda libre.
    const ficha = (await request(app).get(`/api/solicitudes/${id}`).set(auth())).body;
    expect(ficha.estado).toBe('EN_REVISION');
    expect(ficha.eventos.map((e: { tipo: string }) => e.tipo)).toContain('CITA_CANCELADA_FAMILIA');
    const disp = (await request(app).get(`/api/agenda/disponibilidad?desde=${dia(11)}&hasta=${dia(11)}&duracion=45`).set(auth())).body;
    expect(disp.dias[0].huecos.find((h: { hora: string }) => h.hora === '09:00')).toMatchObject({ disponible: true });

    // Aviso en la bandeja, con la cita que era.
    const avisos = (await request(app).get('/api/solicitudes/respuestas-familia').set(auth())).body.items;
    expect(avisos.find((a: { solicitud: { id: string } }) => a.solicitud.id === id)).toMatchObject({
      tipo: 'CITA_CANCELADA_FAMILIA',
      solicitud: { estado: 'EN_REVISION' },
      cita: { franja: '09:00 – 09:45' },
    });

    // Correo a secretaría con el motivo, y a la familia con la anulación para su calendario.
    await enviarCorreos();
    const aviso = ultimoPara('secretaria@albaydar.org');
    expect(aviso.subject).toMatch(/^La familia de Irene Cancela Cita cancela la entrevista · /);
    expect(aviso.text).toContain('Coincide con un viaje familiar.');
    const familia = ultimoPara(email('Irene'));
    expect(familia.subject).toMatch(/^Entrevista anulada: /);
    expect(familia.attachments.some((a) => a.filename.endsWith('.ics'))).toBe(true);
    // Si la familia responde a cualquier correo, le llega a secretaría.
    expect(familia.replyTo).toBe('secretaria@albaydar.org');
  });

  it('después de cancelar no se puede volver a elegir ni a cancelar', async () => {
    const { token } = await conCita('Julia', 14); // lunes
    expect((await request(app).post(`/api/public/citas/${token}/cancelar`).send({})).status).toBe(200);
    const pagina = await request(app).get(`/api/public/citas/${token}`);
    expect(pagina.status).toBe(200);
    expect((await request(app).post(`/api/public/citas/${token}/elegir`).send({ huecoId: pagina.body.slots[0].id })).body.error.code).toBe('CITA_CANCELADA');
    expect((await request(app).post(`/api/public/citas/${token}/otra-franja`).send({ franja: 'Por la tarde' })).body.error.code).toBe('CITA_CANCELADA');
    expect((await request(app).post(`/api/public/citas/${token}/cancelar`).send({})).body.error.code).toBe('CITA_CANCELADA');
  });

  it('sin fecha elegida no hay nada que cancelar', async () => {
    const id = (
      await request(app)
        .post('/api/solicitudes')
        .set(auth())
        .send({
          viaId: viaBach, alumnaNombre: 'Karen', alumnaApellidos: 'Cancela Cita', tutorNombre: 'Familia de Karen', email: email('Karen'),
          telefono: '+34 611 500 900', centroProcedencia: 'IES Cancela', canal: 'PRESENCIAL', consentimientoPrivacidad: true,
        })
    ).body.id as string;
    await request(app).post(`/api/solicitudes/${id}/citar`).set(auth()).send({ inicios: [iso(dia(15), '09:00')], duracion: 45 }); // martes
    await enviarCorreos();
    const token = tokenDe(ultimoPara(email('Karen')).text, '/cita');
    expect((await request(app).get(`/api/public/citas/${token}`)).body.puedeCancelar).toBe(false);
    expect((await request(app).post(`/api/public/citas/${token}/cancelar`).send({})).body.error.code).toBe('SIN_CITA_CONFIRMADA');
  });
});
