/**
 * Matrícula digital, primera entrega (docs/matricula.md): apertura desde el expediente,
 * borrador con versión, páginas leídas, enlaces de la familia y renovación 1º → 2º.
 * Por HTTP contra PostgreSQL real, con un SMTP falso.
 */
import type { Transporter } from 'nodemailer';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { crearApp } from '../src/app';
import { db, pool } from '../src/lib/db';
import { matriculas, solicitudes, usuarios, vias } from '../src/db/schema';
import { sembrarBase } from '../src/db/datos-base';
import { procesarOutbox, setTransporter } from '../src/correo/outbox';
import { hashPassword } from '../src/modules/auth/auth.service';
import { invalidarCachePermisos } from '../src/modules/permisos/permisos.service';

const app = crearApp();
const PASS = 'Albaydar-2026';
type Mail = { to: string; subject: string; html: string };
const buzon: Mail[] = [];
const tokens: Record<string, string> = {};
const auth = (quien = 'secretaria') => ({ Authorization: `Bearer ${tokens[quien]}` });
let viaBach = '';

const enviarCorreos = () => procesarOutbox(100);
const tokenDe = (html: string) => {
  const m = html.match(/\/matricula\/([A-Za-z0-9_-]{20,})/);
  if (!m) throw new Error('No hay enlace de matrícula en el correo');
  return m[1]!;
};

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await migrate(db, { migrationsFolder: './drizzle' });
  await sembrarBase(db);
  invalidarCachePermisos();
  const h = await hashPassword(PASS);
  await db.insert(usuarios).values([
    { email: 'direccion@albaydar.org', nombre: 'Equipo directivo', roles: ['DIRECCION'], passwordHash: h },
    { email: 'maria.reyes@albaydar.org', nombre: 'María Reyes', roles: ['SECRETARIA'], passwordHash: h },
    { email: 'administracion@albaydar.org', nombre: 'Administración', roles: ['ADMINISTRACION'], passwordHash: h },
    { email: 'comercial@albaydar.org', nombre: 'Promoción', roles: ['COMERCIAL'], passwordHash: h },
  ]);
  const [v] = await db.insert(vias).values({ familia: 'BACHILLERATO', curso: 1, nombre: '1º Bachillerato', cursoEscolar: '2027-2028', plazas: 20 }).returning();
  viaBach = v!.id;
  for (const [quien, email] of [
    ['direccion', 'direccion@albaydar.org'],
    ['secretaria', 'maria.reyes@albaydar.org'],
    ['administracion', 'administracion@albaydar.org'],
    ['comercial', 'comercial@albaydar.org'],
  ] as const) {
    const r = await request(app).post('/api/auth/login').send({ email, password: PASS });
    tokens[quien] = r.body.accessToken;
  }
  setTransporter({
    sendMail: async (m: Record<string, unknown>) => {
      buzon.push({ to: String(m.to), subject: String(m.subject), html: String(m.html) });
      return { messageId: String(buzon.length) };
    },
    verify: async () => true,
  } as unknown as Transporter);
});

afterAll(async () => {
  setTransporter(null);
  await pool.end();
});

/** Solicitud admitida y pagada: el expediente queda en «Reserva confirmada». */
async function reservaPagada(nombre: string) {
  const email = `${nombre.toLowerCase()}.matricula@example.com`;
  const r = await request(app).post('/api/solicitudes').set(auth()).send({
    viaId: viaBach, alumnaNombre: nombre, alumnaApellidos: 'Matrícula Prueba', tutorNombre: `Elena Tutora de ${nombre}`, email,
    telefono: `+34 622 100 ${String(buzon.length).padStart(3, '0')}`, centroProcedencia: 'IES Bécquer', canal: 'PRESENCIAL', consentimientoPrivacidad: true,
  });
  await db.update(solicitudes).set({ estado: 'ENTREVISTA_REALIZADA' }).where(eq(solicitudes.id, r.body.id));
  expect((await request(app).post(`/api/solicitudes/${r.body.id}/decision`).set(auth('direccion')).send({ decision: 'ADMITIDA' })).status).toBe(200);
  const { pendiente } = (await request(app).get(`/api/solicitudes/${r.body.id}`).set(auth('direccion'))).body.reserva;
  const c = await request(app).post('/api/cobros').set(auth('administracion')).send({ solicitudId: r.body.id, importe: pendiente, metodo: 'TRANSFERENCIA', notificar: false });
  expect(c.body.reserva.estado).toBe('PAGADA');
  const a = (await request(app).get(`/api/alumnado?q=${nombre}`).set(auth())).body.items[0];
  return { solicitudId: r.body.id as string, codigo: r.body.codigo as string, email, alumnaId: a.id as string };
}

let dni = 30_000_000;
const nuevoDni = () => `${++dni}${'TRWAGMYFPDXBNJZSQVHLCKE'[dni % 23]}`;

const alta = async (nombre: string, extra: Record<string, unknown>) => {
  const r = await request(app).post('/api/alumnado').set(auth()).send({
    nombre, apellidos: 'Renovación Prueba', documento: nuevoDni(), fechaNacimiento: '2010-05-05', familia: 'BACHILLERATO', curso: 1, cursoEscolar: '2026-2027', estado: 'MATRICULADA',
    contactos: [{ parentesco: 'Madre', nombre: `Madre de ${nombre}`, telefono: '+34 699 000 111', email: `madre.${nombre.toLowerCase()}@example.com` }],
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
};

const ficha = async (id: string) => (await request(app).get(`/api/matriculas/${id}`).set(auth())).body;
const guardarInterno = (id: string, borrador: unknown, version: number) => request(app).put(`/api/matriculas/${id}`).set(auth()).send({ borrador, version });
const guardarFamilia = (token: string, borrador: unknown, version: number) => request(app).put(`/api/public/matricula/${token}`).send({ borrador, version });

// ─────────────────────────────────────────────────────────────────────────────
describe('Matrícula digital: apertura, borrador, enlaces y renovación', () => {
  let carmen: Awaited<ReturnType<typeof reservaPagada>>;
  let id = '';
  let token = '';

  it('abrir la matrícula precarga el borrador con el expediente y la solicitud, y envía el enlace', async () => {
    carmen = await reservaPagada('Carmen');
    expect((await request(app).post('/api/matriculas').set(auth('administracion')).send({ alumnaId: carmen.alumnaId })).status).toBe(403);

    const r = await request(app).post('/api/matriculas').set(auth()).send({ alumnaId: carmen.alumnaId });
    expect(r.status).toBe(201);
    const m = r.body.matricula;
    id = m.id;
    expect(m).toMatchObject({
      codigo: 'M-2027-0001', estado: 'BORRADOR', estadoEtiqueta: 'Borrador', cursoEscolar: '2027-2028', familia: 'BACHILLERATO', curso: 1,
      cursoEtiqueta: 'Bachillerato 1º', nuevaAlumna: true, version: 1, puedeEnviar: false, guardado: null,
      alumna: { id: carmen.alumnaId, nombreCompleto: 'Carmen Matrícula Prueba' }, solicitud: { id: carmen.solicitudId, codigo: carmen.codigo },
    });
    expect(m.borrador).toMatchObject({
      via: 'bach', course: '1', newStudent: null,
      student: { firstName: 'Carmen', firstSurname: 'Matrícula', secondSurname: 'Prueba', document: '' },
      previousStudies: { school: 'IES Bécquer' },
      photo: null, documents: {}, signatures: {}, readPages: {},
    });
    expect(m.borrador.family.guardians[0]).toMatchObject({ fullName: `Elena Tutora de Carmen`, email: carmen.email });
    // Las mismas reglas que el front: con la vía elegida, falta lo de la alumna, la familia, las firmas…
    expect(Object.keys(m.pendientes)).toEqual(['student', 'family', 'modality', 'ideario', 'economic', 'documents', 'review']);
    expect(m.pendientes.student).toContain('student.birthDate');
    expect(m.historial.map((h: { tipo: string }) => h.tipo)).toEqual(['ENLACE', 'CREADA']);
    expect(m.enlaces).toEqual([expect.objectContaining({ alcance: 'FAMILIA', progenitor: null, enviadoA: carmen.email, activo: true })]);
    expect(r.body.enlace).toMatchObject({ alcance: 'FAMILIA', enviadoA: carmen.email });
    expect(r.body.enlace.url).toMatch(/\/matricula\/[A-Za-z0-9_-]{40,}$/);

    await enviarCorreos();
    const correo = [...buzon].reverse().find((c) => c.to === carmen.email)!;
    expect(correo.subject).toBe('Matrícula de Carmen Matrícula Prueba · curso 2027/28');
    expect(correo.html).toContain('Hacer la matrícula');
    token = tokenDe(correo.html);
    expect(r.body.enlace.url.endsWith(token)).toBe(true);

    // El expediente pasa a «En proceso» y enlaza su matrícula.
    const a = (await request(app).get(`/api/alumnado/${carmen.alumnaId}`).set(auth())).body;
    expect(a.estado).toBe('EN_PROCESO');
    expect(a.matriculas).toEqual([{ id, codigo: 'M-2027-0001', cursoEscolar: '2027-2028', curso: 1, estado: 'BORRADOR', estadoEtiqueta: 'Borrador' }]);
  });

  it('una sola matrícula por alumna y curso escolar; Comercial no la ve', async () => {
    const r = await request(app).post('/api/matriculas').set(auth()).send({ alumnaId: carmen.alumnaId });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('MATRICULA_YA_EXISTE');
    expect((await request(app).get('/api/matriculas').set(auth('comercial'))).status).toBe(403);
    const l = await request(app).get('/api/matriculas?q=carmen matricula').set(auth());
    expect(l.body).toMatchObject({ total: 1, items: [{ id, codigo: 'M-2027-0001', documentos: { done: 0 }, puedeEnviar: false }] });
  });

  it('la familia guarda desde su enlace; la vía, el curso y lo marcado a mano no los cambia ella', async () => {
    const pub = await request(app).get(`/api/public/matricula/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.headers['cache-control']).toBe('no-store');
    expect(pub.body).toMatchObject({ codigo: 'M-2027-0001', version: 1, soloLectura: false, enlace: { alcance: 'FAMILIA' }, alumna: { nombreCompleto: 'Carmen Matrícula Prueba' } });
    expect(pub.body).not.toHaveProperty('enlaces');
    expect(pub.body).not.toHaveProperty('historial');
    expect(pub.body.alumna).not.toHaveProperty('expediente');

    const b = structuredClone(pub.body.borrador);
    b.student.birthDate = '02/06/2011';
    b.student.document = '49218735T';
    b.via = 'gsp';
    b.manualChecks = { m5: true };
    const r = await guardarFamilia(token, b, 1);
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(2);
    expect(r.body.borrador.student).toMatchObject({ birthDate: '02/06/2011', document: '49218735T' });
    expect(r.body.borrador.via).toBe('bach');
    expect(r.body.borrador.manualChecks).toEqual({});
    expect(r.body.guardado).toMatchObject({ por: 'familia', nombre: null });

    // El autoguardado puede repetir lo mismo: no sube la versión.
    expect((await guardarFamilia(token, r.body.borrador, 2)).body.version).toBe(2);
  });

  it('dos guardados a la vez: el que llega con una versión antigua recibe 409 con quién guardó', async () => {
    const actual = await ficha(id);
    const b = structuredClone(actual.borrador);
    b.student.municipality = 'Sevilla';
    const r = await guardarInterno(id, b, 1);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'VERSION_ANTIGUA', details: { version: 2, guardadoPor: 'familia' } });
    expect(r.body.error.message).toMatch(/^La familia ha cambiado esta matrícula/);

    const ok = await guardarInterno(id, b, 2);
    expect(ok.body).toMatchObject({ version: 3, guardado: { por: 'secretaria', nombre: 'María Reyes' } });
    // Secretaría sí marca documentos a mano y puede cambiar la vía.
    b.manualChecks = { m5: true };
    expect((await guardarInterno(id, b, 3)).body.borrador.manualChecks).toEqual({ m5: true });

    const f = await guardarFamilia(token, b, 3);
    expect(f.body.error).toMatchObject({ code: 'VERSION_ANTIGUA', details: { version: 4, guardadoPor: 'secretaria', guardadoPorNombre: 'María Reyes' } });
  });

  it('el borrador se valida: un campo que no existe o un valor fuera de catálogo es 400', async () => {
    const { borrador, version } = await ficha(id);
    expect((await guardarInterno(id, { ...borrador, inventado: 1 }, version)).status).toBe(400);
    expect((await guardarInterno(id, { ...borrador, via: 'eso' }, version)).status).toBe(400);
    expect((await guardarInterno(id, { ...borrador, student: { ...borrador.student, firstName: 'x'.repeat(201) } }, version)).status).toBe(400);
  });

  it('páginas leídas: hora del servidor, solo páginas que existen, nunca se quitan y no suben la versión', async () => {
    const antes = await ficha(id);
    const r = await request(app).post(`/api/public/matricula/${token}/paginas-leidas`).send({ paginas: ['lopd-1', 'lopd-2', 'lopd-9', 'impreso-2'] });
    expect(r.status).toBe(200);
    expect(r.body.borrador.readPages).toEqual({ 'lopd-1': true, 'lopd-2': true });
    expect(r.body.version).toBe(antes.version);
    const [fila] = await db.select({ p: matriculas.paginasLeidas }).from(matriculas).where(eq(matriculas.id, id));
    expect(Date.now() - new Date(fila!.p['lopd-1']!).getTime()).toBeLessThan(60_000);

    // Un guardado con las páginas a false no las quita; con una nueva, la suma.
    const b = structuredClone(r.body.borrador);
    b.readPages = { 'lopd-1': false, 'impreso-1': true };
    const g = await guardarFamilia(token, b, r.body.version);
    expect(g.body.borrador.readPages).toEqual({ 'lopd-1': true, 'lopd-2': true, 'impreso-1': true });
    expect((await request(app).post(`/api/public/matricula/${token}/paginas-leidas`).send({ paginas: ['otra-1'] })).status).toBe(400);
  });

  it('el historial agrupa los guardados de cada uno por sesión de trabajo, sin copiar los datos', async () => {
    const h = (await ficha(id)).historial as { tipo: string; texto: string; autor: string }[];
    const ediciones = h.filter((e) => e.tipo === 'EDITADA');
    expect(ediciones).toHaveLength(2);
    expect(ediciones.find((e) => e.autor === 'Familia')!.texto).toBe('Cambia: datos de la alumna');
    expect(ediciones.find((e) => e.autor === 'María Reyes')!.texto).toBe('Cambia: datos de la alumna, documentos en papel');
    expect(JSON.stringify(h)).not.toContain('49218735T');
  });

  it('enlaces: uno nuevo sustituye al anterior; el del progenitor solo lee y firma; anulado, deja de servir', async () => {
    expect((await request(app).get('/api/public/matricula/token-que-no-existe-0000000000')).status).toBe(404);

    const nuevo = await request(app).post(`/api/matriculas/${id}/enlaces`).set(auth()).send({ alcance: 'FAMILIA', enviar: false });
    expect(nuevo.status).toBe(201);
    expect(nuevo.body.enlace.enviadoA).toBeNull();
    const viejo = await request(app).get(`/api/public/matricula/${token}`);
    expect(viejo.status).toBe(410);
    expect(viejo.body.error.code).toBe('ENLACE_SUSTITUIDO');
    token = nuevo.body.enlace.url.split('/').at(-1);
    expect((await request(app).get(`/api/public/matricula/${token}`)).status).toBe(200);

    const sinCorreo = await request(app).post(`/api/matriculas/${id}/enlaces`).set(auth()).send({ alcance: 'PROGENITOR', progenitor: 'padre' });
    expect(sinCorreo.status).toBe(400);
    expect((await request(app).post(`/api/matriculas/${id}/enlaces`).set(auth()).send({ alcance: 'FAMILIA', progenitor: 'padre' })).status).toBe(400);

    const padre = await request(app).post(`/api/matriculas/${id}/enlaces`).set(auth()).send({ alcance: 'PROGENITOR', progenitor: 'padre', email: 'Padre.Carmen@example.com' });
    expect(padre.body.enlace).toMatchObject({ alcance: 'PROGENITOR', progenitor: 'padre', enviadoA: 'padre.carmen@example.com' });
    await enviarCorreos();
    const correo = buzon.find((c) => c.to === 'padre.carmen@example.com')!;
    expect(correo.subject).toBe('Su firma en la matrícula de Carmen Matrícula Prueba');
    const tPadre = tokenDe(correo.html);

    const vp = (await request(app).get(`/api/public/matricula/${tPadre}`)).body;
    expect(vp).toMatchObject({ soloLectura: true, enlace: { alcance: 'PROGENITOR', progenitor: 'padre' } });
    const b = structuredClone(vp.borrador);
    b.student.firstName = 'Otra';
    b.readPages = { ...b.readPages, 'lopd-3': true };
    const g = await guardarFamilia(tPadre, b, vp.version);
    expect(g.body.borrador.student.firstName).toBe('Carmen');
    expect(g.body.borrador.readPages['lopd-3']).toBe(true);

    // El enlace de la familia sigue vivo: solo se sustituye el del mismo tipo.
    expect((await request(app).get(`/api/public/matricula/${token}`)).status).toBe(200);
    const anulado = await request(app).delete(`/api/matriculas/${id}/enlaces/${padre.body.enlace.id}`).set(auth());
    expect(anulado.body.enlaces.filter((e: { activo: boolean }) => e.activo)).toHaveLength(1);
    expect((await request(app).get(`/api/public/matricula/${tPadre}`)).status).toBe(410);
  });

  it('renovación en bloque: solo las de 1º que promocionan; parte de su matrícula de 1º', async () => {
    // Lola: matrícula de 1º en 2026-2027 con cuenta y materias; luego queda matriculada y promociona.
    const lola = await alta('Lola', { estado: 'EN_PROCESO' });
    const m1 = (await request(app).post('/api/matriculas').set(auth()).send({ alumnaId: lola, enviarEnlace: false })).body;
    expect(m1.enlace.enviadoA).toBeNull();
    expect(m1.matricula).toMatchObject({ codigo: 'M-2026-0001', cursoEscolar: '2026-2027', curso: 1 });
    const b = structuredClone(m1.matricula.borrador);
    b.bachillerato = { modality: 'cie', subjects: { t1: 'Física' }, previousModality: null };
    b.economic.sepa = { iban: 'ES9121000418450200051332', holder: 'Madre de Lola', holderDocument: '12345678Z', bic: '', paymentType: 'monthly' };
    b.declaration = { day: '12', month: 'junio', signer: 'guardian' };
    expect((await guardarInterno(m1.matricula.id, b, 1)).status).toBe(200);
    await request(app).patch(`/api/alumnado/${lola}`).set(auth()).send({ estado: 'MATRICULADA', promociona: true });

    const sinDecidir = await alta('Nora', {});
    const noPromociona = await alta('Olga', { promociona: false });
    const enSegundo = await alta('Paula', { curso: 2 });

    const r = await request(app).post('/api/matriculas/renovacion').set(auth()).send({ familia: 'BACHILLERATO', cursoEscolar: '2026-2027', enviarEnlace: false });
    expect(r.status).toBe(200);
    expect(r.body.creadas).toHaveLength(1);
    expect(r.body.creadas[0]).toMatchObject({ alumnaId: lola, codigo: 'M-2027-0002', enlaceEnviadoA: null });
    expect(r.body.omitidas).toEqual([]);

    const m2 = await ficha(r.body.creadas[0].matriculaId);
    expect(m2).toMatchObject({ cursoEscolar: '2027-2028', curso: 2, nuevaAlumna: false, solicitud: null });
    expect(m2.borrador).toMatchObject({
      course: '2', newStudent: null,
      bachillerato: { modality: 'cie', subjects: {}, previousModality: 'cie' },
      previousStudies: { school: 'Centro Educativo Albaydar', course: 'Bachillerato 1º', stage: 'Bachillerato', promotes: true },
      economic: { sepa: { iban: 'ES9121000418450200051332', paymentType: 'monthly' } },
      declaration: { day: '', month: '', signer: null },
    });
    expect(Object.keys(m2.pendientes)).not.toContain('ideario'); // continúa: sin ideario ni LOPD
    expect((await request(app).get(`/api/alumnado/${lola}`).set(auth())).body.estado).toBe('MATRICULADA');

    // Repetirla no duplica; a mano, sí se abre la de quien no tiene decidido si promociona.
    const otra = await request(app).post('/api/matriculas/renovacion').set(auth()).send({ familia: 'BACHILLERATO', cursoEscolar: '2026-2027', alumnaIds: [lola, enSegundo] });
    expect(otra.body.creadas).toEqual([]);
    expect(otra.body.omitidas.map((o: { motivo: string }) => o.motivo)).toEqual([
      expect.stringMatching(/^Esta alumna ya tiene matrícula para 2027-2028/),
      'No es una alumna de 1º matriculada en esa vía y curso escolar.',
    ]);
    expect((await request(app).post('/api/matriculas').set(auth()).send({ alumnaId: sinDecidir, enviarEnlace: false })).body.matricula.borrador.previousStudies.promotes).toBeNull();
    expect((await request(app).post('/api/matriculas').set(auth()).send({ alumnaId: noPromociona })).body.error.code).toBe('NO_PROMOCIONA');
    expect((await request(app).post('/api/matriculas').set(auth()).send({ alumnaId: enSegundo })).body.error.code).toBe('SIN_CURSO_SIGUIENTE');
  });

  it('un expediente de baja no se matricula', async () => {
    const id = await alta('Quima', { estado: 'RESERVA', cursoEscolar: '2027-2028' });
    await request(app).post(`/api/alumnado/${id}/baja`).set(auth()).send({ motivo: 'Se va a otro centro' });
    expect((await request(app).post('/api/matriculas').set(auth()).send({ alumnaId: id })).body.error.code).toBe('ALUMNA_DE_BAJA');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Matrícula digital: documentos con huella, firmas y mandatos SEPA', () => {
  /** Lo que comprueba la API es la firma de bytes del PNG; el contenido da igual para los tests. */
  const png = (bytes = 300, relleno = 7) =>
    `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes, relleno)]).toString('base64')}`;

  let id = '';
  let token = '';
  const pub = (ruta = '') => request(app).get(`/api/public/matricula/${token}${ruta}`);
  const doc = async (d: string, t = token) => (await request(app).get(`/api/public/matricula/${t}/documentos/${d}`)).body;
  const firmar = (hueco: string, huella: string, imagen = png(), t = token) => request(app).post(`/api/public/matricula/${t}/firmas/${hueco}`).send({ imagen, huella });
  const leer = (...paginas: string[]) => request(app).post(`/api/public/matricula/${token}/paginas-leidas`).send({ paginas });
  /** Cambia el borrador desde el enlace de la familia, con la versión actual. */
  const cambiar = async (f: (b: any) => void) => {
    const actual = (await pub()).body;
    const b = structuredClone(actual.borrador);
    f(b);
    const r = await guardarFamilia(token, b, actual.version);
    expect(r.status).toBe(200);
    return r.body;
  };
  const firmaDe = (vista: { firmas: { hueco: string }[] }, hueco: string) => vista.firmas.find((f) => f.hueco === hueco) as any;

  it('el documento lo da la API, rellenado con los datos y con su huella', async () => {
    const s = await reservaPagada('Sara');
    const r = await request(app).post('/api/matriculas').set(auth()).send({ alumnaId: s.alumnaId, enviarEnlace: false });
    id = r.body.matricula.id;
    token = r.body.enlace.url.split('/').at(-1);

    const d = await doc('impreso');
    expect(d).toMatchObject({ id: 'impreso', version: 'impreso@2026-1', nombre: 'Impreso de matriculación', puedeFirmar: false, paginasLeidas: [], firmas: {} });
    expect(d.huella).toMatch(/^[0-9a-f]{64}$/);
    expect(d.paginas).toHaveLength(1);
    expect(d.paginas[0].bloques[0]).toEqual({ tipo: 'titulo', texto: 'IMPRESO DE MATRICULACIÓN · CURSO 2027/28' });
    const campos = d.paginas[0].bloques.filter((b: { tipo: string }) => b.tipo === 'campos').flatMap((b: { campos: unknown[] }) => b.campos);
    expect(campos).toContainEqual({ etiqueta: 'Nombre', valor: 'Sara' });
    expect(campos).toContainEqual({ etiqueta: 'Curso y grupo', valor: '1º Bachillerato' });
    expect(d.paginas[0].firma).toMatchObject({ declaracion: 'He leído el documento completo y lo firmo.', huecos: [{ id: 'impreso-titular', etiqueta: 'Firma' }] });
    // La misma matrícula da siempre la misma huella; la fecha (la de la firma) no entra en ella.
    expect((await doc('impreso')).huella).toBe(d.huella);
    expect((await doc('lopd')).paginas).toHaveLength(7);
    expect((await pub('/documentos/plus')).status).toBe(404); // AlbaydarPLUS no es de Bachillerato
  });

  it('firmar exige leer el documento entero, la huella que se ve y un PNG de verdad', async () => {
    const d = await doc('impreso');
    const sinLeer = await firmar('impreso-titular', d.huella);
    expect(sinLeer.status).toBe(409);
    expect(sinLeer.body.error).toMatchObject({ code: 'DOCUMENTO_SIN_LEER', details: { faltan: ['impreso-1'] } });

    await leer('impreso-1');
    const otra = await firmar('impreso-titular', 'a'.repeat(64));
    expect(otra.body.error).toMatchObject({ code: 'DOCUMENTO_CAMBIADO', details: { huella: d.huella } });
    expect((await firmar('impreso-titular', d.huella, 'data:image/jpeg;base64,AAAA')).body.error.code).toBe('FIRMA_NO_VALIDA');
    expect((await firmar('impreso-titular', d.huella, `data:image/png;base64,${Buffer.from('no es un png, solo texto plano'.repeat(10)).toString('base64')}`)).body.error.code).toBe('FIRMA_NO_VALIDA');
    // Más de 200 KB: su ruta tiene su propio límite de cuerpo, así que responde la API, no un 413.
    const grande = await firmar('impreso-titular', d.huella, png(210 * 1024));
    expect(grande.status).toBe(400);
    expect(grande.body.error.message).toBe('La imagen de la firma supera 200 KB.');
    expect((await firmar('plus-titular', d.huella)).body.error.code).toBe('DOCUMENTO_NO_APLICA');

    const ok = await firmar('impreso-titular', d.huella);
    expect(ok.status).toBe(201);
    expect(ok.body.borrador.signatures['impreso-titular'].signedAt).toBeTruthy();
    expect(ok.body.borrador.signatures['impreso-titular']).not.toHaveProperty('image');
    expect(firmaDe(ok.body, 'impreso-titular')).toMatchObject({ documento: 'impreso', estado: 'VALIDA', motivo: null, enlace: { alcance: 'FAMILIA' }, enSecretaria: false });

    const conFirma = await doc('impreso');
    expect(conFirma.huella).toBe(d.huella);
    expect(conFirma.firmas['impreso-titular'].imagen).toBe(png());
    const fecha = conFirma.paginas[0].bloques.find((b: { tipo: string }) => b.tipo === 'fecha');
    expect(fecha.texto).toMatch(new RegExp(`^En Sevilla, a \\d{1,2} de [a-z]+ de ${new Date().getFullYear()}\\.$`));

    const h = (await ficha(id)).historial;
    expect(h[0]).toMatchObject({ tipo: 'FIRMADA', texto: 'Impreso de matriculación · firma', autor: 'Familia' });
  });

  it('una firma vale mientras su documento no cambie: si cambia un dato que sale en él, se anula', async () => {
    // PASEN no sale en el impreso: la firma sigue.
    let v = await cambiar((b) => (b.pasen.enabled = false));
    expect(firmaDe(v, 'impreso-titular').estado).toBe('VALIDA');

    v = await cambiar((b) => (b.student.firstName = 'Sarah'));
    expect(v.borrador.signatures).toEqual({});
    expect(firmaDe(v, 'impreso-titular')).toMatchObject({ estado: 'ANULADA', motivo: 'Cambió: Nombre' });
    const h = (await ficha(id)).historial;
    expect(h.find((e: { tipo: string }) => e.tipo === 'FIRMA_ANULADA').texto).toBe('Hay que volver a firmar «Impreso de matriculación». Cambió: Nombre');

    // Se vuelve a firmar con el documento nuevo.
    const d = await doc('impreso');
    expect((await firmar('impreso-titular', d.huella)).status).toBe(201);
  });

  it('LOPD: la DOP es obligatoria; cada progenitor, con su enlace, solo firma sus huecos y solo ve la LOPD', async () => {
    await leer('lopd-1', 'lopd-2', 'lopd-3', 'lopd-4', 'lopd-5', 'lopd-6', 'lopd-7');
    let d = await doc('lopd');
    expect(d.puedeFirmar).toBe(false);
    expect((await firmar('lopd-madre', d.huella)).body.error.code).toBe('FALTAN_DATOS');
    const dop = d.paginas[2].bloques.find((b: { tipo: string }) => b.tipo === 'opcion');
    expect(dop).toMatchObject({ campo: 'lopd.dop', aviso: 'Elija una de las dos opciones · obligatorio' });

    await cambiar((b) => (b.lopd.dop = true));
    d = await doc('lopd');
    expect(d.puedeFirmar).toBe(true);
    expect((await firmar('lopd-madre', d.huella)).status).toBe(201);

    const padre = await request(app).post(`/api/matriculas/${id}/enlaces`).set(auth()).send({ alcance: 'PROGENITOR', progenitor: 'padre', enviar: false });
    const tPadre = padre.body.enlace.url.split('/').at(-1);
    const prohibido = await firmar('lopd-madre', d.huella, png(), tPadre);
    expect(prohibido.status).toBe(403);
    expect(prohibido.body.error.code).toBe('ENLACE_SIN_PERMISO');
    expect((await request(app).get(`/api/public/matricula/${tPadre}/documentos/impreso`)).status).toBe(403);
    const vPadre = await firmar('lopd-padre', (await doc('lopd', tPadre)).huella, png(400, 9), tPadre);
    expect(vPadre.status).toBe(201);
    expect(firmaDe(vPadre.body, 'lopd-padre')).toMatchObject({ estado: 'VALIDA', enlace: { alcance: 'PROGENITOR', progenitor: 'padre' } });

    // Una autorización desmarcada cambia la LOPD: caen todas sus firmas, también la del padre.
    const v = await cambiar((b) => (b.lopd.authorizations.a12 = false));
    expect(firmaDe(v, 'lopd-padre')).toMatchObject({ estado: 'ANULADA', motivo: 'Cambió: Publicación de imágenes por el centro' });
    expect(firmaDe(v, 'lopd-madre').estado).toBe('ANULADA');
  });

  it('orden SEPA: la cuenta se valida al firmar y la firma crea el mandato; cambiar la cuenta lo anula', async () => {
    await leer('sepa-1');
    await cambiar((b) => {
      b.economic.sepa = { iban: 'ES91 2100 0418 4502 0005 1333', holder: 'Elena Tutora de Sara', holderDocument: '12345678A', bic: 'XX', paymentType: 'monthly' };
    });
    let d = await doc('sepa');
    const acreedor = d.paginas[0].bloques.find((b: { tipo: string; titulo?: string }) => b.tipo === 'campos' && b.titulo === 'Datos del acreedor');
    expect(acreedor.campos[0]).toEqual({ etiqueta: 'Identificador del acreedor', valor: 'ES09000G41829037' });
    const mal = await firmar('sepa-titular', d.huella);
    expect(mal.status).toBe(400);
    expect(mal.body.error.code).toBe('DATOS_CUENTA_NO_VALIDOS');
    expect(mal.body.error.details.errores).toHaveLength(3); // IBAN, DNI del titular y BIC

    await cambiar((b) => {
      b.economic.sepa = { ...b.economic.sepa, iban: 'ES9121000418450200051332', holderDocument: '12345678Z', bic: '' };
    });
    d = await doc('sepa');
    const ok = await firmar('sepa-titular', d.huella);
    expect(ok.status).toBe(201);
    expect(ok.body.mandatos).toEqual([
      expect.objectContaining({
        referencia: expect.stringMatching(/^M-2027-\d{4}-SEPA1$/), tipo: 'SEPA', secuencia: 'RCUR', esquema: 'CORE', estado: 'VIGENTE',
        acreedor: { identificador: 'ES09000G41829037', nombre: 'Albaydar' }, iban: 'ES91 **** **** **** **** 1332', titularDocumento: null, bic: null,
      }),
    ]);
    // Secretaría ve la cuenta entera en la ficha.
    expect((await ficha(id)).mandatos[0]).toMatchObject({ iban: 'ES9121000418450200051332', titularDocumento: '12345678Z' });

    // Otra modalidad de pago cambia la orden: mandato anulado; al volver a firmar, SEPA2 de cargo único.
    let v = await cambiar((b) => (b.economic.sepa.paymentType = 'single'));
    expect(firmaDe(v, 'sepa-titular')).toMatchObject({ estado: 'ANULADA', motivo: 'Cambió: Pago por mensualidades, Pago único' });
    expect(v.mandatos[0]).toMatchObject({ estado: 'ANULADO', anulado: { motivo: 'Cambió: Pago por mensualidades, Pago único' } });
    v = (await firmar('sepa-titular', (await doc('sepa')).huella)).body;
    expect(v.mandatos.map((x: { referencia: string; secuencia: string; estado: string }) => [x.referencia.slice(-5), x.secuencia, x.estado])).toEqual([
      ['SEPA1', 'RCUR', 'ANULADO'],
      ['SEPA2', 'OOFF', 'VIGENTE'],
    ]);
  });

  it('acreedores en la configuración: cambiar el de la vía deja la orden firmada pendiente de volver a firmar', async () => {
    const cfg = await request(app).get('/api/matriculas/configuracion').set(auth());
    expect(cfg.body.acreedorPorFamilia.CICLOS_CONCERTADOS_GS).toBe('gs-concertado');
    const nueva = structuredClone(cfg.body);
    expect((await request(app).put('/api/matriculas/configuracion').set(auth()).send(nueva)).status).toBe(403);
    nueva.acreedores[0].identificador = 'ES10000G41829037';
    const mal = await request(app).put('/api/matriculas/configuracion').set(auth('direccion')).send(nueva);
    expect(mal.status).toBe(400);
    nueva.acreedores.push({ id: 'nuevo', nombre: 'Albaydar', direccion: 'Avd. La Palmera 36 · 41012 Sevilla · España', identificador: 'ES09001G41829037' });
    nueva.acreedores[0].identificador = 'ES09000G41829037';
    nueva.acreedorPorFamilia.BACHILLERATO = 'nuevo';
    expect((await request(app).put('/api/matriculas/configuracion').set(auth('direccion')).send(nueva)).status).toBe(200);

    const f = await ficha(id);
    expect(firmaDe(f, 'sepa-titular')).toMatchObject({ estado: 'DESACTUALIZADA', motivo: 'Cambió: Identificador del acreedor' });
    expect(f.borrador.signatures['sepa-titular']).toBeUndefined();
    // Se deja como estaba para el resto.
    nueva.acreedorPorFamilia.BACHILLERATO = 'general';
    await request(app).put('/api/matriculas/configuracion').set(auth('direccion')).send(nueva);
    expect(firmaDe(await ficha(id), 'sepa-titular').estado).toBe('VALIDA');
  });

  it('secretaría firma con la familia delante; borrar una firma la anula, no la borra', async () => {
    await leer('ideario-1');
    const d = (await request(app).get(`/api/matriculas/${id}/documentos/ideario`).set(auth())).body;
    expect(d.paginas[0].firma.huecos[0]).toMatchObject({ id: 'ideario-titular', subtitulo: 'Si es mayor de edad, por la interesada' });
    const r = await request(app).post(`/api/matriculas/${id}/firmas/ideario-titular`).set(auth()).send({ imagen: png(), huella: d.huella });
    expect(r.status).toBe(201);
    expect(firmaDe(r.body, 'ideario-titular')).toMatchObject({ estado: 'VALIDA', enlace: null, enSecretaria: true });
    expect(r.body.historial[0]).toMatchObject({ tipo: 'FIRMADA', autor: 'María Reyes' });
    expect((await request(app).post(`/api/matriculas/${id}/firmas/ideario-titular`).set(auth('administracion')).send({ imagen: png(), huella: d.huella })).status).toBe(403);

    const b = await request(app).delete(`/api/public/matricula/${token}/firmas/ideario-titular`);
    expect(firmaDe(b.body, 'ideario-titular')).toMatchObject({ estado: 'ANULADA', motivo: 'Borrada' });
    expect((await request(app).delete(`/api/public/matricula/${token}/firmas/ideario-titular`)).status).toBe(404);
    expect((await ficha(id)).historial[0]).toMatchObject({ tipo: 'FIRMA_BORRADA', autor: 'Familia' });
  });
});
