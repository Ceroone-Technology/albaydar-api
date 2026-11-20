import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { enviarEvento } from '../../correo/enviar';
import {
  ciclos,
  estadoInteresadoEnum,
  familiaViaEnum,
  interesadoEventos,
  interesados,
  motivoPerdidaEnum,
  origenInteresadoEnum,
  solicitudes,
  usuarios,
  type Interesado,
} from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { diaSiguiente, fechaLocal } from '../../lib/fechas';
import { permisosDe } from '../permisos/permisos.service';
import { email, telefono } from '../solicitudes/solicitudes.schemas';
import { ETIQUETA_FAMILIA_VIA } from '../solicitudes/dominio';

/**
 * CRM básico (18/11/2026): interesados (leads) antes de la solicitud. Cubre las etapas 1 y 2 del
 * embudo de captación de Luis Fdo. (alta con correo de bienvenida, llamada antes de 24 h, ficha de
 * nivel 2 y puntuación A/B/C), la nutrición y el perdido con motivo; «Pasar a solicitud» enlaza con
 * el flujo de admisión (etapa 3 en adelante).
 */

/** Estados en los que el interesado sigue abierto (tiene que tener próxima acción). */
export const ESTADOS_ABIERTOS = ['NUEVO', 'CONTACTADO', 'NUTRICION'] as const;

const textoOpc = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida (AAAA-MM-DD).');

const datosNivel1 = {
  nombre: z.string().trim().min(1, 'Escribe el nombre.').max(160),
  telefono: telefono.or(z.literal('')).optional().nullable().transform((v) => v || null),
  email: email.or(z.literal('')).optional().nullable().transform((v) => v || null),
  familia: z.enum(familiaViaEnum.enumValues).optional().nullable(),
  cicloId: z.string().uuid().optional().nullable(),
  origen: z.enum(origenInteresadoEnum.enumValues),
  campana: textoOpc(120),
  consentimientoComunicaciones: z.boolean().default(false),
};

const datosNivel2 = {
  esMenor: z.boolean().optional().nullable(),
  tutorNombre: textoOpc(160),
  tutorTelefono: telefono.or(z.literal('')).optional().nullable().transform((v) => v || null),
  estudiosActuales: textoOpc(200),
  localidad: textoOpc(120),
  motivacion: textoOpc(500),
  otrosCentros: textoOpc(300),
  puntuacion: z.enum(['A', 'B', 'C']).optional().nullable(),
  notas: textoOpc(4000),
};

export const crearBody = z
  .object({
    ...datosNivel1,
    asesorId: z.string().uuid().optional().nullable(),
    notas: textoOpc(4000),
    /** Correo de bienvenida «te llamamos en menos de 24 h» (si hay correo). */
    enviarBienvenida: z.boolean().default(true),
    /** Darlo de alta aunque ya exista otro con el mismo correo o teléfono. */
    forzar: z.boolean().default(false),
  })
  .refine((d) => d.telefono || d.email, { message: 'Hace falta un teléfono o un correo.', path: ['telefono'] });

export const editarBody = z
  .object({
    ...datosNivel1,
    // Sin valor por defecto: si no viene, no se toca.
    consentimientoComunicaciones: z.boolean(),
    ...datosNivel2,
    asesorId: z.string().uuid().nullable(),
    proximaAccion: textoOpc(200),
    proximaAccionEl: fecha.nullable(),
    estado: z.enum(['NUEVO', 'CONTACTADO', 'NUTRICION', 'PERDIDO']),
    motivoPerdida: z.enum(motivoPerdidaEnum.enumValues).nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'No has enviado ningún dato.');

export const seguimientoBody = z
  .object({
    tipo: z.enum(['LLAMADA', 'NOTA']),
    resultado: z.enum(['CONTESTA', 'NO_CONTESTA']).optional(),
    texto: textoOpc(2000),
    proximaAccion: textoOpc(200),
    proximaAccionEl: fecha.optional().nullable(),
  })
  .refine((d) => d.tipo !== 'LLAMADA' || d.resultado, { message: 'Indica si contestó.', path: ['resultado'] })
  .refine((d) => d.tipo !== 'NOTA' || d.texto, { message: 'Escribe la nota.', path: ['texto'] });

export const listarQuery = z.object({
  estado: z.enum(estadoInteresadoEnum.enumValues).optional(),
  origen: z.enum(origenInteresadoEnum.enumValues).optional(),
  /** Un asesor o `sin` (los que aún no tienen: llegan del formulario público). */
  asesorId: z.string().uuid().or(z.literal('sin')).optional(),
  q: z.string().trim().max(120).optional(),
  /** Solo los abiertos con la próxima acción vencida (o sin ella). */
  vencidas: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ── Vista ───────────────────────────────────────────────────────────────────

const hoy = () => fechaLocal(new Date());

function estudio(familia: Interesado['familia'], ciclo: string | null) {
  if (!familia) return null;
  return ciclo ? `${ETIQUETA_FAMILIA_VIA[familia]} · ${ciclo}` : ETIQUETA_FAMILIA_VIA[familia];
}

interface Extra {
  asesor: string | null;
  ciclo: string | null;
  solicitudCodigo: string | null;
  solicitudEstado: string | null;
}

function vista(i: Interesado, x: Extra) {
  const abierto = (ESTADOS_ABIERTOS as readonly string[]).includes(i.estado);
  return {
    id: i.id,
    estado: i.estado,
    nombre: i.nombre,
    telefono: i.telefono,
    email: i.email,
    familia: i.familia,
    ciclo: i.cicloId ? { id: i.cicloId, nombre: x.ciclo ?? '' } : null,
    estudio: estudio(i.familia, x.ciclo),
    origen: i.origen,
    campana: i.campana,
    consentimientoComunicaciones: i.consentimientoComunicaciones,
    esMenor: i.esMenor,
    tutorNombre: i.tutorNombre,
    tutorTelefono: i.tutorTelefono,
    estudiosActuales: i.estudiosActuales,
    localidad: i.localidad,
    motivacion: i.motivacion,
    otrosCentros: i.otrosCentros,
    puntuacion: i.puntuacion,
    asesor: i.asesorId ? { id: i.asesorId, nombre: x.asesor ?? '' } : null,
    proximaAccion: i.proximaAccion,
    proximaAccionEl: i.proximaAccionEl,
    /** Abierto y con la próxima acción para antes de hoy (o sin ella). */
    vencida: abierto && (!i.proximaAccionEl || i.proximaAccionEl < hoy()),
    intentos: i.intentos,
    ultimoContactoEn: i.ultimoContactoEn,
    motivoPerdida: i.motivoPerdida,
    solicitud: i.solicitudId ? { id: i.solicitudId, codigo: x.solicitudCodigo ?? '', estado: x.solicitudEstado } : null,
    notas: i.notas,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

const columnas = {
  i: interesados,
  asesor: usuarios.nombre,
  ciclo: ciclos.nombre,
  solicitudCodigo: solicitudes.codigo,
  solicitudEstado: solicitudes.estado,
};

const consulta = (tx: Tx | typeof db) =>
  tx
    .select(columnas)
    .from(interesados)
    .leftJoin(usuarios, eq(usuarios.id, interesados.asesorId))
    .leftJoin(ciclos, eq(ciclos.id, interesados.cicloId))
    .leftJoin(solicitudes, eq(solicitudes.id, interesados.solicitudId));

// ── Listado ─────────────────────────────────────────────────────────────────

function filtros(q: z.infer<typeof listarQuery>, conEstado = true): SQL | undefined {
  const c: SQL[] = [];
  if (conEstado && q.estado) c.push(eq(interesados.estado, q.estado));
  if (q.origen) c.push(eq(interesados.origen, q.origen));
  if (q.asesorId === 'sin') c.push(isNull(interesados.asesorId));
  else if (q.asesorId) c.push(eq(interesados.asesorId, q.asesorId));
  if (q.q) {
    const like = `%${q.q}%`;
    c.push(or(ilike(interesados.nombre, like), ilike(interesados.email, like), ilike(interesados.telefono, like))!);
  }
  if (q.vencidas) {
    c.push(inArray(interesados.estado, [...ESTADOS_ABIERTOS]));
    c.push(or(sql`${interesados.proximaAccionEl} is null`, lt(interesados.proximaAccionEl, hoy()))!);
  }
  return c.length ? and(...c) : undefined;
}

export async function listar(q: z.infer<typeof listarQuery>) {
  const where = filtros(q);
  const [filas, [total], porEstado, [vencidas]] = await Promise.all([
    consulta(db)
      .where(where)
      // Primero lo que hay que hacer antes: próxima acción más temprana; sin ella, al principio.
      .orderBy(sql`${interesados.proximaAccionEl} asc nulls first`, desc(interesados.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(interesados).where(where),
    // Totales por estado con el resto de filtros (las pestañas del listado).
    db.select({ estado: interesados.estado, n: count() }).from(interesados).where(filtros(q, false)).groupBy(interesados.estado),
    db
      .select({ n: count() })
      .from(interesados)
      .where(filtros({ ...q, estado: undefined, vencidas: true }, false)),
  ]);
  return {
    items: filas.map(({ i, ...x }) => vista(i, x)),
    page: q.page,
    pageSize: q.pageSize,
    total: total?.n ?? 0,
    porEstado: Object.fromEntries(estadoInteresadoEnum.enumValues.map((e) => [e, porEstado.find((p) => p.estado === e)?.n ?? 0])),
    vencidas: vencidas?.n ?? 0,
  };
}

// ── Ficha ───────────────────────────────────────────────────────────────────

async function cargar(tx: Tx | typeof db, id: string) {
  const [f] = await consulta(tx).where(eq(interesados.id, id));
  if (!f) throw notFound('Interesado no encontrado.');
  return f;
}

export async function detalle(id: string) {
  const { i, ...x } = await cargar(db, id);
  const eventos = await db
    .select({ e: interesadoEventos, autor: usuarios.nombre })
    .from(interesadoEventos)
    .leftJoin(usuarios, eq(usuarios.id, interesadoEventos.usuarioId))
    .where(eq(interesadoEventos.interesadoId, id))
    .orderBy(desc(interesadoEventos.createdAt));
  return {
    ...vista(i, x),
    historial: eventos.map(({ e, autor }) => ({ id: e.id, tipo: e.tipo, texto: e.texto, detalle: e.detalle, autor, fecha: e.createdAt })),
  };
}

async function evento(
  tx: Tx,
  interesadoId: string,
  tipo: (typeof interesadoEventos.$inferInsert)['tipo'],
  usuarioId: string | null,
  texto: string | null = null,
  detalle: Record<string, unknown> | null = null,
) {
  await tx.insert(interesadoEventos).values({ interesadoId, tipo, texto, detalle, usuarioId });
}

/** El ciclo solo en las vías de ciclos y de la lista activa. */
async function comprobarCiclo(tx: Tx, familia: Interesado['familia'] | undefined, cicloId: string | null | undefined) {
  if (!cicloId) return;
  if (!familia || familia === 'BACHILLERATO') throw badRequest('CICLO_NO_VALIDO', 'El ciclo solo se elige en las vías de ciclos.');
  const [c] = await tx
    .select({ id: ciclos.id })
    .from(ciclos)
    .where(and(eq(ciclos.id, cicloId), eq(ciclos.familia, familia), eq(ciclos.activo, true)));
  if (!c) throw badRequest('CICLO_NO_VALIDO', 'El ciclo elegido no se imparte en esa etapa.');
}

async function comprobarAsesor(tx: Tx, asesorId: string | null | undefined) {
  if (!asesorId) return;
  const [u] = await tx.select({ id: usuarios.id }).from(usuarios).where(and(eq(usuarios.id, asesorId), eq(usuarios.activo, true)));
  if (!u) throw badRequest('ASESOR_NO_VALIDO', 'Esa persona no existe o está desactivada.');
}

/** Personal que puede llevar interesados: activo y con «crm.editar» (o Dirección). */
export async function asesores() {
  const filas = await db.select().from(usuarios).where(eq(usuarios.activo, true)).orderBy(asc(usuarios.nombre));
  const pueden = await Promise.all(filas.map(async (u) => ((ef) => ef.superadmin || ef.permisos.includes('crm.editar'))(await permisosDe(u.roles))));
  return { items: filas.filter((_, n) => pueden[n]).map((u) => ({ id: u.id, nombre: u.nombre })) };
}

// ── Alta ────────────────────────────────────────────────────────────────────

export async function crear(d: z.infer<typeof crearBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    await comprobarCiclo(tx, d.familia, d.cicloId);
    const asesorId = d.asesorId ?? usuarioId;
    await comprobarAsesor(tx, asesorId);

    // Duplicados por correo o teléfono (los abiertos y los que pasaron a solicitud).
    if (!d.forzar) {
      const mismos = [d.email ? eq(interesados.email, d.email) : null, d.telefono ? eq(interesados.telefono, d.telefono) : null].filter(
        (x): x is SQL => x !== null,
      );
      const [otro] = await tx
        .select({ id: interesados.id, nombre: interesados.nombre, estado: interesados.estado })
        .from(interesados)
        .where(and(or(...mismos), sql`${interesados.estado} <> 'PERDIDO'`))
        .limit(1);
      if (otro) throw conflict('INTERESADO_DUPLICADO', `Ya existe un interesado con ese correo o teléfono: ${otro.nombre}.`, otro);
    }

    const [i] = await tx
      .insert(interesados)
      .values({
        nombre: d.nombre,
        telefono: d.telefono,
        email: d.email,
        familia: d.familia ?? null,
        cicloId: d.cicloId ?? null,
        origen: d.origen,
        campana: d.campana,
        consentimientoComunicaciones: d.consentimientoComunicaciones,
        notas: d.notas,
        asesorId,
        // «Llamar antes de 24 h»: la primera próxima acción, para mañana.
        proximaAccion: 'Llamar antes de 24 h',
        proximaAccionEl: diaSiguiente(hoy()),
        creadoPorId: usuarioId,
      })
      .returning();
    await evento(tx, i!.id, 'ALTA', usuarioId, null, { origen: d.origen, campana: d.campana });

    let bienvenidaEnviada = false;
    if (d.enviarBienvenida && d.email) {
      const { asesor, ciclo } = await cargar(tx, i!.id);
      bienvenidaEnviada = await enviarEvento(tx, 'BIENVENIDA_INTERESADO', {
        para: d.email,
        vars: { nombre: d.nombre.split(/\s+/)[0] ?? d.nombre, estudio: estudio(i!.familia, ciclo) ?? 'nuestros estudios', asesor: asesor ?? '' },
      });
      if (bienvenidaEnviada) await evento(tx, i!.id, 'CORREO', usuarioId, 'Bienvenida: te llamamos en menos de 24 horas');
    }
    return { id: i!.id, bienvenidaEnviada };
  });
}

// ── Formulario público «Pide información» (19/11/2026) ──────────────────────

/**
 * El mini formulario al que llevan las campañas de redes y los códigos QR: nombre, correo,
 * teléfono y estudio, más el consentimiento. El enlace trae el origen (`?origen=redes`, o el
 * `utm_source` de la plataforma de anuncios); sin él, «Web». Sin campaña (decidido el 19/11/2026).
 */
export const altaPublicaBody = z
  .object({
    nombre: z.string().trim().min(2, 'Escribe tu nombre.').max(160),
    email,
    telefono,
    familia: z.enum(familiaViaEnum.enumValues),
    cicloId: z.string().uuid().optional().nullable(),
    consentimiento: z.literal(true, { message: 'Hace falta tu consentimiento para que te contactemos.' }),
    origen: z.enum(origenInteresadoEnum.enumValues).default('WEB'),
    /** Trampa para robots: un campo oculto que una persona deja vacío. */
    website: z.string().max(500).optional(),
  })
  .refine((d) => d.familia === 'BACHILLERATO' || d.cicloId, { message: 'Elige el ciclo.', path: ['cicloId'] });

/** Quien llega por el formulario no tiene aún asesor: la bienvenida firma el equipo. */
const ASESOR_SIN_ASIGNAR = 'el equipo de admisión';

/**
 * Alta desde el formulario público. Siempre responde lo mismo (no revela si el correo ya estaba):
 *  - Nuevo: interesado «Nuevo» sin asesor (el reparto es abierto, acuerdo del 18/11/2026), con
 *    «Llamar antes de 24 h» para mañana y el correo de bienvenida.
 *  - Ya estaba abierto o pasó a solicitud (mismo correo o teléfono): no se duplica; se apunta en
 *    su historial y, si sigue abierto, la próxima acción pasa a «Volvió a pedir información» para mañana.
 *  - La trampa para robots rellena: no se guarda nada.
 */
export async function altaPublica(d: z.infer<typeof altaPublicaBody>) {
  if (d.website) return { nuevo: false };
  const familia = d.familia;
  const cicloId = familia === 'BACHILLERATO' ? null : (d.cicloId ?? null);
  return db.transaction(async (tx) => {
    await comprobarCiclo(tx, familia, cicloId);
    const [otro] = await tx
      .select({ id: interesados.id, estado: interesados.estado })
      .from(interesados)
      .where(and(or(eq(interesados.email, d.email), eq(interesados.telefono, d.telefono)), sql`${interesados.estado} <> 'PERDIDO'`))
      .orderBy(desc(interesados.createdAt))
      .limit(1);

    if (otro) {
      const abierto = (ESTADOS_ABIERTOS as readonly string[]).includes(otro.estado);
      if (abierto) {
        await tx
          .update(interesados)
          .set({ proximaAccion: 'Volvió a pedir información: llamar', proximaAccionEl: diaSiguiente(hoy()), updatedAt: new Date() })
          .where(eq(interesados.id, otro.id));
      }
      await evento(tx, otro.id, 'NOTA', null, 'Volvió a pedir información desde el formulario web', {
        origen: d.origen,
        nombre: d.nombre,
        email: d.email,
        telefono: d.telefono,
      });
      return { nuevo: false };
    }

    const [i] = await tx
      .insert(interesados)
      .values({
        nombre: d.nombre,
        telefono: d.telefono,
        email: d.email,
        familia,
        cicloId,
        origen: d.origen,
        consentimientoComunicaciones: true,
        asesorId: null,
        proximaAccion: 'Llamar antes de 24 h',
        proximaAccionEl: diaSiguiente(hoy()),
        creadoPorId: null,
      })
      .returning();
    await evento(tx, i!.id, 'ALTA', null, 'Desde el formulario «Pide información»', { origen: d.origen, formulario: true });

    const { ciclo } = await cargar(tx, i!.id);
    const enviada = await enviarEvento(tx, 'BIENVENIDA_INTERESADO', {
      para: d.email,
      vars: { nombre: d.nombre.split(/\s+/)[0] ?? d.nombre, estudio: estudio(familia, ciclo) ?? 'nuestros estudios', asesor: ASESOR_SIN_ASIGNAR },
    });
    if (enviada) await evento(tx, i!.id, 'CORREO', null, 'Bienvenida: te llamamos en menos de 24 horas');
    return { nuevo: true };
  });
}

// ── Edición ─────────────────────────────────────────────────────────────────

const ETIQUETA_CAMPO: Partial<Record<keyof z.infer<typeof editarBody>, string>> = {
  nombre: 'nombre',
  telefono: 'teléfono',
  email: 'correo',
  familia: 'estudio',
  cicloId: 'ciclo',
  origen: 'origen',
  campana: 'campaña',
  consentimientoComunicaciones: 'consentimiento',
  esMenor: 'menor de edad',
  tutorNombre: 'tutor',
  tutorTelefono: 'teléfono del tutor',
  estudiosActuales: 'estudios actuales',
  localidad: 'localidad',
  motivacion: 'motivación',
  otrosCentros: 'otros centros',
  puntuacion: 'puntuación',
  asesorId: 'asesor',
  proximaAccion: 'próxima acción',
  proximaAccionEl: 'fecha de la próxima acción',
  notas: 'notas',
};

export async function editar(id: string, d: z.infer<typeof editarBody>, usuarioId: string) {
  await db.transaction(async (tx) => {
    const { i } = await cargar(tx, id);
    if (i.estado === 'SOLICITUD') throw conflict('INTERESADO_CONVERTIDO', 'Este interesado ya pasó a solicitud: se gestiona desde Solicitudes.');
    const { estado, motivoPerdida, ...datos } = d;
    await comprobarCiclo(tx, datos.familia !== undefined ? datos.familia : i.familia, datos.cicloId !== undefined ? datos.cicloId : null);
    if (datos.familia === 'BACHILLERATO' || datos.familia === null) datos.cicloId = null;
    await comprobarAsesor(tx, datos.asesorId);

    const cambios = Object.fromEntries(
      Object.entries(datos).filter(([k, v]) => v !== undefined && (i as Record<string, unknown>)[k] !== v),
    ) as Partial<typeof interesados.$inferInsert>;

    // Estado: perdido exige motivo; al salir de perdido se quita.
    let nuevoEstado: Interesado['estado'] | null = null;
    if (estado && estado !== i.estado) {
      if (estado === 'PERDIDO' && !motivoPerdida) throw badRequest('MOTIVO_OBLIGATORIO', 'Indica el motivo por el que se pierde.');
      nuevoEstado = estado;
      cambios.estado = estado;
      cambios.motivoPerdida = estado === 'PERDIDO' ? motivoPerdida! : null;
    } else if (estado === 'PERDIDO' && motivoPerdida && motivoPerdida !== i.motivoPerdida) {
      cambios.motivoPerdida = motivoPerdida;
    }
    if (!Object.keys(cambios).length) return;

    await tx.update(interesados).set(cambios).where(eq(interesados.id, id));
    const editados = Object.keys(datos).filter((k) => k in cambios).map((k) => ETIQUETA_CAMPO[k as keyof typeof ETIQUETA_CAMPO] ?? k);
    if (editados.length) await evento(tx, id, 'EDICION', usuarioId, `Cambia ${editados.join(', ')}`, { campos: Object.keys(cambios) });
    if (nuevoEstado) await evento(tx, id, 'ESTADO', usuarioId, null, { de: i.estado, a: nuevoEstado, motivo: cambios.motivoPerdida ?? null });
  });
  return detalle(id);
}

// ── Seguimiento: llamadas y notas ───────────────────────────────────────────

export async function seguimiento(id: string, d: z.infer<typeof seguimientoBody>, usuarioId: string) {
  await db.transaction(async (tx) => {
    const { i } = await cargar(tx, id);
    if (i.estado === 'SOLICITUD') throw conflict('INTERESADO_CONVERTIDO', 'Este interesado ya pasó a solicitud: se gestiona desde Solicitudes.');
    const cambios: Partial<typeof interesados.$inferInsert> = {};
    if (d.proximaAccion !== null && d.proximaAccion !== undefined) cambios.proximaAccion = d.proximaAccion;
    if (d.proximaAccionEl) cambios.proximaAccionEl = d.proximaAccionEl;

    if (d.tipo === 'LLAMADA') {
      cambios.ultimoContactoEn = new Date();
      if (d.resultado === 'NO_CONTESTA') cambios.intentos = i.intentos + 1;
      // Contesta: deja de ser nuevo (etapa 2, contactado y cualificado).
      if (d.resultado === 'CONTESTA' && (i.estado === 'NUEVO' || i.estado === 'NUTRICION')) cambios.estado = 'CONTACTADO';
    }
    if (Object.keys(cambios).length) await tx.update(interesados).set(cambios).where(eq(interesados.id, id));
    await evento(tx, id, d.tipo, usuarioId, d.texto, d.tipo === 'LLAMADA' ? { resultado: d.resultado, intento: cambios.intentos ?? null } : null);
    if (cambios.estado) await evento(tx, id, 'ESTADO', usuarioId, null, { de: i.estado, a: cambios.estado });
  });
  return detalle(id);
}

// ── Paso a solicitud (lo llama el alta de solicitudes con `interesadoId`) ───

export async function vincularSolicitud(tx: Tx, interesadoId: string, solicitud: { id: string; codigo: string }, usuarioId: string) {
  const [i] = await tx.select().from(interesados).where(eq(interesados.id, interesadoId)).for('update');
  if (!i) throw notFound('Interesado no encontrado.');
  if (i.solicitudId) throw conflict('INTERESADO_CONVERTIDO', 'Este interesado ya pasó a solicitud.');
  await tx
    .update(interesados)
    .set({ estado: 'SOLICITUD', solicitudId: solicitud.id, motivoPerdida: null, proximaAccion: null, proximaAccionEl: null })
    .where(eq(interesados.id, interesadoId));
  await evento(tx, interesadoId, 'SOLICITUD', usuarioId, `Pasa a solicitud ${solicitud.codigo}`, { solicitudId: solicitud.id, codigo: solicitud.codigo });
  await evento(tx, interesadoId, 'ESTADO', usuarioId, null, { de: i.estado, a: 'SOLICITUD' });
}
