/**
 * Recorre por HTTP el flujo de admisión contra PostgreSQL real, con un SMTP falso.
 *
 *  roles y permisos → solicitud web → alta telefónica incompleta → pedir que complete →
 *  agenda por jornada → citar (fechas RESERVADAS) → la familia elige (las otras se liberan) →
 *  cambio dentro de 24 h / bloqueado después → notas → recordatorios con plantillas HTML →
 *  ninguna me encaja → nuevas fechas → plantillas editables (CRUD, borrador, prueba, histórico)
 */
import { rm } from 'node:fs/promises';
import type { Transporter } from 'nodemailer';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { crearApp } from '../src/app';
import { db, pool } from '../src/lib/db';
import { correosSalientes, entrevistas, franjasAgenda, propuestasCita, usuarios, vias } from '../src/db/schema';
import { sembrarBase } from '../src/db/datos-base';
import { procesarOutbox, setTransporter } from '../src/correo/outbox';
import { recordatoriosEntrevista, recordatoriosPropuesta } from '../src/jobs/recordatorios';
import { hashPassword } from '../src/modules/auth/auth.service';
import { invalidarCachePermisos } from '../src/modules/permisos/permisos.service';
import { fechaLocal, horaLocalAUtc, sumarDias } from '../src/lib/fechas';

const app = crearApp();
const ORIGIN = 'http://localhost:4200';
const PASS = 'Albaydar-2026';
type Mail = { to: string; subject: string; text: string; html: string; attachments: { filename: string; content: Buffer }[] };
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

  it('lista una plantilla por evento, con las del mockup en borrador', async () => {
    const r = await request(app).get('/api/comunicaciones/plantillas').set(auth());
    const porEvento = Object.fromEntries(r.body.items.map((p: { evento: string; estado: string }) => [p.evento, p.estado]));
    expect(porEvento).toMatchObject({ CITA_CONFIRMADA: 'ACTIVADA', CITACION_RECORDATORIO: 'ACTIVADA', ENTREVISTA_RECORDATORIO: 'ACTIVADA', ADMITIDA: 'BORRADOR', RECORDATORIO_PAGO: 'BORRADOR' });
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
