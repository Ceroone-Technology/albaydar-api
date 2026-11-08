import { and, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { CENTRO, env } from '../../config/env';
import {
  alumnaContactos,
  alumnas,
  enlacesMatricula,
  estadoMatriculaEnum,
  familiaViaEnum,
  matriculaEventos,
  matriculas,
  solicitudes,
  usuarios,
  type Alumna,
  type AlumnaContacto,
  type EnlaceMatricula,
  type Matricula,
} from '../../db/schema';
import { enviarEvento } from '../../correo/enviar';
import { boton } from '../../correo/plantillas';
import { hashToken, nuevoToken } from '../../lib/crypto';
import { db, type Tx } from '../../lib/db';
import { badRequest, codigoPg, conflict, gone, notFound } from '../../lib/errors';
import { diaLargo } from '../../lib/fechas';
import { matriculaConfig } from '../ajustes/ajustes.service';
import { estadoPorMatricula, plegar, plegarSql } from '../alumnado/alumnado.service';
import { siguienteValor } from '../solicitudes/comun';
import { cursoEscolarCorto, nombrePila, nombreVia } from '../solicitudes/dominio';
import { jsonCanonico } from './json-canonico';
import * as firmasSrv from './firmas.service';
import { anularDesactualizadas, cargarFirmas, evaluarFirmas, firmasDe, vistaMandato, type Evidencias, type Firmante } from './firmas.service';
import { borradorEntrada, borradorVacio, CURSOS, type Borrador, type Expediente } from './borrador';
import {
  ETIQUETA_ESTADO_MATRICULA,
  FAMILIA_DE_VIA,
  VIA_DE_FAMILIA,
  caducidadEnlace,
  cursoEscolarSiguiente,
  formatoCodigoMatricula,
  type Progenitor,
} from './dominio';
import { READER_DOCS, checklistProgress, canSubmit, isNewStudent, pendientes, type ReaderDocId } from './reglas';

/**
 * Matrícula digital (fase 04), primera entrega: apertura, renovación 1º → 2º, borrador con
 * versión, páginas leídas y enlaces de la familia. Diseño en docs/matricula.md.
 *
 *  - Una matrícula por alumna y curso escolar; cuelga siempre de un expediente.
 *  - El borrador lo guardan la familia (desde su enlace) y secretaría. `version` evita que un
 *    guardado pise a otro: 409 VERSION_ANTIGUA con quién guardó y cuándo.
 *  - Desde el enlace, la familia no cambia la vía, el curso, «alumna nueva» ni los documentos
 *    marcados a mano: eso lo decide secretaría (docs/matricula.md, punto 10).
 */

// ── Esquemas ─────────────────────────────────────────────────────────────────

const cursoEscolar = z.string().regex(/^\d{4}-\d{4}$/, 'Curso escolar con formato 2027-2028.');
const PAGINA = /^(impreso|ideario|lopd|sepa|plus)-([1-9])$/;

export const crearMatriculaBody = z.object({
  alumnaId: z.string().uuid(),
  /** Envía el enlace a la familia (contacto principal). Si es false, solo se crea. */
  enviarEnlace: z.boolean().default(true),
});

export const renovacionBody = z.object({
  familia: z.enum(familiaViaEnum.enumValues),
  /** Curso escolar que termina (el de 1º). La matrícula es para el siguiente. */
  cursoEscolar,
  /** Para abrir solo algunas; si no, todas las que promocionan. */
  alumnaIds: z.array(z.string().uuid()).min(1).max(300).optional(),
  enviarEnlace: z.boolean().default(true),
});

export const guardarBody = z.object({
  borrador: borradorEntrada,
  version: z.number().int().min(1),
});

export const paginasBody = z.object({
  paginas: z.array(z.string().regex(PAGINA, 'Página no válida.')).min(1).max(20),
});

export const enlaceBody = z
  .object({
    alcance: z.enum(['FAMILIA', 'PROGENITOR']),
    progenitor: z.enum(['padre', 'madre']).optional(),
    enviar: z.boolean().default(true),
    /** Por defecto: FAMILIA, el contacto principal; PROGENITOR, obligatorio si se envía. */
    email: z.string().trim().toLowerCase().email('El correo no es válido.').max(254).optional(),
  })
  .refine((d) => (d.alcance === 'PROGENITOR') === (d.progenitor !== undefined), {
    message: 'Indica el progenitor solo en un enlace de progenitor.',
    path: ['progenitor'],
  })
  .refine((d) => d.alcance !== 'PROGENITOR' || !d.enviar || d.email !== undefined, {
    message: 'Indica el correo del progenitor.',
    path: ['email'],
  });

export const listarMatriculasQuery = z.object({
  /** Nombre, apellidos o expediente de la alumna, o código de la matrícula. */
  q: z.string().trim().max(100).optional(),
  estado: z.enum(estadoMatriculaEnum.enumValues).optional(),
  cursoEscolar: cursoEscolar.optional(),
  familia: z.enum(familiaViaEnum.enumValues).optional(),
  curso: z.coerce.number().int().min(1).max(2).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type ActorMatricula = { tipo: 'usuario'; usuarioId: string } | { tipo: 'familia'; enlace: EnlaceMatricula };

// ── Borrador inicial ─────────────────────────────────────────────────────────

/** «García López» → García / López. Con más palabras (de la Rosa…) todo va al primero: la familia lo corrige. */
function partirApellidos(apellidos: string): [string, string] {
  const partes = apellidos.trim().split(/\s+/);
  return partes.length === 2 ? [partes[0]!, partes[1]!] : [apellidos.trim(), ''];
}

const aFechaBorrador = (f: string | null) => (f ? f.split('-').reverse().join('/') : '');

function edad(fechaNacimiento: string | null, hoy = new Date()): number | null {
  if (!fechaNacimiento) return null;
  const [a, m, d] = fechaNacimiento.split('-').map(Number) as [number, number, number];
  const e = hoy.getFullYear() - a;
  return hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d) ? e - 1 : e;
}

/** Matrícula de alumnado nuevo: lo que ya sabemos por el expediente y la solicitud. */
function borradorDesdeExpediente(a: Alumna, contactos: AlumnaContacto[], centroProcedencia: string | null, curso: '1' | '2'): Borrador {
  const d = borradorVacio();
  const [primero, segundo] = partirApellidos(a.apellidos);
  d.via = VIA_DE_FAMILIA[a.familia];
  d.course = curso;
  d.student = {
    ...d.student,
    firstName: a.nombre,
    firstSurname: primero,
    secondSurname: segundo,
    birthDate: aFechaBorrador(a.fechaNacimiento),
    document: a.documento ?? '',
    email: a.email ?? '',
    phone: a.telefono ?? '',
    address: a.domicilio ?? '',
  };
  const ordenados = [...contactos].sort((x, y) => Number(y.principal) - Number(x.principal) || x.orden - y.orden);
  d.family.guardians = [0, 1].map((i) => {
    const c = ordenados[i];
    return { fullName: c?.nombre ?? '', profession: '', document: '', email: c?.email ?? '', phone: c?.telefono ?? '' };
  }) as Borrador['family']['guardians'];
  d.previousStudies.school = centroProcedencia ?? '';
  const anios = edad(a.fechaNacimiento);
  if (anios !== null) d.annex.minor = anios < 18;
  return d;
}

/**
 * Renovación 1º → 2º: se parte de la matrícula de 1º. Se conservan los datos personales, la
 * familia y la cuenta; se vacía lo que es de cada curso (materias, becas, lecturas y declaración).
 */
function borradorDeRenovacion(anterior: Borrador, a: Alumna): Borrador {
  const vacio = borradorVacio();
  const d = structuredClone(anterior);
  d.course = '2';
  d.newStudent = null;
  d.bachillerato = { modality: anterior.bachillerato.modality, subjects: {}, previousModality: anterior.bachillerato.modality };
  d.annex.enrollmentCourse = '2';
  d.previousStudies = {
    ...vacio.previousStudies,
    school: CENTRO.nombre,
    course: nombreVia(a.familia, 1),
    stage: a.familia === 'BACHILLERATO' ? 'Bachillerato' : null,
    promotes: a.promociona,
  };
  d.economic = { ...vacio.economic, gsPayment: anterior.economic.gsPayment, sepa: { ...anterior.economic.sepa }, plus: anterior.economic.plus };
  d.manualChecks = {};
  d.readPages = {};
  d.declaration = vacio.declaration;
  return d;
}

// ── Vistas ───────────────────────────────────────────────────────────────────

/**
 * El borrador con lo que controla el servidor: las páginas leídas y las firmas que valen.
 * Sin `signatures`, la base para generar documentos y evaluar las firmas. Archivos: entrega 3.
 */
function expediente(m: Matricula, signatures: Expediente['signatures'] = {}): Expediente {
  return {
    ...m.datos,
    readPages: Object.fromEntries(Object.keys(m.paginasLeidas).map((k) => [k, true])),
    photo: null,
    documents: {},
    signatures,
  };
}

const ETIQUETA_GUARDADO: Record<string, string> = { familia: 'la familia', secretaria: 'secretaría' };

function vistaEnlace(e: EnlaceMatricula) {
  const ahora = new Date();
  return {
    id: e.id,
    alcance: e.alcance,
    progenitor: e.progenitor,
    enviadoA: e.enviadoA,
    expiraEn: e.expiraEn,
    revocadoEn: e.revocadoEn,
    ultimoUsoEn: e.ultimoUsoEn,
    creadoEn: e.createdAt,
    activo: !e.revocadoEn && e.expiraEn > ahora,
  };
}

async function datosDe(tx: Tx, m: Matricula) {
  const [fila] = await tx
    .select({ id: alumnas.id, expediente: alumnas.expediente, nombre: alumnas.nombre, apellidos: alumnas.apellidos, estado: alumnas.estado })
    .from(alumnas)
    .where(eq(alumnas.id, m.alumnaId));
  const [s] = m.solicitudId ? await tx.select({ id: solicitudes.id, codigo: solicitudes.codigo }).from(solicitudes).where(eq(solicitudes.id, m.solicitudId)) : [];
  const [u] = m.guardadoPorId ? await tx.select({ nombre: usuarios.nombre }).from(usuarios).where(eq(usuarios.id, m.guardadoPorId)) : [];
  const { evaluacion, mandatos } = await firmasDe(tx, m, expediente(m));
  return { alumna: fila!, solicitud: s ?? null, guardadoPorNombre: u?.nombre ?? null, evaluacion, mandatos };
}

/** `completo`: la ficha de secretaría ve el IBAN y el DNI del titular de los mandatos sin enmascarar. */
function vistaBase(m: Matricula, extra: Awaited<ReturnType<typeof datosDe>>, completo = true) {
  const exp = expediente(m, extra.evaluacion.signatures);
  return {
    id: m.id,
    codigo: m.codigo,
    estado: m.estado,
    estadoEtiqueta: ETIQUETA_ESTADO_MATRICULA[m.estado],
    cursoEscolar: m.cursoEscolar,
    familia: m.familia,
    curso: m.curso,
    cursoEtiqueta: nombreVia(m.familia, m.curso),
    nuevaAlumna: m.nuevaAlumna,
    version: m.version,
    alumna: {
      id: extra.alumna.id,
      expediente: extra.alumna.expediente,
      nombreCompleto: `${extra.alumna.nombre} ${extra.alumna.apellidos}`.trim(),
    },
    solicitud: extra.solicitud,
    /** El borrador del asistente, con la forma de `EnrollmentDraft` del front. */
    borrador: exp,
    /** Lo que falta en cada paso (las mismas reglas que el front): vacío = se puede enviar. */
    pendientes: pendientes(exp),
    puedeEnviar: canSubmit(exp),
    documentos: checklistProgress(exp),
    /** La última firma de cada hueco: válida, desactualizada (cambió su documento) o anulada, con el motivo. */
    firmas: extra.evaluacion.vista,
    mandatos: extra.mandatos.map((x) => vistaMandato(x, completo)),
    guardado: m.guardadoEn ? { en: m.guardadoEn, por: m.guardadoPor, nombre: extra.guardadoPorNombre } : null,
    enviadaEn: m.enviadaEn,
    exportadaEn: m.exportadaEn,
    devuelta: m.devueltaEn ? { en: m.devueltaEn, motivo: m.motivoDevolucion } : null,
    creadaEn: m.createdAt,
    actualizadaEn: m.updatedAt,
  };
}

type ItemHistorialMatricula = { id: string; tipo: string; texto: string | null; fecha: Date; autor: string };

async function historial(tx: Tx, matriculaId: string): Promise<ItemHistorialMatricula[]> {
  const filas = await tx
    .select({ e: matriculaEventos, nombre: usuarios.nombre })
    .from(matriculaEventos)
    .leftJoin(usuarios, eq(usuarios.id, matriculaEventos.usuarioId))
    .where(eq(matriculaEventos.matriculaId, matriculaId))
    .orderBy(desc(matriculaEventos.createdAt));
  return filas.map(({ e, nombre }) => ({
    id: e.id,
    tipo: e.tipo,
    texto: e.texto,
    fecha: e.createdAt,
    autor: e.actor === 'familia' ? 'Familia' : e.actor === 'sistema' ? 'Sistema' : (nombre ?? 'Secretaría'),
  }));
}

async function cargar(tx: Tx, id: string, bloquear = false) {
  const q = tx.select().from(matriculas).where(eq(matriculas.id, id));
  const [m] = bloquear ? await q.for('update') : await q;
  if (!m) throw notFound('Matrícula no encontrada.', 'MATRICULA_NO_ENCONTRADA');
  return m;
}

/** Ficha para secretaría: con enlaces e historial. */
export async function detalle(id: string, tx: Tx = db) {
  const m = await cargar(tx, id);
  const extra = await datosDe(tx, m);
  const enlaces = await tx.select().from(enlacesMatricula).where(eq(enlacesMatricula.matriculaId, id)).orderBy(desc(enlacesMatricula.createdAt));
  return { ...vistaBase(m, extra), enlaces: enlaces.map(vistaEnlace), historial: await historial(tx, id) };
}

/** Lo que ve la familia desde su enlace: sin enlaces, historial ni notas internas. */
async function vistaPublica(tx: Tx, m: Matricula, enlace: EnlaceMatricula) {
  const base = vistaBase(m, await datosDe(tx, m), false);
  return {
    ...base,
    alumna: { nombreCompleto: base.alumna.nombreCompleto },
    solicitud: base.solicitud ? { codigo: base.solicitud.codigo } : null,
    enlace: { alcance: enlace.alcance, progenitor: enlace.progenitor, expiraEn: enlace.expiraEn },
    soloLectura: m.estado !== 'BORRADOR' || enlace.alcance === 'PROGENITOR',
  };
}

// ── Listado ──────────────────────────────────────────────────────────────────

function filtros(q: z.infer<typeof listarMatriculasQuery>): SQL | undefined {
  const condiciones: (SQL | undefined)[] = [
    q.estado ? eq(matriculas.estado, q.estado) : undefined,
    q.cursoEscolar ? eq(matriculas.cursoEscolar, q.cursoEscolar) : undefined,
    q.familia ? eq(matriculas.familia, q.familia) : undefined,
    q.curso ? eq(matriculas.curso, q.curso) : undefined,
  ];
  if (q.q) {
    const t = `%${plegar(q.q)}%`;
    condiciones.push(
      or(
        sql`${plegarSql(sql`${alumnas.nombre} || ' ' || ${alumnas.apellidos}`)} like ${t}`,
        sql`lower(${alumnas.expediente}) like ${t}`,
        sql`lower(${matriculas.codigo}) like ${t}`,
      ),
    );
  }
  return and(...condiciones);
}

export async function listar(q: z.infer<typeof listarMatriculasQuery>) {
  const where = filtros(q);
  const [filas, [total]] = await Promise.all([
    db
      .select({ m: matriculas, a: { id: alumnas.id, expediente: alumnas.expediente, nombre: alumnas.nombre, apellidos: alumnas.apellidos } })
      .from(matriculas)
      .innerJoin(alumnas, eq(alumnas.id, matriculas.alumnaId))
      .where(where)
      .orderBy(desc(matriculas.updatedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(matriculas).innerJoin(alumnas, eq(alumnas.id, matriculas.alumnaId)).where(where),
  ]);
  const [firmas, config] = await Promise.all([cargarFirmas(db, filas.map((f) => f.m.id)), matriculaConfig()]);
  return {
    items: filas.map(({ m, a }) => {
      const ev = evaluarFirmas(m, expediente(m), firmas.filter((f) => f.matriculaId === m.id), { config });
      const exp = expediente(m, ev.signatures);
      return {
        id: m.id,
        codigo: m.codigo,
        estado: m.estado,
        estadoEtiqueta: ETIQUETA_ESTADO_MATRICULA[m.estado],
        cursoEscolar: m.cursoEscolar,
        familia: m.familia,
        curso: m.curso,
        cursoEtiqueta: nombreVia(m.familia, m.curso),
        nuevaAlumna: m.nuevaAlumna,
        alumna: { id: a.id, expediente: a.expediente, nombreCompleto: `${a.nombre} ${a.apellidos}`.trim() },
        documentos: checklistProgress(exp),
        puedeEnviar: canSubmit(exp),
        guardado: m.guardadoEn ? { en: m.guardadoEn, por: m.guardadoPor } : null,
        enviadaEn: m.enviadaEn,
        exportadaEn: m.exportadaEn,
        creadaEn: m.createdAt,
      };
    }),
    total: total?.n ?? 0,
    page: q.page,
    pageSize: q.pageSize,
  };
}

// ── Historial ────────────────────────────────────────────────────────────────

async function evento(
  tx: Tx,
  matriculaId: string,
  tipo: string,
  actor: ActorMatricula | { tipo: 'sistema' },
  texto?: string | null,
  detalle?: Record<string, unknown>,
) {
  await tx.insert(matriculaEventos).values({
    matriculaId,
    tipo,
    texto: texto ?? null,
    detalle,
    actor: actor.tipo,
    usuarioId: actor.tipo === 'usuario' ? actor.usuarioId : null,
    enlaceId: actor.tipo === 'familia' ? actor.enlace.id : null,
  });
}

/** Partes del borrador, para decir en el historial qué se tocó (nunca los valores). */
const SECCIONES: Record<string, string> = {
  via: 'vía',
  course: 'curso',
  newStudent: 'alumna nueva',
  student: 'datos de la alumna',
  previousStudies: 'curso anterior',
  pasen: 'PASEN',
  family: 'familia',
  bachillerato: 'modalidad y materias',
  annex: 'Anexo VII',
  ideario: 'ideario',
  lopd: 'protección de datos',
  economic: 'datos económicos',
  manualChecks: 'documentos en papel',
  declaration: 'declaración',
};

/**
 * El autoguardado manda un guardado por segundo: en vez de un evento por guardado, uno por
 * sesión de trabajo (15 min) de cada actor, con las partes que ha ido tocando.
 */
async function registrarEdicion(tx: Tx, m: Matricula, actor: ActorMatricula, secciones: string[]) {
  if (!secciones.length) return;
  const desde = new Date(Date.now() - 15 * 60_000);
  const [ultimo] = await tx
    .select()
    .from(matriculaEventos)
    .where(
      and(
        eq(matriculaEventos.matriculaId, m.id),
        eq(matriculaEventos.tipo, 'EDITADA'),
        gt(matriculaEventos.createdAt, desde),
        actor.tipo === 'usuario' ? eq(matriculaEventos.usuarioId, actor.usuarioId) : eq(matriculaEventos.actor, 'familia'),
      ),
    )
    .orderBy(desc(matriculaEventos.createdAt))
    .limit(1);
  const todas = [...new Set([...(((ultimo?.detalle?.secciones as string[] | undefined) ?? [])), ...secciones])];
  const texto = `Cambia: ${todas.map((s) => SECCIONES[s] ?? s).join(', ')}`;
  if (ultimo) {
    await tx.update(matriculaEventos).set({ texto, detalle: { secciones: todas } }).where(eq(matriculaEventos.id, ultimo.id));
  } else {
    await evento(tx, m.id, 'EDITADA', actor, texto, { secciones: todas });
  }
}

// ── Enlaces ──────────────────────────────────────────────────────────────────

export const urlMatricula = (token: string) => `${env.PUBLIC_APP_URL}/matricula/${token}`;

async function correoPrincipal(tx: Tx, alumnaId: string) {
  const cs = await tx.select().from(alumnaContactos).where(eq(alumnaContactos.alumnaId, alumnaId));
  const ordenados = cs.sort((x, y) => Number(y.principal) - Number(x.principal) || x.orden - y.orden);
  return ordenados.find((c) => c.email)?.email ?? null;
}

/**
 * Crea un enlace (sustituye al anterior del mismo alcance y progenitor) y, si hay a quién, lo envía.
 * El token solo se ve ahora: en la BD queda su hash.
 */
async function nuevoEnlace(
  tx: Tx,
  m: Matricula,
  o: { alcance: 'FAMILIA' | 'PROGENITOR'; progenitor: Progenitor | null; para: string | null; usuarioId: string },
) {
  await tx
    .update(enlacesMatricula)
    .set({ revocadoEn: new Date() })
    .where(
      and(
        eq(enlacesMatricula.matriculaId, m.id),
        eq(enlacesMatricula.alcance, o.alcance),
        o.progenitor ? eq(enlacesMatricula.progenitor, o.progenitor) : isNull(enlacesMatricula.progenitor),
        isNull(enlacesMatricula.revocadoEn),
      ),
    );
  const token = nuevoToken();
  const expiraEn = caducidadEnlace(m.cursoEscolar);
  const [e] = await tx
    .insert(enlacesMatricula)
    .values({ matriculaId: m.id, tokenHash: hashToken(token), alcance: o.alcance, progenitor: o.progenitor, enviadoA: o.para, expiraEn, creadoPorId: o.usuarioId })
    .returning();
  const url = urlMatricula(token);

  let enviado = false;
  if (o.para) {
    const [a] = await tx.select().from(alumnas).where(eq(alumnas.id, m.alumnaId));
    const [principal] = await tx.select().from(alumnaContactos).where(and(eq(alumnaContactos.alumnaId, m.alumnaId), eq(alumnaContactos.principal, true)));
    enviado = await enviarEvento(tx, o.alcance === 'FAMILIA' ? 'MATRICULA_ENLACE' : 'MATRICULA_ENLACE_PROGENITOR', {
      para: o.para,
      vars: {
        codigo: m.codigo,
        alumna: `${a!.nombre} ${a!.apellidos}`.trim(),
        tutor: principal ? nombrePila(principal.nombre) : '',
        curso: nombreVia(m.familia, m.curso),
        curso_escolar: cursoEscolarCorto(m.cursoEscolar),
        fecha_limite: diaLargo(expiraEn).toLowerCase(),
        enlace: url,
        boton: boton(url, o.alcance === 'FAMILIA' ? 'Hacer la matrícula' : 'Leer y firmar'),
      },
      solicitudId: m.solicitudId ?? undefined,
    });
  }
  const quien = o.alcance === 'FAMILIA' ? 'la familia' : o.progenitor === 'madre' ? 'la madre' : 'el padre';
  await evento(tx, m.id, 'ENLACE', { tipo: 'usuario', usuarioId: o.usuarioId }, enviado ? `Enlace enviado a ${quien}` : `Enlace creado para ${quien} (sin enviar)`, {
    enlaceId: e!.id,
    alcance: o.alcance,
    progenitor: o.progenitor,
    enviado,
  });
  return { id: e!.id, alcance: o.alcance, progenitor: o.progenitor, url, enviadoA: enviado ? o.para : null, expiraEn };
}

export async function crearEnlace(id: string, d: z.infer<typeof enlaceBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const m = await cargar(tx, id, true);
    if (m.estado !== 'BORRADOR') throw conflict('MATRICULA_ENVIADA', 'La matrícula ya está enviada: la familia no puede editarla.');
    const para = d.enviar ? (d.email ?? (d.alcance === 'FAMILIA' ? await correoPrincipal(tx, m.alumnaId) : null)) : null;
    if (d.enviar && !para) throw badRequest('SIN_CORREO', 'La familia no tiene correo en su expediente. Indica a qué correo enviarlo.');
    const enlace = await nuevoEnlace(tx, m, { alcance: d.alcance, progenitor: d.progenitor ?? null, para, usuarioId });
    return { enlace, matricula: await detalle(id, tx) };
  });
}

export async function revocarEnlace(id: string, enlaceId: string, usuarioId: string) {
  await db.transaction(async (tx) => {
    const [e] = await tx
      .update(enlacesMatricula)
      .set({ revocadoEn: new Date() })
      .where(and(eq(enlacesMatricula.id, enlaceId), eq(enlacesMatricula.matriculaId, id), isNull(enlacesMatricula.revocadoEn)))
      .returning();
    if (!e) throw notFound('Enlace no encontrado o ya anulado.', 'ENLACE_NO_ENCONTRADO');
    await evento(tx, id, 'ENLACE_ANULADO', { tipo: 'usuario', usuarioId }, 'Enlace anulado', { enlaceId });
  });
  return detalle(id);
}

/** Enlace de la familia → su matrícula. Un token desconocido es 404; uno sustituido o caducado, 410. */
export async function deToken(token: string, tx: Tx = db) {
  const [fila] = await tx
    .select({ e: enlacesMatricula, m: matriculas })
    .from(enlacesMatricula)
    .innerJoin(matriculas, eq(matriculas.id, enlacesMatricula.matriculaId))
    .where(eq(enlacesMatricula.tokenHash, hashToken(token)));
  if (!fila) throw notFound('Enlace no válido.', 'ENLACE_NO_VALIDO');
  if (fila.e.revocadoEn) throw gone('ENLACE_SUSTITUIDO', 'Este enlace ya no sirve: secretaría ha enviado uno más reciente.');
  if (fila.e.expiraEn < new Date()) throw gone('ENLACE_CADUCADO', 'Este enlace ha caducado. Contacta con secretaría.');
  await tx.update(enlacesMatricula).set({ ultimoUsoEn: new Date() }).where(eq(enlacesMatricula.id, fila.e.id));
  return fila;
}

export async function verPublica(token: string) {
  return db.transaction(async (tx) => {
    const { e, m } = await deToken(token, tx);
    return vistaPublica(tx, m, e);
  });
}

// ── Apertura ─────────────────────────────────────────────────────────────────

const CONSTRAINT_UNICA = 'matriculas_alumna_curso_escolar_uq';

async function conMatriculaUnica<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const x = e as { constraint?: string; cause?: { constraint?: string } };
    if (codigoPg(e) === '23505' && (x.constraint ?? x.cause?.constraint) === CONSTRAINT_UNICA) {
      throw conflict('MATRICULA_YA_EXISTE', 'Esta alumna ya tiene matrícula para ese curso escolar.');
    }
    throw e;
  }
}

/**
 * Abre la matrícula de una alumna en la transacción dada.
 *  - «Reserva confirmada» o «En proceso» (admisión, Séneca, alta manual): su curso escolar, alumna nueva.
 *    El expediente pasa a «En proceso».
 *  - «Matriculada» en 1º: renovación a 2º del curso siguiente, a partir de su matrícula de 1º.
 */
async function abrir(tx: Tx, alumnaId: string, enviarEnlace: boolean, usuarioId: string) {
  const [a] = await tx.select().from(alumnas).where(eq(alumnas.id, alumnaId)).for('update');
  if (!a) throw notFound('Expediente no encontrado.', 'ALUMNA_NO_ENCONTRADA');
  if (a.estado === 'BAJA') throw conflict('ALUMNA_DE_BAJA', 'El expediente está de baja: reactívalo antes de abrir la matrícula.');

  const renovacion = a.estado === 'MATRICULADA';
  if (renovacion && a.curso === 2) throw conflict('SIN_CURSO_SIGUIENTE', 'La alumna ya está en 2º: no hay curso siguiente que matricular.');
  if (renovacion && a.promociona === false) throw conflict('NO_PROMOCIONA', 'El expediente indica que la alumna no promociona a 2º.');
  const destino = renovacion ? cursoEscolarSiguiente(a.cursoEscolar) : a.cursoEscolar;
  const curso: (typeof CURSOS)[number] = renovacion ? '2' : a.curso === 2 ? '2' : '1';

  const [existente] = await tx
    .select({ id: matriculas.id, codigo: matriculas.codigo })
    .from(matriculas)
    .where(and(eq(matriculas.alumnaId, a.id), eq(matriculas.cursoEscolar, destino)));
  if (existente) throw conflict('MATRICULA_YA_EXISTE', `Esta alumna ya tiene matrícula para ${destino}: ${existente.codigo}.`, existente);

  let datos: Borrador;
  if (renovacion) {
    const [anterior] = await tx
      .select({ datos: matriculas.datos })
      .from(matriculas)
      .where(and(eq(matriculas.alumnaId, a.id), eq(matriculas.cursoEscolar, a.cursoEscolar)));
    const contactos = anterior ? [] : await tx.select().from(alumnaContactos).where(eq(alumnaContactos.alumnaId, a.id));
    datos = anterior ? borradorDeRenovacion(anterior.datos, a) : borradorDesdeExpediente(a, contactos, CENTRO.nombre, '2');
  } else {
    const contactos = await tx.select().from(alumnaContactos).where(eq(alumnaContactos.alumnaId, a.id));
    const [s] = a.solicitudId ? await tx.select({ centro: solicitudes.centroProcedencia }).from(solicitudes).where(eq(solicitudes.id, a.solicitudId)) : [];
    datos = borradorDesdeExpediente(a, contactos, s?.centro ?? null, curso);
  }

  const [m] = await tx
    .insert(matriculas)
    .values({
      codigo: formatoCodigoMatricula(destino, await siguienteValor(tx, `matricula-${destino.slice(0, 4)}`)),
      alumnaId: a.id,
      solicitudId: renovacion ? null : a.solicitudId,
      cursoEscolar: destino,
      familia: a.familia,
      curso: Number(curso),
      nuevaAlumna: isNewStudent(datos),
      datos,
      creadaPorId: usuarioId,
    })
    .returning();
  const actor = { tipo: 'usuario' as const, usuarioId };
  await evento(tx, m!.id, 'CREADA', actor, renovacion ? `Renovación a ${nombreVia(a.familia, 2)} · ${destino}` : `Matrícula abierta · ${destino}`);
  if (!renovacion) await estadoPorMatricula(tx, a.id, 'EN_PROCESO', `matrícula ${m!.codigo}`, usuarioId);

  const para = enviarEnlace ? await correoPrincipal(tx, a.id) : null;
  const enlace = await nuevoEnlace(tx, m!, { alcance: 'FAMILIA', progenitor: null, para, usuarioId });
  return { matricula: m!, enlace };
}

export async function crear(d: z.infer<typeof crearMatriculaBody>, usuarioId: string) {
  return conMatriculaUnica(() =>
    db.transaction(async (tx) => {
      const { matricula, enlace } = await abrir(tx, d.alumnaId, d.enviarEnlace, usuarioId);
      return { enlace, matricula: await detalle(matricula.id, tx) };
    }),
  );
}

/**
 * Apertura en bloque de 2º: alumnas de 1º matriculadas de esa vía y curso que promocionan
 * (reunión del 21/10). Cada una en su transacción: una que falle no frena al resto.
 */
export async function renovacion(d: z.infer<typeof renovacionBody>, usuarioId: string) {
  const candidatas = await db
    .select({ id: alumnas.id, expediente: alumnas.expediente, promociona: alumnas.promociona })
    .from(alumnas)
    .where(
      and(
        eq(alumnas.familia, d.familia),
        eq(alumnas.curso, 1),
        eq(alumnas.cursoEscolar, d.cursoEscolar),
        eq(alumnas.estado, 'MATRICULADA'),
        d.alumnaIds ? inArray(alumnas.id, d.alumnaIds) : eq(alumnas.promociona, true),
      ),
    );
  const creadas: { alumnaId: string; expediente: string; matriculaId: string; codigo: string; enlaceEnviadoA: string | null }[] = [];
  const omitidas: { alumnaId: string; expediente: string; motivo: string }[] = [];
  for (const a of candidatas) {
    try {
      // En serie a propósito: una transacción por alumna.
      const r = await conMatriculaUnica(() => db.transaction((tx) => abrir(tx, a.id, d.enviarEnlace, usuarioId)));
      creadas.push({ alumnaId: a.id, expediente: a.expediente, matriculaId: r.matricula.id, codigo: r.matricula.codigo, enlaceEnviadoA: r.enlace.enviadoA });
    } catch (e) {
      omitidas.push({ alumnaId: a.id, expediente: a.expediente, motivo: e instanceof Error ? e.message : 'Error' });
    }
  }
  const sinPromocion = d.alumnaIds?.filter((id) => !candidatas.some((c) => c.id === id)) ?? [];
  for (const id of sinPromocion) omitidas.push({ alumnaId: id, expediente: '', motivo: 'No es una alumna de 1º matriculada en esa vía y curso escolar.' });
  return { creadas, omitidas };
}

// ── Guardar el borrador ──────────────────────────────────────────────────────

function paginaValida(clave: string) {
  const m = PAGINA.exec(clave);
  return !!m && Number(m[2]) <= READER_DOCS[m[1] as ReaderDocId].pages;
}

/** Suma las páginas nuevas con la hora del servidor. Nunca se quitan (docs/matricula.md, punto 2). */
function sumarPaginas(actuales: Record<string, string>, nuevas: string[]) {
  const ahora = new Date().toISOString();
  const r = { ...actuales };
  let cambia = false;
  for (const p of nuevas) {
    if (paginaValida(p) && !r[p]) {
      r[p] = ahora;
      cambia = true;
    }
  }
  return { paginas: r, cambia };
}

function comprobarEditable(m: Matricula, actor: ActorMatricula) {
  if (m.estado === 'EXPORTADA') throw conflict('MATRICULA_EXPORTADA', 'La matrícula ya está cargada en Séneca: no se puede cambiar.');
  if (actor.tipo === 'familia' && m.estado !== 'BORRADOR') {
    throw conflict('MATRICULA_ENVIADA', 'La matrícula ya está enviada. Si hay que cambiar algo, contacta con secretaría.');
  }
}

async function versionAntigua(tx: Tx, m: Matricula) {
  const [u] = m.guardadoPorId ? await tx.select({ nombre: usuarios.nombre }).from(usuarios).where(eq(usuarios.id, m.guardadoPorId)) : [];
  const quien = m.guardadoPor === 'familia' ? 'La familia' : (u?.nombre ?? 'Secretaría');
  return conflict('VERSION_ANTIGUA', `${quien} ha cambiado esta matrícula mientras la tenías abierta. Recarga para ver sus cambios.`, {
    version: m.version,
    guardadoPor: m.guardadoPor,
    guardadoPorNombre: m.guardadoPor === 'familia' ? null : (u?.nombre ?? null),
    guardadoEn: m.guardadoEn,
  });
}

export { jsonCanonico };

const iguales = (a: unknown, b: unknown) => jsonCanonico(a) === jsonCanonico(b);

/**
 * Guarda el borrador si `version` es la actual. Un guardado sin cambios no sube la versión
 * (el autoguardado puede repetir el mismo). Devuelve la matrícula con la versión nueva.
 */
async function guardar(tx: Tx, m: Matricula, d: z.infer<typeof guardarBody>, actor: ActorMatricula): Promise<Matricula> {
  comprobarEditable(m, actor);
  if (d.version !== m.version) throw await versionAntigua(tx, m);

  const { photo: _f, documents: _d, signatures: _s, readPages, ...resto } = d.borrador;
  let datos: Borrador = { ...resto, readPages: {} };
  if (actor.tipo === 'familia') {
    // Desde el enlace no se cambia la vía, el curso, «alumna nueva» ni lo marcado a mano en secretaría.
    datos = { ...datos, via: m.datos.via, course: m.datos.course, newStudent: m.datos.newStudent, manualChecks: m.datos.manualChecks };
    if (actor.enlace.alcance === 'PROGENITOR') datos = m.datos;
  }
  const leidas = sumarPaginas(m.paginasLeidas, Object.keys(readPages).filter((k) => readPages[k]));
  const secciones = Object.keys(SECCIONES).filter((k) => !iguales(datos[k as keyof Borrador], m.datos[k as keyof Borrador]));
  if (!secciones.length && !leidas.cambia) return m;

  const via = datos.via ?? VIA_DE_FAMILIA[m.familia];
  const [nueva] = await tx
    .update(matriculas)
    .set({
      datos,
      paginasLeidas: leidas.paginas,
      familia: FAMILIA_DE_VIA[via],
      curso: datos.course ? Number(datos.course) : m.curso,
      nuevaAlumna: isNewStudent({ newStudent: datos.newStudent, course: datos.course ?? (String(m.curso) as '1' | '2') }),
      version: m.version + 1,
      guardadoEn: new Date(),
      guardadoPor: actor.tipo === 'familia' ? 'familia' : 'secretaria',
      guardadoPorId: actor.tipo === 'usuario' ? actor.usuarioId : null,
    })
    .where(and(eq(matriculas.id, m.id), eq(matriculas.version, m.version)))
    .returning();
  if (!nueva) throw await versionAntigua(tx, await cargar(tx, m.id));
  await registrarEdicion(tx, m, actor, secciones);
  // Un documento firmado que cambia deja de valer: se anula su firma (docs/matricula.md, punto 1).
  if (secciones.length) await anularDesactualizadas(tx, nueva, expediente(nueva), firmanteDe(actor));
  return nueva;
}

export async function guardarInterno(id: string, d: z.infer<typeof guardarBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const m = await cargar(tx, id, true);
    await guardar(tx, m, d, { tipo: 'usuario', usuarioId });
    return detalle(id, tx);
  });
}

export async function guardarPublica(token: string, d: z.infer<typeof guardarBody>) {
  return db.transaction(async (tx) => {
    const { e } = await deToken(token, tx);
    const m = await cargar(tx, e.matriculaId, true);
    return vistaPublica(tx, await guardar(tx, m, d, { tipo: 'familia', enlace: e }), e);
  });
}

/**
 * Marca páginas como leídas sin tocar el borrador ni su versión: así un progenitor puede leer
 * mientras la familia rellena, sin conflictos. La hora la pone el servidor.
 */
async function marcarPaginas(tx: Tx, m: Matricula, paginas: string[]) {
  if (m.estado !== 'BORRADOR') throw conflict('MATRICULA_ENVIADA', 'La matrícula ya está enviada.');
  const leidas = sumarPaginas(m.paginasLeidas, paginas);
  if (!leidas.cambia) return m;
  const [nueva] = await tx.update(matriculas).set({ paginasLeidas: leidas.paginas }).where(eq(matriculas.id, m.id)).returning();
  return nueva!;
}

export async function paginasInterno(id: string, paginas: string[]) {
  return db.transaction(async (tx) => {
    await marcarPaginas(tx, await cargar(tx, id, true), paginas);
    return detalle(id, tx);
  });
}

export async function paginasPublica(token: string, paginas: string[]) {
  return db.transaction(async (tx) => {
    const { e } = await deToken(token, tx);
    const m = await marcarPaginas(tx, await cargar(tx, e.matriculaId, true), paginas);
    return vistaPublica(tx, m, e);
  });
}

// ── Documentos y firmas ──────────────────────────────────────────────────────

const firmanteDe = (a: ActorMatricula): Firmante => (a.tipo === 'familia' ? { enlace: a.enlace } : { usuarioId: a.usuarioId });

export async function documentoInterno(id: string, doc: ReaderDocId) {
  return db.transaction(async (tx) => {
    const m = await cargar(tx, id);
    return firmasSrv.documento(tx, m, expediente(m), doc, null);
  });
}

export async function documentoPublico(token: string, doc: ReaderDocId) {
  return db.transaction(async (tx) => {
    const { e, m } = await deToken(token, tx);
    return firmasSrv.documento(tx, m, expediente(m), doc, e);
  });
}

type Hueco = z.infer<typeof firmasSrv.huecoParam>;

export async function firmarInterno(id: string, hueco: Hueco, d: z.infer<typeof firmasSrv.firmaBody>, usuarioId: string, ev: Evidencias) {
  return db.transaction(async (tx) => {
    const m = await cargar(tx, id, true);
    await firmasSrv.firmar(tx, m, expediente(m), hueco, d, { usuarioId }, ev);
    return detalle(id, tx);
  });
}

export async function firmarPublica(token: string, hueco: Hueco, d: z.infer<typeof firmasSrv.firmaBody>, ev: Evidencias) {
  return db.transaction(async (tx) => {
    const { e } = await deToken(token, tx);
    const m = await cargar(tx, e.matriculaId, true);
    await firmasSrv.firmar(tx, m, expediente(m), hueco, d, { enlace: e }, ev);
    return vistaPublica(tx, m, e);
  });
}

export async function borrarFirmaInterno(id: string, hueco: Hueco, usuarioId: string) {
  return db.transaction(async (tx) => {
    const m = await cargar(tx, id, true);
    await firmasSrv.borrar(tx, m, hueco, { usuarioId });
    return detalle(id, tx);
  });
}

export async function borrarFirmaPublica(token: string, hueco: Hueco) {
  return db.transaction(async (tx) => {
    const { e } = await deToken(token, tx);
    const m = await cargar(tx, e.matriculaId, true);
    await firmasSrv.borrar(tx, m, hueco, { enlace: e });
    return vistaPublica(tx, m, e);
  });
}
