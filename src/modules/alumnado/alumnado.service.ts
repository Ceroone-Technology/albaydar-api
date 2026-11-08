import { and, asc, count, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  alumnaContactos,
  alumnaEventos,
  alumnas,
  cobros,
  correosSalientes,
  entrevistas,
  estadoAlumnaEnum,
  familiaViaEnum,
  solicitudes,
  usuarios,
  type Alumna,
  type AlumnaContacto,
  type Solicitud,
  type Via,
} from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { euros } from '../../lib/dinero';
import { documentoValido, normalizarDocumento } from '../../lib/documento-identidad';
import { badRequest, codigoPg, conflict, notFound } from '../../lib/errors';
import { diaLargo, fechaLocal, franja } from '../../lib/fechas';
import { ETIQUETA_VALORACION } from '../entrevistas/ficha';
import { siguienteValor } from '../solicitudes/comun';
import {
  ETAPA,
  ETIQUETA_CANAL,
  ETIQUETA_CONCEPTO_COBRO,
  ETIQUETA_ESTADO_ENTREVISTA,
  ETIQUETA_FAMILIA_VIA,
  ETIQUETA_METODO_PAGO,
  nombreVia,
} from '../solicitudes/dominio';
import {
  ESTADOS_EDITABLES,
  ESTADOS_VINCULAN_FAMILIA,
  ETIQUETA_ESTADO_ALUMNA,
  ETIQUETA_ORIGEN_ALUMNA,
  MOTIVO_RESERVA_ANULADA,
  PARENTESCO_TUTOR_SOLICITUD,
  TONO_ESTADO_ALUMNA,
  formatoExpediente,
} from './dominio';

/**
 * Alumnado: expedientes, familias e histórico de interacciones (pantalla Alumnado del mockup).
 *  - El expediente nace solo al pagar la reserva (`altaDesdeReserva`, en la transacción del cobro),
 *    por alta manual o, más adelante, importado de Séneca.
 *  - Si se anula el cobro que confirmaba la plaza, el expediente recién creado se retira
 *    (`retirarAltaDeReserva`): se borra si nadie lo ha tocado; si tiene notas o cambios, pasa a baja.
 *  - Todo cambio queda en `alumna_eventos`, sin copiar los datos personales: solo qué campos cambiaron.
 */

// ── Esquemas ─────────────────────────────────────────────────────────────────

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha con formato AAAA-MM-DD.');

/** Texto opcional: '' o solo espacios → null. */
const textoOpcional = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable().optional());

const emailOpcional = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toLowerCase()) : v),
  z.string().email('El correo no es válido.').max(254).nullable().optional(),
);

/** DNI o NIE: se normaliza y se comprueba la letra. */
const documento = z
  .string()
  .transform(normalizarDocumento)
  .refine(documentoValido, 'El DNI o NIE no es válido: revisa los números y la letra.');

const fechaNacimiento = fecha.refine((f) => f >= '1950-01-01' && f <= fechaLocal(new Date()), 'La fecha de nacimiento no es válida.');

const cursoEscolar = z
  .string()
  .regex(/^\d{4}-\d{4}$/, 'Curso escolar con formato 2027-2028.')
  .refine((c) => Number(c.slice(5)) === Number(c.slice(0, 4)) + 1, 'Curso escolar con formato 2027-2028.');

export const contactoEntrada = z.object({
  parentesco: z.string().trim().min(1, 'Indica el parentesco del contacto.').max(80),
  nombre: z.string().trim().min(1, 'Indica el nombre del contacto.').max(200),
  telefono: z.string().trim().min(6, 'Indica el teléfono del contacto.').max(30),
  email: emailOpcional,
  principal: z.boolean().optional(),
});

const contactos = z.array(contactoEntrada).max(6, 'Como mucho 6 contactos.');

export const crearAlumnaBody = z.object({
  nombre: z.string().trim().min(1, 'Indica el nombre.').max(100),
  apellidos: z.string().trim().min(1, 'Indica los apellidos.').max(150),
  documento,
  fechaNacimiento,
  email: emailOpcional,
  telefono: textoOpcional(30),
  domicilio: textoOpcional(300),
  familia: z.enum(familiaViaEnum.enumValues),
  curso: z.union([z.literal(1), z.literal(2)]),
  cursoEscolar,
  estudios: textoOpcional(150),
  estado: z.enum(ESTADOS_EDITABLES),
  promociona: z.boolean().nullable().optional(),
  contactos: contactos.optional(),
});

/** PATCH: todo opcional y sin `.default()` (trampa 1). `contactos`, si llega, sustituye la lista entera. */
export const editarAlumnaBody = z
  .object({
    nombre: z.string().trim().min(1, 'Indica el nombre.').max(100).optional(),
    apellidos: z.string().trim().min(1, 'Indica los apellidos.').max(150).optional(),
    documento: documento.nullable().optional(),
    fechaNacimiento: fechaNacimiento.nullable().optional(),
    email: emailOpcional,
    telefono: textoOpcional(30),
    domicilio: textoOpcional(300),
    familia: z.enum(familiaViaEnum.enumValues).optional(),
    curso: z.union([z.literal(1), z.literal(2)]).optional(),
    cursoEscolar: cursoEscolar.optional(),
    estudios: textoOpcional(150),
    /** En una baja, reactiva el expediente en ese estado. */
    estado: z.enum(ESTADOS_EDITABLES).optional(),
    promociona: z.boolean().nullable().optional(),
    contactos: contactos.optional(),
  })
  .strict();

export const bajaBody = z.object({
  motivo: z.string().trim().min(1, 'Indica el motivo de la baja.').max(500),
  /** Por defecto, hoy. Nunca futura. */
  fecha: fecha.optional(),
});

export const notaBody = z.object({
  texto: z.string().trim().min(1, 'Escribe la nota.').max(2000),
});

const booleano = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listarAlumnasQuery = z.object({
  /** Nombre, apellidos, DNI/NIE o número de expediente (sin importar tildes ni mayúsculas). */
  q: z.string().trim().max(100).optional(),
  familia: z.enum(familiaViaEnum.enumValues).optional(),
  curso: z.coerce.number().int().min(1).max(2).optional(),
  cursoEscolar: z.string().regex(/^\d{4}-\d{4}$/).optional(),
  estado: z.enum(estadoAlumnaEnum.enumValues).optional(),
  promociona: booleano.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

type ContactoEntrada = z.infer<typeof contactoEntrada>;

// ── Vistas ───────────────────────────────────────────────────────────────────

function vistaContacto(c: AlumnaContacto) {
  return { id: c.id, parentesco: c.parentesco, nombre: c.nombre, telefono: c.telefono, email: c.email, principal: c.principal };
}

function vista(a: Alumna, cs: AlumnaContacto[], solicitud: { id: string; codigo: string } | null) {
  return {
    id: a.id,
    expediente: a.expediente,
    nombre: a.nombre,
    apellidos: a.apellidos,
    nombreCompleto: `${a.nombre} ${a.apellidos}`.trim(),
    documento: a.documento,
    email: a.email,
    telefono: a.telefono,
    fechaNacimiento: a.fechaNacimiento,
    domicilio: a.domicilio,
    familia: a.familia,
    familiaEtiqueta: ETIQUETA_FAMILIA_VIA[a.familia],
    etapa: ETAPA[a.familia],
    curso: a.curso,
    cursoEtiqueta: nombreVia(a.familia, a.curso),
    cursoEscolar: a.cursoEscolar,
    estudios: a.estudios,
    estado: a.estado,
    estadoEtiqueta: ETIQUETA_ESTADO_ALUMNA[a.estado],
    estadoTono: TONO_ESTADO_ALUMNA[a.estado],
    origen: a.origen,
    origenEtiqueta: ETIQUETA_ORIGEN_ALUMNA[a.origen],
    promociona: a.promociona,
    fechaAlta: a.fechaAlta,
    baja: a.fechaBaja ? { fecha: a.fechaBaja, motivo: a.motivoBaja } : null,
    solicitud,
    contactos: [...cs].sort((x, y) => Number(y.principal) - Number(x.principal) || x.orden - y.orden).map(vistaContacto),
    creadaEn: a.createdAt,
    actualizadaEn: a.updatedAt,
  };
}

export type VistaAlumna = ReturnType<typeof vista>;

async function contactosDe(tx: Tx, ids: string[]) {
  if (!ids.length) return new Map<string, AlumnaContacto[]>();
  const filas = await tx.select().from(alumnaContactos).where(inArray(alumnaContactos.alumnaId, ids));
  const m = new Map<string, AlumnaContacto[]>();
  for (const c of filas) m.set(c.alumnaId, [...(m.get(c.alumnaId) ?? []), c]);
  return m;
}

// ── Listado ──────────────────────────────────────────────────────────────────

/** Minúsculas y sin tildes, en JS y en SQL igual (sin depender de la extensión unaccent). */
const plegar = (t: string) => t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
const plegarSql = (col: SQL) => sql`translate(lower(${col}), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc')`;

function filtros(q: z.infer<typeof listarAlumnasQuery>): SQL | undefined {
  const c: SQL[] = [];
  if (q.familia) c.push(eq(alumnas.familia, q.familia));
  if (q.curso) c.push(eq(alumnas.curso, q.curso));
  if (q.cursoEscolar) c.push(eq(alumnas.cursoEscolar, q.cursoEscolar));
  if (q.estado) c.push(eq(alumnas.estado, q.estado));
  if (q.promociona !== undefined) c.push(eq(alumnas.promociona, q.promociona));
  if (q.q) {
    const t = `%${plegar(q.q).replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    const doc = `%${normalizarDocumento(q.q).replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    c.push(
      or(
        sql`${plegarSql(sql`${alumnas.nombre} || ' ' || ${alumnas.apellidos}`)} like ${t}`,
        sql`${plegarSql(sql`${alumnas.apellidos} || ', ' || ${alumnas.nombre}`)} like ${t}`,
        sql`${alumnas.documento} like ${doc}`,
        sql`lower(${alumnas.expediente}) like ${t}`,
      )!,
    );
  }
  return c.length ? and(...c) : undefined;
}

export async function listar(q: z.infer<typeof listarAlumnasQuery>) {
  const where = filtros(q);
  const [filas, [total]] = await Promise.all([
    db
      .select({ a: alumnas, codigo: solicitudes.codigo })
      .from(alumnas)
      .leftJoin(solicitudes, eq(solicitudes.id, alumnas.solicitudId))
      .where(where)
      .orderBy(asc(alumnas.apellidos), asc(alumnas.nombre), asc(alumnas.expediente))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(alumnas).where(where),
  ]);
  const cs = await contactosDe(db, filas.map((f) => f.a.id));
  return {
    items: filas.map(({ a, codigo }) => vista(a, cs.get(a.id) ?? [], a.solicitudId && codigo ? { id: a.solicitudId, codigo } : null)),
    page: q.page,
    pageSize: q.pageSize,
    total: total?.n ?? 0,
  };
}

// ── Ficha con historial ──────────────────────────────────────────────────────

export type TipoHistorial = 'REGISTRO' | 'CORREO' | 'ENTREVISTA' | 'COBRO' | 'NOTA';

interface ItemHistorial {
  id: string;
  fecha: Date;
  tipo: TipoHistorial;
  titulo: string;
  descripcion: string | null;
  autor: string | null;
}

const TITULO_EVENTO: Record<(typeof alumnaEventos.$inferSelect)['tipo'], string> = {
  ALTA: 'Alta del expediente',
  EDICION: 'Datos del expediente actualizados',
  ESTADO: 'Cambio de estado',
  BAJA: 'Baja',
  REACTIVADA: 'Expediente reactivado',
  NOTA: 'Nota interna',
};

/**
 * Historial del expediente: sus propios eventos y, si viene de una solicitud, la solicitud,
 * los correos a la familia, las entrevistas y los cobros. Del más reciente al más antiguo.
 */
async function historial(a: Alumna): Promise<ItemHistorial[]> {
  const items: ItemHistorial[] = [];
  const eventos = await db
    .select({ e: alumnaEventos, autor: usuarios.nombre })
    .from(alumnaEventos)
    .leftJoin(usuarios, eq(usuarios.id, alumnaEventos.usuarioId))
    .where(eq(alumnaEventos.alumnaId, a.id));
  for (const { e, autor } of eventos) {
    items.push({
      id: e.id,
      fecha: e.createdAt,
      tipo: e.tipo === 'NOTA' ? 'NOTA' : 'REGISTRO',
      titulo: TITULO_EVENTO[e.tipo],
      descripcion: e.texto,
      autor: autor ?? (e.usuarioId ? null : 'Sistema'),
    });
  }
  if (!a.solicitudId) return items.sort((x, y) => y.fecha.getTime() - x.fecha.getTime());

  const sid = a.solicitudId;
  const [s] = await db.select().from(solicitudes).where(eq(solicitudes.id, sid));
  if (s) {
    items.push({
      id: `solicitud-${s.id}`,
      fecha: s.createdAt,
      tipo: 'REGISTRO',
      titulo: 'Solicitud recibida',
      descripcion: `Solicitud ${s.codigo} · ${s.asignadaSnec ? 'Asignada por la Junta (SNEC)' : ETIQUETA_CANAL[s.canal]}`,
      autor: s.canal === 'SOLICITUD_WEB' ? 'Familia' : null,
    });
  }
  const correos = await db
    .select({ id: correosSalientes.id, asunto: correosSalientes.asunto, para: correosSalientes.para, estado: correosSalientes.estado, enviadoEn: correosSalientes.enviadoEn, creadoEn: correosSalientes.createdAt })
    .from(correosSalientes)
    .where(and(eq(correosSalientes.solicitudId, sid), ne(correosSalientes.plantilla, 'PRUEBA')));
  for (const c of correos) {
    const situacion = c.estado === 'ERROR' ? ' · no se pudo enviar' : c.estado === 'ENVIADO' ? '' : ' · en cola';
    items.push({ id: c.id, fecha: c.enviadoEn ?? c.creadoEn, tipo: 'CORREO', titulo: c.asunto, descripcion: `A ${c.para}${situacion}`, autor: null });
  }
  const ents = await db.select().from(entrevistas).where(eq(entrevistas.solicitudId, sid));
  for (const e of ents) {
    const partes = [`${diaLargo(e.inicio)}, ${franja(e.inicio, e.fin)} · ${e.lugar}`];
    if (e.ficha?.valoracion) partes.push(`Valoración: ${ETIQUETA_VALORACION[e.ficha.valoracion]}`);
    if (e.notas) partes.push(e.notas);
    items.push({ id: e.id, fecha: e.inicio, tipo: 'ENTREVISTA', titulo: `Entrevista · ${ETIQUETA_ESTADO_ENTREVISTA[e.estado]}`, descripcion: partes.join(' · '), autor: e.ficha?.realizadaPor ?? null });
  }
  const pagos = await db
    .select({ c: cobros, autor: usuarios.nombre })
    .from(cobros)
    .leftJoin(usuarios, eq(usuarios.id, cobros.registradoPorId))
    .where(eq(cobros.solicitudId, sid));
  for (const { c, autor } of pagos) {
    const anulado = c.anuladoEn ? ` · anulado${c.motivoAnulacion ? `: ${c.motivoAnulacion}` : ''}` : '';
    items.push({
      id: c.id,
      fecha: c.createdAt,
      tipo: 'COBRO',
      titulo: `${ETIQUETA_CONCEPTO_COBRO[c.concepto]} · ${euros(c.importe)}`,
      descripcion: `Recibo ${c.reciboNumero} · ${ETIQUETA_METODO_PAGO[c.metodo]} · pagado el ${c.fecha.split('-').reverse().join('/')}${anulado}`,
      autor,
    });
  }
  return items.sort((x, y) => y.fecha.getTime() - x.fecha.getTime());
}

async function cargar(tx: Tx, id: string, bloquear = false) {
  const q = tx.select().from(alumnas).where(eq(alumnas.id, id));
  const [a] = bloquear ? await q.for('update') : await q;
  if (!a) throw notFound('Expediente no encontrado.', 'ALUMNA_NO_ENCONTRADA');
  return a;
}

export async function detalle(id: string) {
  const a = await cargar(db, id);
  const [cs, s, h] = await Promise.all([
    db.select().from(alumnaContactos).where(eq(alumnaContactos.alumnaId, id)),
    a.solicitudId ? db.select({ id: solicitudes.id, codigo: solicitudes.codigo }).from(solicitudes).where(eq(solicitudes.id, a.solicitudId)) : Promise.resolve([]),
    historial(a),
  ]);
  return { ...vista(a, cs, s[0] ?? null), historial: h };
}

// ── Alta, edición, baja y notas ──────────────────────────────────────────────

/** Como mucho un contacto principal; si no se marca ninguno, lo es el primero. */
function prepararContactos(lista: ContactoEntrada[]) {
  const principales = lista.filter((c) => c.principal).length;
  if (principales > 1) throw badRequest('VARIOS_CONTACTOS_PRINCIPALES', 'Marca un solo contacto como principal.');
  return lista.map((c, i) => ({
    parentesco: c.parentesco,
    nombre: c.nombre,
    telefono: c.telefono,
    email: c.email ?? null,
    principal: principales ? !!c.principal : i === 0,
    orden: i,
  }));
}

async function comprobarDocumento(tx: Tx, doc: string | null | undefined, excepto?: string) {
  if (!doc) return;
  const [otra] = await tx
    .select({ id: alumnas.id, expediente: alumnas.expediente })
    .from(alumnas)
    .where(and(eq(alumnas.documento, doc), excepto ? ne(alumnas.id, excepto) : undefined));
  if (otra) throw conflict('DOCUMENTO_DUPLICADO', `Ya hay un expediente con ese DNI/NIE: ${otra.expediente}.`, { expediente: otra.expediente, id: otra.id });
}

/** Un alta simultánea con el mismo documento choca en el índice único: el mismo 409. */
async function conDocumentoUnico<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const x = e as { constraint?: string; cause?: { constraint?: string } };
    if (codigoPg(e) === '23505' && (x.constraint ?? x.cause?.constraint) === 'alumnas_documento_uq') {
      throw conflict('DOCUMENTO_DUPLICADO', 'Ya hay un expediente con ese DNI/NIE.');
    }
    throw e;
  }
}

async function nuevoExpediente(tx: Tx, hoy: string) {
  const anio = hoy.slice(0, 4);
  return formatoExpediente(anio, await siguienteValor(tx, `expediente-${anio}`));
}

async function evento(tx: Tx, alumnaId: string, tipo: (typeof alumnaEventos.$inferInsert)['tipo'], usuarioId: string | null, texto?: string | null, detalle?: Record<string, unknown>) {
  await tx.insert(alumnaEventos).values({ alumnaId, tipo, usuarioId, texto: texto ?? null, detalle });
}

/** Alta manual (secretaría). */
export async function crear(d: z.infer<typeof crearAlumnaBody>, usuarioId: string) {
  const id = await conDocumentoUnico(() =>
    db.transaction(async (tx) => {
      await comprobarDocumento(tx, d.documento);
      const hoy = fechaLocal(new Date());
      const [a] = await tx
        .insert(alumnas)
        .values({
          expediente: await nuevoExpediente(tx, hoy),
          nombre: d.nombre,
          apellidos: d.apellidos,
          documento: d.documento,
          fechaNacimiento: d.fechaNacimiento,
          email: d.email ?? null,
          telefono: d.telefono ?? null,
          domicilio: d.domicilio ?? null,
          familia: d.familia,
          curso: d.curso,
          cursoEscolar: d.cursoEscolar,
          estudios: d.estudios ?? null,
          estado: d.estado,
          origen: 'MANUAL',
          promociona: d.promociona ?? null,
          fechaAlta: hoy,
          creadaPorId: usuarioId,
        })
        .returning();
      const cs = prepararContactos(d.contactos ?? []);
      if (cs.length) await tx.insert(alumnaContactos).values(cs.map((c) => ({ ...c, alumnaId: a!.id })));
      await evento(tx, a!.id, 'ALTA', usuarioId, `Alta manual · ${ETIQUETA_ESTADO_ALUMNA[d.estado]}`);
      return a!.id;
    }),
  );
  return detalle(id);
}

const CAMPOS_EDITABLES = ['nombre', 'apellidos', 'documento', 'fechaNacimiento', 'email', 'telefono', 'domicilio', 'familia', 'curso', 'cursoEscolar', 'estudios', 'promociona'] as const;

const NOMBRE_CAMPO: Record<(typeof CAMPOS_EDITABLES)[number] | 'contactos', string> = {
  nombre: 'nombre',
  apellidos: 'apellidos',
  documento: 'DNI/NIE',
  fechaNacimiento: 'fecha de nacimiento',
  email: 'correo',
  telefono: 'teléfono',
  domicilio: 'domicilio',
  familia: 'etapa',
  curso: 'curso',
  cursoEscolar: 'curso escolar',
  estudios: 'estudios',
  promociona: 'promoción',
  contactos: 'contactos de la familia',
};

export async function editar(id: string, d: z.infer<typeof editarAlumnaBody>, usuarioId: string) {
  await conDocumentoUnico(() =>
    db.transaction(async (tx) => {
      const a = await cargar(tx, id, true);
      if (d.documento !== undefined) await comprobarDocumento(tx, d.documento, id);

      const cambios: Partial<typeof alumnas.$inferInsert> = {};
      const campos: string[] = [];
      for (const k of CAMPOS_EDITABLES) {
        const nuevo = d[k];
        if (nuevo !== undefined && nuevo !== a[k]) {
          (cambios as Record<string, unknown>)[k] = nuevo;
          campos.push(NOMBRE_CAMPO[k]);
        }
      }

      if (d.estado && a.estado === 'BAJA') {
        Object.assign(cambios, { estado: d.estado, fechaBaja: null, motivoBaja: null });
        await evento(tx, id, 'REACTIVADA', usuarioId, `Vuelve a «${ETIQUETA_ESTADO_ALUMNA[d.estado]}»`, { aEstado: d.estado });
      } else if (d.estado && d.estado !== a.estado) {
        cambios.estado = d.estado;
        await evento(tx, id, 'ESTADO', usuarioId, `De «${ETIQUETA_ESTADO_ALUMNA[a.estado]}» a «${ETIQUETA_ESTADO_ALUMNA[d.estado]}»`, { deEstado: a.estado, aEstado: d.estado });
      }

      if (d.contactos) {
        const cs = prepararContactos(d.contactos);
        await tx.delete(alumnaContactos).where(eq(alumnaContactos.alumnaId, id));
        if (cs.length) await tx.insert(alumnaContactos).values(cs.map((c) => ({ ...c, alumnaId: id })));
        campos.push(NOMBRE_CAMPO.contactos);
      }

      if (Object.keys(cambios).length) await tx.update(alumnas).set(cambios).where(eq(alumnas.id, id));
      // Solo qué campos cambiaron, nunca los valores: son datos personales de menores.
      if (campos.length) await evento(tx, id, 'EDICION', usuarioId, `Cambia: ${campos.join(', ')}`, { campos });
    }),
  );
  return detalle(id);
}

export async function darDeBaja(id: string, d: z.infer<typeof bajaBody>, usuarioId: string) {
  const hoy = fechaLocal(new Date());
  const fechaBaja = d.fecha ?? hoy;
  if (fechaBaja > hoy) throw badRequest('FECHA_FUTURA', 'La fecha de la baja no puede ser posterior a hoy.');
  await db.transaction(async (tx) => {
    const a = await cargar(tx, id, true);
    if (a.estado === 'BAJA') throw conflict('YA_DE_BAJA', 'Este expediente ya está de baja.');
    await tx.update(alumnas).set({ estado: 'BAJA', fechaBaja, motivoBaja: d.motivo }).where(eq(alumnas.id, id));
    await evento(tx, id, 'BAJA', usuarioId, d.motivo, { deEstado: a.estado, fecha: fechaBaja });
  });
  return detalle(id);
}

export async function anadirNota(id: string, texto: string, usuarioId: string) {
  await db.transaction(async (tx) => {
    await cargar(tx, id);
    await evento(tx, id, 'NOTA', usuarioId, texto);
  });
  return detalle(id);
}

// ── Desde la admisión ────────────────────────────────────────────────────────

/**
 * Plaza reservada y pagada → expediente en «Reserva confirmada», con el tutor de la solicitud
 * como contacto principal. Se llama dentro de la transacción del cobro. Idempotente: si la
 * solicitud ya tiene expediente no crea otro (y si se dio de baja por anular la reserva, lo reactiva).
 */
export async function altaDesdeReserva(tx: Tx, s: Solicitud, via: Via, usuarioId: string | null) {
  const [actual] = await tx.select().from(alumnas).where(eq(alumnas.solicitudId, s.id)).for('update');
  if (actual) {
    if (actual.estado === 'BAJA' && actual.motivoBaja === MOTIVO_RESERVA_ANULADA) {
      await tx.update(alumnas).set({ estado: 'RESERVA', fechaBaja: null, motivoBaja: null }).where(eq(alumnas.id, actual.id));
      await evento(tx, actual.id, 'REACTIVADA', usuarioId, `Plaza reservada de nuevo · solicitud ${s.codigo}`, { aEstado: 'RESERVA' });
    }
    return actual.id;
  }
  const hoy = fechaLocal(new Date());
  const [a] = await tx
    .insert(alumnas)
    .values({
      expediente: await nuevoExpediente(tx, hoy),
      nombre: s.alumnaNombre,
      apellidos: s.alumnaApellidos,
      familia: via.familia,
      curso: via.curso,
      cursoEscolar: via.cursoEscolar,
      estudios: s.modalidadInteres,
      estado: 'RESERVA',
      origen: 'ADMISION',
      solicitudId: s.id,
      fechaAlta: hoy,
      creadaPorId: usuarioId,
    })
    .returning();
  const email = s.email?.trim().toLowerCase();
  await tx.insert(alumnaContactos).values({
    alumnaId: a!.id,
    parentesco: PARENTESCO_TUTOR_SOLICITUD,
    nombre: s.tutorNombre,
    telefono: s.telefono,
    email: email && z.string().email().safeParse(email).success ? email : null,
    principal: true,
  });
  await evento(tx, a!.id, 'ALTA', usuarioId, `Plaza reservada · solicitud ${s.codigo}`);
  return a!.id;
}

/**
 * Se anuló el cobro que confirmaba la plaza: el expediente que creó deja de tener sentido.
 * Si nadie lo ha tocado (solo tiene el alta), se borra; si tiene notas o cambios, pasa a baja.
 */
export async function retirarAltaDeReserva(tx: Tx, solicitudId: string, usuarioId: string | null) {
  const [a] = await tx
    .select()
    .from(alumnas)
    .where(and(eq(alumnas.solicitudId, solicitudId), eq(alumnas.estado, 'RESERVA')))
    .for('update');
  if (!a) return;
  const [otros] = await tx
    .select({ n: count() })
    .from(alumnaEventos)
    .where(and(eq(alumnaEventos.alumnaId, a.id), ne(alumnaEventos.tipo, 'ALTA')));
  if (!otros?.n) {
    await tx.delete(alumnas).where(eq(alumnas.id, a.id));
    return;
  }
  await tx.update(alumnas).set({ estado: 'BAJA', fechaBaja: fechaLocal(new Date()), motivoBaja: MOTIVO_RESERVA_ANULADA }).where(eq(alumnas.id, a.id));
  await evento(tx, a.id, 'BAJA', usuarioId, MOTIVO_RESERVA_ANULADA, { deEstado: 'RESERVA' });
}

// ── «Familia ya vinculada» ───────────────────────────────────────────────────

/**
 * Alumnas del centro (no de baja) con algún contacto con ese correo o teléfono.
 * Para la comprobación de la revisión y el filtro del kanban.
 */
export async function alumnasPorContacto(tx: Tx, emails: string[], telefonos: string[]) {
  const em = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const tel = [...new Set(telefonos.map((t) => t.trim()).filter(Boolean))];
  if (!em.length && !tel.length) return [];
  return tx
    .select({
      id: alumnas.id,
      expediente: alumnas.expediente,
      nombre: alumnas.nombre,
      apellidos: alumnas.apellidos,
      solicitudId: alumnas.solicitudId,
      email: alumnaContactos.email,
      telefono: alumnaContactos.telefono,
    })
    .from(alumnaContactos)
    .innerJoin(alumnas, eq(alumnas.id, alumnaContactos.alumnaId))
    .where(
      and(
        inArray(alumnas.estado, ESTADOS_VINCULAN_FAMILIA),
        or(...(em.length ? [inArray(alumnaContactos.email, em)] : []), ...(tel.length ? [inArray(alumnaContactos.telefono, tel)] : [])),
      ),
    )
    .orderBy(desc(alumnas.fechaAlta));
}
