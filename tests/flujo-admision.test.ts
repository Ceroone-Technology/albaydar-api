/**
 * Recorre por HTTP el flujo completo de la primera parte de la admisión,
 * contra PostgreSQL real y con un SMTP falso que captura los correos.
 *
 *  familia envía solicitud → acuse → secretaría revisa → pide que complete →
 *  familia completa → secretaría genera agenda y cita (3 huecos) → familia elige →
 *  .ics + entrevista en calendario → cambia la fecha → sube notas → pide otra franja →
 *  recordatorio a los 3 días → recordatorio el día antes
 */
import { rm } from 'node:fs/promises';
import type { Transporter } from 'nodemailer';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { crearApp } from '../src/app';
import { db, pool } from '../src/lib/db';
import { correosSalientes, entrevistas, huecosAgenda, propuestasCita, usuarios, vias } from '../src/db/schema';
import { procesarOutbox, setTransporter } from '../src/correo/outbox';
import { recordatoriosEntrevista, recordatoriosPropuesta } from '../src/jobs/recordatorios';
import { hashPassword } from '../src/modules/auth/auth.service';
import { fechaLocal, sumarDias } from '../src/lib/fechas';

const app = crearApp();
const ORIGIN = 'http://localhost:4200';
type Mail = { to: string; subject: string; text: string; attachments: { filename: string; content: Buffer }[] };
const buzon: Mail[] = [];

async function enviarCorreos() {
  await procesarOutbox(100);
}
const ultimoPara = (to: string) => [...buzon].reverse().find((m) => m.to === to)!;
const tokenDe = (texto: string, ruta: string) => {
  const m = texto.match(new RegExp(`${ruta}/([A-Za-z0-9_-]{20,})`));
  if (!m) throw new Error(`No hay enlace ${ruta} en el correo`);
  return m[1]!;
};

let access = '';
let viaBach = '';
const auth = () => ({ Authorization: `Bearer ${access}` });

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await migrate(db, { migrationsFolder: './drizzle' });
  await db.insert(usuarios).values([
    { email: 'maria.reyes@albaydar.org', nombre: 'María Reyes', roles: ['SECRETARIA'], passwordHash: await hashPassword('Albaydar-2026') },
    { email: 'administracion@albaydar.org', nombre: 'Administración', roles: ['ADMINISTRACION'], passwordHash: await hashPassword('Albaydar-2026') },
  ]);
  const [v] = await db.insert(vias).values({ familia: 'BACHILLERATO', curso: 1, nombre: '1º Bachillerato', cursoEscolar: '2027-2028', plazas: 6 }).returning();
  viaBach = v!.id;

  // SMTP falso: guarda los mensajes en memoria.
  setTransporter({
    sendMail: async (m: Record<string, unknown>) => {
      buzon.push({
        to: String(m.to),
        subject: String(m.subject),
        text: String(m.text),
        attachments: ((m.attachments as { filename: string; content: Buffer }[]) ?? []).map((a) => ({ filename: a.filename, content: a.content })),
      });
      return { messageId: String(buzon.length) };
    },
  } as unknown as Transporter);
});

afterAll(async () => {
  setTransporter(null);
  await rm('./storage/test-uploads', { recursive: true, force: true });
  await pool.end();
});

describe('Autenticación', () => {
  let cookie = '';

  it('rechaza credenciales incorrectas sin decir si el correo existe', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'maria.reyes@albaydar.org', password: 'mal' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('CREDENCIALES_INVALIDAS');
    const r2 = await request(app).post('/api/auth/login').send({ email: 'nadie@albaydar.org', password: 'mal' });
    expect(r2.body.error.code).toBe('CREDENCIALES_INVALIDAS');
  });

  it('login devuelve access token y cookie httpOnly', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'Maria.Reyes@albaydar.org', password: 'Albaydar-2026' });
    expect(r.status).toBe(200);
    expect(r.body.usuario.roles).toEqual(['SECRETARIA']);
    access = r.body.accessToken;
    cookie = r.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/alb_rt=.*HttpOnly/);
  });

  it('sin token no se accede a rutas privadas', async () => {
    expect((await request(app).get('/api/solicitudes')).status).toBe(401);
  });

  it('refresh rota el token y detecta su reutilización', async () => {
    const r1 = await request(app).post('/api/auth/refresh').set('Origin', ORIGIN).set('Cookie', cookie);
    expect(r1.status).toBe(200);
    const nueva = r1.headers['set-cookie']![0]!;
    // Reutilizar la cookie vieja = posible robo → se cierra toda la sesión.
    const r2 = await request(app).post('/api/auth/refresh').set('Origin', ORIGIN).set('Cookie', cookie);
    expect(r2.body.error.code).toBe('SESION_REVOCADA');
    const r3 = await request(app).post('/api/auth/refresh').set('Origin', ORIGIN).set('Cookie', nueva);
    expect(r3.status).toBe(401);
  });

  it('refresh desde otro origen se rechaza (CSRF)', async () => {
    const r = await request(app).post('/api/auth/refresh').set('Origin', 'https://malo.example').set('Cookie', cookie);
    expect(r.status).toBe(403);
  });

  it('vuelve a iniciar sesión para el resto del flujo', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'maria.reyes@albaydar.org', password: 'Albaydar-2026' });
    access = r.body.accessToken;
  });
});

describe('Flujo de admisión y citación', () => {
  let solicitudId = '';
  let codigo = '';
  let tokenCita = '';
  let huecos: { id: string; inicio: string }[] = [];

  it('el formulario público lista las vías en dos niveles', async () => {
    const r = await request(app).get('/api/public/vias');
    expect(r.body.familias[0]).toMatchObject({ familia: 'BACHILLERATO', etiqueta: 'Bachillerato', cursos: [{ curso: 1, viaId: viaBach }] });
  });

  it('rechaza bots (honeypot) y exige consentimiento', async () => {
    const base = { viaId: viaBach, alumnaNombre: 'X', alumnaApellidos: 'Y', tutorNombre: 'Z', email: 'z@correo.es', telefono: '+34 600 000 000' };
    expect((await request(app).post('/api/public/solicitudes').send({ ...base, consentimientoPrivacidad: true, website: 'spam' })).status).toBe(400);
    expect((await request(app).post('/api/public/solicitudes').send({ ...base, consentimientoPrivacidad: false })).status).toBe(400);
  });

  it('la familia envía la solicitud (sin centro de procedencia) y recibe acuse', async () => {
    const r = await request(app).post('/api/public/solicitudes').send({
      viaId: viaBach,
      alumnaNombre: 'Lucía',
      alumnaApellidos: 'Márquez Peña',
      tutorNombre: 'Elena Peña Ríos',
      email: 'EPena@correo.es',
      telefono: '+34 622 418 903',
      modalidadInteres: 'Ciencias',
      consentimientoPrivacidad: true,
    });
    expect(r.status).toBe(201);
    codigo = r.body.codigo;
    expect(codigo).toMatch(/^SOL-\d{4}-0001$/);
    await enviarCorreos();
    expect(ultimoPara('epena@correo.es').subject).toContain(codigo);
  });

  it('aparece en la bandeja como "Solicitud recibida"', async () => {
    const r = await request(app).get('/api/solicitudes?vista=bandeja').set(auth());
    expect(r.body.total).toBe(1);
    const s = r.body.items[0];
    solicitudId = s.id;
    expect(s).toMatchObject({ estado: 'RECIBIDA', estadoEtiqueta: 'Solicitud recibida', origen: 'Solicitud web', alumna: 'Lucía Márquez Peña' });
  });

  it('revisar: cinco comprobaciones; falta el centro de procedencia', async () => {
    const r = await request(app).post(`/api/solicitudes/${solicitudId}/revisar`).set(auth());
    expect(r.body.checks).toHaveLength(5);
    expect(r.body.faltan).toEqual(['Centro de procedencia']);
    expect(r.body.puedeCitar).toBe(false);
  });

  it('asigna responsable y observaciones internas', async () => {
    const [maria] = await db.select().from(usuarios).where(eq(usuarios.email, 'maria.reyes@albaydar.org'));
    const r = await request(app).patch(`/api/solicitudes/${solicitudId}`).set(auth()).send({ responsableId: maria!.id, observacionesInternas: 'Llamar si no completa.' });
    expect(r.status).toBe(200);
  });

  it('no deja citar una solicitud incompleta', async () => {
    const r = await request(app).post(`/api/solicitudes/${solicitudId}/citar`).set(auth()).send({ huecoIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SOLICITUD_INCOMPLETA');
  });

  it('"Pedir que complete" envía enlace; la familia completa desde él', async () => {
    const r = await request(app).post(`/api/solicitudes/${solicitudId}/pedir-completar`).set(auth()).send({ mensaje: 'Indícanos el centro actual.' });
    expect(r.body.campos).toEqual(['Centro de procedencia']);
    await enviarCorreos();
    const token = tokenDe(ultimoPara('epena@correo.es').text, '/solicitud/completar');

    const ver = await request(app).get(`/api/public/solicitudes/completar/${token}`);
    expect(ver.body.camposPendientes).toEqual(['Centro de procedencia']);

    const env = await request(app).patch(`/api/public/solicitudes/completar/${token}`).send({ centroProcedencia: 'IES Martínez Montañés' });
    expect(env.body.completa).toBe(true);
    // El enlace es de un solo uso.
    expect((await request(app).get(`/api/public/solicitudes/completar/${token}`)).status).toBe(410);
  });

  it('secretaría genera la agenda del equipo directivo', async () => {
    const lunes = sumarDias(new Date(), 8 - (new Date().getDay() || 7));
    const desde = fechaLocal(lunes);
    const hasta = fechaLocal(sumarDias(lunes, 4));
    const g = await request(app).post('/api/agenda/huecos/generar').set(auth()).send({ desde, hasta });
    expect(g.body.creados).toBe(20); // 5 días × 4 franjas del mockup
    const again = await request(app).post('/api/agenda/huecos/generar').set(auth()).send({ desde, hasta });
    expect(again.body).toEqual({ creados: 0, existentes: 20 });
    const l = await request(app).get(`/api/agenda/huecos?desde=${desde}&hasta=${hasta}`).set(auth());
    huecos = l.body.items;
    expect(huecos[0]).toMatchObject({ estado: 'LIBRE', seleccionable: true, lugar: 'Sala de reuniones de Dirección', franja: '09:00 – 09:45' });
  });

  it('no deja proponer más de 3 huecos', async () => {
    const r = await request(app).post(`/api/solicitudes/${solicitudId}/citar`).set(auth()).send({ huecoIds: huecos.slice(0, 4).map((h) => h.id) });
    expect(r.status).toBe(400);
  });

  it('administración no puede citar (roles)', async () => {
    const l = await request(app).post('/api/auth/login').send({ email: 'administracion@albaydar.org', password: 'Albaydar-2026' });
    const r = await request(app).post(`/api/solicitudes/${solicitudId}/citar`).set({ Authorization: `Bearer ${l.body.accessToken}` }).send({ huecoIds: [huecos[0]!.id] });
    expect(r.status).toBe(403);
  });

  it('"Citar a entrevista" con 3 huecos: correo con enlace único', async () => {
    const r = await request(app).post(`/api/solicitudes/${solicitudId}/citar`).set(auth()).send({ huecoIds: [huecos[1]!.id, huecos[6]!.id, huecos[11]!.id] });
    expect(r.status).toBe(201);
    expect(r.body.huecos).toHaveLength(3);
    await enviarCorreos();
    const m = ultimoPara('epena@correo.es');
    expect(m.subject).toContain('Elige la fecha de la entrevista');
    tokenCita = tokenDe(m.text, '/cita');
  });

  it('el kanban no deja arrastrar a "Entrevista programada" sin la acción', async () => {
    const r = await request(app).patch(`/api/solicitudes/${solicitudId}/estado`).set(auth()).send({ estado: 'ENTREVISTA_PROGRAMADA' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'ACCION_REQUERIDA', details: { accion: 'CITAR_A_ENTREVISTA' } });
    const p = await request(app).get('/api/solicitudes/pipeline').set(auth());
    expect(p.body.columnas.find((c: { id: string }) => c.id === 'entrevista').total).toBe(1);
  });

  it('la página de cita muestra los datos del mockup', async () => {
    const r = await request(app).get(`/api/public/citas/${tokenCita}`);
    expect(r.body).toMatchObject({ ref: codigo, tutor: 'Elena', alumno: 'Lucía Márquez Peña', curso: 'Bachillerato 1º', estado: 'propuesta' });
    expect(r.body.info).toEqual([
      { k: 'Tipo', v: 'Presencial' },
      { k: 'Con', v: 'Equipo directivo' },
      { k: 'Lugar', v: 'Sala de reuniones de Dirección · Avda. de la Palmera, 36' },
    ]);
    expect(r.body.slots).toHaveLength(3);
    expect(r.body.slots[0].disponible).toBe(true);
  });

  it('dos familias eligen el mismo hueco a la vez: solo una lo consigue', async () => {
    // Segunda solicitud, completa, citada con el mismo hueco.
    const s2 = await request(app).post('/api/public/solicitudes').send({
      viaId: viaBach, alumnaNombre: 'Paula', alumnaApellidos: 'Gil Romero', tutorNombre: 'Marta Romero Vela',
      email: 'mromero@correo.es', telefono: '+34 687 330 128', centroProcedencia: 'Colegio Portaceli', consentimientoPrivacidad: true,
    });
    const lista = await request(app).get('/api/solicitudes?q=Paula').set(auth());
    await request(app).post(`/api/solicitudes/${lista.body.items[0].id}/citar`).set(auth()).send({ huecoIds: [huecos[1]!.id] });
    await enviarCorreos();
    const token2 = tokenDe(ultimoPara('mromero@correo.es').text, '/cita');
    expect(s2.status).toBe(201);

    const [a, b] = await Promise.all([
      request(app).post(`/api/public/citas/${tokenCita}/elegir`).send({ huecoId: huecos[1]!.id }),
      request(app).post(`/api/public/citas/${token2}/elegir`).send({ huecoId: huecos[1]!.id }),
    ]);
    const estados = [a.status, b.status].sort();
    expect(estados).toEqual([200, 409]);
    const perdedora = a.status === 409 ? a : b;
    expect(perdedora.body.error.code).toBe('HUECO_NO_DISPONIBLE');
    // Si ganó la otra familia, la nuestra elige otro hueco para seguir el test.
    if (a.status === 409) expect((await request(app).post(`/api/public/citas/${tokenCita}/elegir`).send({ huecoId: huecos[6]!.id })).status).toBe(200);
  });

  it('confirmada: correo con .ics, entrevista en el calendario y hueco ocupado', async () => {
    await enviarCorreos();
    const m = ultimoPara('epena@correo.es');
    expect(m.subject).toMatch(/^Cita confirmada/);
    expect(m.attachments[0]!.filename).toBe('entrevista-albaydar.ics');
    expect(m.attachments[0]!.content.toString()).toContain('BEGIN:VEVENT');

    const det = await request(app).get(`/api/solicitudes/${solicitudId}`).set(auth());
    expect(det.body.estado).toBe('ENTREVISTA_PROGRAMADA');
    expect(det.body.columna).toBe('entrevista');
    const huecoElegido = det.body.entrevista.huecoId;

    const desde = fechaLocal(new Date(huecos[0]!.inicio));
    const hasta = fechaLocal(sumarDias(new Date(huecos[0]!.inicio), 6));
    const cal = await request(app).get(`/api/entrevistas?desde=${desde}&hasta=${hasta}`).set(auth());
    const mia = cal.body.items.find((e: { solicitud: { id: string } }) => e.solicitud.id === solicitudId);
    expect(mia).toMatchObject({ estadoEtiqueta: 'Confirmada', con: 'Equipo directivo', lugar: 'Sala de reuniones de Dirección', notasRecibidas: false });

    const ag = await request(app).get(`/api/agenda/huecos?desde=${desde}&hasta=${hasta}`).set(auth());
    expect(ag.body.items.find((h: { id: string }) => h.id === huecoElegido)).toMatchObject({ estado: 'OCUPADO', seleccionable: false });
  });

  it('la familia cambia la elección: se libera el hueco anterior', async () => {
    const antes = await request(app).get(`/api/public/citas/${tokenCita}`);
    const actual = antes.body.slots.find((s: { elegido: boolean }) => s.elegido);
    const otro = antes.body.slots.find((s: { elegido: boolean; disponible: boolean }) => !s.elegido && s.disponible);
    const r = await request(app).post(`/api/public/citas/${tokenCita}/elegir`).send({ huecoId: otro.id });
    expect(r.body.cambio).toBe(true);
    const [h] = await db.select().from(huecosAgenda).where(eq(huecosAgenda.id, actual.id));
    expect(h!.estado).toBe('LIBRE');
    const [e] = await db.select().from(entrevistas).where(eq(entrevistas.solicitudId, solicitudId));
    expect(e).toMatchObject({ estado: 'REPROGRAMADA', secuenciaIcs: 1 });
    await enviarCorreos();
    expect(ultimoPara('epena@correo.es').subject).toMatch(/^Cita actualizada/);
  });

  it('sube el boletín de notas (y rechaza ficheros que no son PDF/imagen)', async () => {
    const malo = await request(app).post(`/api/public/citas/${tokenCita}/notas`).attach('archivo', Buffer.from('MZ\x90\x00'), 'virus.pdf');
    expect(malo.status).toBe(400);
    const ok = await request(app).post(`/api/public/citas/${tokenCita}/notas`).attach('archivo', Buffer.from('%PDF-1.7\n%prueba\n'), 'boletin-notas.pdf');
    expect(ok.status).toBe(201);
    const v = await request(app).get(`/api/public/citas/${tokenCita}`);
    expect(v.body.notas.nombre).toBe('boletin-notas.pdf');
    const det = await request(app).get(`/api/solicitudes/${solicitudId}`).set(auth());
    const doc = await request(app).get(`/api/solicitudes/${solicitudId}/documentos/${det.body.documentos[0].id}`).set(auth());
    expect(doc.headers['content-type']).toBe('application/pdf');
  });

  it('el día antes se envía el recordatorio de la entrevista', async () => {
    const [e] = await db.select().from(entrevistas).where(eq(entrevistas.solicitudId, solicitudId));
    const ahora = sumarDias(e!.inicio, -1); // misma hora, el día anterior (después de las 10:00)
    expect(await recordatoriosEntrevista(ahora)).toBe(1);
    expect(await recordatoriosEntrevista(ahora)).toBe(0); // no se repite
    await enviarCorreos();
    expect(ultimoPara('epena@correo.es').subject).toMatch(/^Mañana: entrevista/);
  });

  it('"Ninguna me encaja": libera el hueco, avisa a secretaría y anula en el calendario', async () => {
    const r = await request(app).post(`/api/public/citas/${tokenCita}/otra-franja`).send({ franja: 'Martes o jueves a partir de las 17:00', prefiereLlamada: true });
    expect(r.body.estado).toBe('alternativa');
    const det = await request(app).get(`/api/solicitudes/${solicitudId}`).set(auth());
    expect(det.body.estado).toBe('OTRA_FRANJA_SOLICITADA');
    expect(det.body.entrevista).toBeNull();
    await enviarCorreos();
    expect(ultimoPara('secretaria@albaydar.org').text).toContain('Prefiere que la llamen');
    expect(ultimoPara('epena@correo.es').attachments[0]!.content.toString()).toContain('METHOD:CANCEL');
  });

  it('"Proponer nuevas fechas" invalida el enlace anterior', async () => {
    const libres = (await request(app).get(`/api/agenda/huecos?desde=${fechaLocal(new Date(huecos[0]!.inicio))}&hasta=${fechaLocal(new Date(huecos[19]!.inicio))}`).set(auth())).body.items.filter((h: { seleccionable: boolean }) => h.seleccionable);
    const r = await request(app).post(`/api/solicitudes/${solicitudId}/citar`).set(auth()).send({ huecoIds: [libres[0].id, libres[1].id] });
    expect(r.status).toBe(201);
    const viejo = await request(app).get(`/api/public/citas/${tokenCita}`);
    expect(viejo.status).toBe(410);
    expect(viejo.body.error.code).toBe('PROPUESTA_SUSTITUIDA');
    await enviarCorreos();
    tokenCita = tokenDe(ultimoPara('epena@correo.es').text, '/cita');
  });

  it('sin respuesta en 3 días: un único recordatorio con enlace válido', async () => {
    await db.update(propuestasCita).set({ createdAt: sumarDias(new Date(), -4) }).where(eq(propuestasCita.estado, 'PENDIENTE'));
    const n = await recordatoriosPropuesta();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await recordatoriosPropuesta()).toBe(0);
    await enviarCorreos();
    const m = ultimoPara('epena@correo.es');
    expect(m.subject).toMatch(/^Recordatorio: elige la fecha/);
    const t = tokenDe(m.text, '/cita');
    expect((await request(app).get(`/api/public/citas/${t}`)).status).toBe(200);
  });

  it('historial y trazabilidad de correos en la ficha', async () => {
    const det = await request(app).get(`/api/solicitudes/${solicitudId}`).set(auth());
    const tipos = det.body.eventos.map((e: { tipo: string }) => e.tipo);
    for (const t of ['CREADA', 'REVISADA', 'COMPLETAR_SOLICITADO', 'COMPLETADA_POR_FAMILIA', 'CITACION_ENVIADA', 'CITA_CONFIRMADA', 'CITA_CAMBIADA', 'NOTAS_SUBIDAS', 'OTRA_FRANJA_SOLICITADA', 'RECORDATORIO_CITACION']) {
      expect(tipos).toContain(t);
    }
    expect(det.body.correos.every((c: { estado: string }) => c.estado === 'ENVIADO')).toBe(true);
    const pendientes = await db.select().from(correosSalientes).where(eq(correosSalientes.estado, 'PENDIENTE'));
    expect(pendientes).toHaveLength(0);
  });
});

