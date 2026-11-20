import { and, asc, count, desc, eq, inArray, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { CENTRO } from '../../config/env';
import {
  alumnaContactos,
  alumnaEventos,
  alumnas,
  correosSalientes,
  destinatariosNotificacionEnum,
  familiaViaEnum,
  notificaciones,
  usuarios,
} from '../../db/schema';
import { encolarCorreo } from '../../correo/outbox';
import { escapar, htmlATexto, layout } from '../../correo/plantillas';
import { db } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { fechaLocal } from '../../lib/fechas';
import { ETIQUETA_FAMILIA_VIA } from '../solicitudes/dominio';

/**
 * Notificaciones masivas (Comunicaciones › Notificaciones, 20/11/2026): un aviso por correo al
 * alumnado de unos cursos o a sus familias («1º de Bachillerato no tiene clase el viernes»).
 *  - Destinatarios: las alumnas del curso escolar que no están de baja, de los cursos elegidos
 *    (vía, curso y, en ciclos, el ciclo); a ellas, a sus contactos (familias) o a ambos.
 *  - Cada dirección recibe un solo correo, aunque tenga varias hijas en esos cursos, y nunca
 *    con los demás en copia. Van por la cola de siempre (ritmo y reintentos).
 *  - Queda en el historial de cada expediente y en «Histórico de envíos» como «Notificación».
 * WhatsApp no se envía desde aquí: la vista previa devuelve los teléfonos de las familias para
 * «Compartir por WhatsApp» y la lista de difusión (sin la API de WhatsApp Business).
 */

/** Tope por envío: por encima, mejor partirlo (y la cuenta de correo tiene límites diarios). */
const MAX_CORREOS = 1500;

const grupo = z.object({
  familia: z.enum(familiaViaEnum.enumValues),
  curso: z.union([z.literal(1), z.literal(2)]),
  /** Solo en las vías de ciclos: el ciclo (nombre del catálogo). Sin él, todos. */
  ciclo: z
    .string()
    .trim()
    .max(150)
    .nullable()
    .optional()
    .transform((x) => x || null),
});

export const seleccionBody = z.object({
  cursoEscolar: z.string().regex(/^\d{4}-\d{4}$/, 'Curso escolar no válido.'),
  grupos: z.array(grupo).min(1, 'Elige al menos un curso.').max(30),
  destinatarios: z.enum(destinatariosNotificacionEnum.enumValues),
});

export const envioBody = seleccionBody.extend({
  asunto: z.string().trim().min(1, 'Escribe el asunto.').max(200),
  mensaje: z.string().trim().min(1, 'Escribe el mensaje.').max(5000),
  /** Alumnas que se quitan a mano de la lista. */
  excluir: z.array(z.string().uuid()).max(2000).default([]),
});

export const listadoQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Curso escolar en marcha (hora del centro): de septiembre a agosto. */
export function cursoEscolarEnCurso(hoy = fechaLocal(new Date())): string {
  const [anio, mes] = hoy.split('-').map(Number) as [number, number];
  const inicio = mes >= 9 ? anio : anio - 1;
  return `${inicio}-${inicio + 1}`;
}

/** Cursos con alumnado (sin bajas) por curso escolar, para los selectores. */
export async function opciones() {
  const filas = await db
    .select({ cursoEscolar: alumnas.cursoEscolar, familia: alumnas.familia, curso: alumnas.curso, estudios: alumnas.estudios, n: count() })
    .from(alumnas)
    .where(ne(alumnas.estado, 'BAJA'))
    .groupBy(alumnas.cursoEscolar, alumnas.familia, alumnas.curso, alumnas.estudios)
    .orderBy(asc(alumnas.cursoEscolar), asc(alumnas.familia), asc(alumnas.curso));

  const cursos = new Map<string, Map<string, { familia: string; curso: number; alumnas: number; ciclos: Map<string, number> }>>();
  for (const f of filas) {
    const porCurso = cursos.get(f.cursoEscolar) ?? new Map();
    cursos.set(f.cursoEscolar, porCurso);
    const clave = `${f.familia}:${f.curso}`;
    const g = porCurso.get(clave) ?? { familia: f.familia, curso: f.curso, alumnas: 0, ciclos: new Map<string, number>() };
    porCurso.set(clave, g);
    g.alumnas += f.n;
    if (f.familia !== 'BACHILLERATO' && f.estudios) g.ciclos.set(f.estudios, (g.ciclos.get(f.estudios) ?? 0) + f.n);
  }

  return {
    actual: cursoEscolarEnCurso(),
    cursosEscolares: [...cursos.entries()].map(([cursoEscolar, grupos]) => ({
      cursoEscolar,
      grupos: [...grupos.values()].map((g) => ({
        familia: g.familia,
        etiqueta: ETIQUETA_FAMILIA_VIA[g.familia as keyof typeof ETIQUETA_FAMILIA_VIA],
        curso: g.curso,
        alumnas: g.alumnas,
        ciclos: [...g.ciclos.entries()].map(([nombre, n]) => ({ nombre, alumnas: n })).sort((a, b) => a.nombre.localeCompare(b.nombre)),
      })),
    })),
  };
}

interface Destinataria {
  id: string;
  expediente: string;
  nombre: string;
  familia: string;
  curso: number;
  estudios: string | null;
  correos: { email: string; nombre: string; parentesco: string }[];
  telefonos: { telefono: string; nombre: string; parentesco: string }[];
}

/** Las alumnas de los cursos elegidos, con los correos y teléfonos que tocan. */
export async function seleccion(d: z.infer<typeof seleccionBody>) {
  const porGrupo: SQL[] = d.grupos.map((g) => {
    const c: SQL[] = [eq(alumnas.familia, g.familia), eq(alumnas.curso, g.curso)];
    if (g.familia !== 'BACHILLERATO' && g.ciclo) c.push(eq(alumnas.estudios, g.ciclo));
    return and(...c)!;
  });
  const filas = await db
    .select()
    .from(alumnas)
    .where(and(eq(alumnas.cursoEscolar, d.cursoEscolar), ne(alumnas.estado, 'BAJA'), or(...porGrupo)))
    .orderBy(asc(alumnas.familia), asc(alumnas.curso), asc(alumnas.apellidos), asc(alumnas.nombre));
  const contactos = filas.length
    ? await db
        .select()
        .from(alumnaContactos)
        .where(inArray(alumnaContactos.alumnaId, filas.map((a) => a.id)))
        .orderBy(desc(alumnaContactos.principal), asc(alumnaContactos.orden))
    : [];

  const familias = d.destinatarios !== 'ALUMNADO';
  const alumnado = d.destinatarios !== 'FAMILIAS';
  const lista: Destinataria[] = filas.map((a) => {
    const suyos = contactos.filter((c) => c.alumnaId === a.id);
    const correos: Destinataria['correos'] = [];
    if (alumnado && a.email) correos.push({ email: a.email.toLowerCase(), nombre: `${a.nombre} ${a.apellidos}`, parentesco: 'Alumna' });
    if (familias) {
      for (const c of suyos) if (c.email) correos.push({ email: c.email.toLowerCase(), nombre: c.nombre, parentesco: c.parentesco });
    }
    // WhatsApp: los teléfonos de las familias (y el de la alumna si también va a ella).
    const telefonos: Destinataria['telefonos'] = [];
    if (alumnado && a.telefono) telefonos.push({ telefono: a.telefono, nombre: `${a.nombre} ${a.apellidos}`, parentesco: 'Alumna' });
    if (familias) for (const c of suyos) telefonos.push({ telefono: c.telefono, nombre: c.nombre, parentesco: c.parentesco });
    return {
      id: a.id,
      expediente: a.expediente,
      nombre: `${a.nombre} ${a.apellidos}`,
      familia: a.familia,
      curso: a.curso,
      estudios: a.estudios,
      correos: unicos(correos, (x) => x.email),
      telefonos: unicos(telefonos, (x) => x.telefono.replace(/\D/g, '')),
    };
  });

  return {
    alumnas: lista,
    totales: {
      alumnas: lista.length,
      correos: new Set(lista.flatMap((a) => a.correos.map((c) => c.email))).size,
      sinCorreo: lista.filter((a) => a.correos.length === 0).length,
      telefonos: new Set(lista.flatMap((a) => a.telefonos.map((t) => t.telefono.replace(/\D/g, '')))).size,
    },
  };
}

const unicos = <T>(xs: T[], clave: (x: T) => string) => {
  const vistos = new Set<string>();
  return xs.filter((x) => {
    const k = clave(x);
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
};

/** El mensaje (texto plano) como correo: párrafos, enlaces y la firma de secretaría. */
export function correoDeNotificacion(asunto: string, mensaje: string) {
  const enlazar = (t: string) => t.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
  const parrafos = mensaje
    .split(/\n{2,}/)
    .map((p) => `<p>${enlazar(escapar(p.trim())).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const cuerpo = `${parrafos}<p>Un saludo,<br>Secretaría · ${escapar(CENTRO.nombre)}</p>`;
  return {
    asunto,
    html: layout(cuerpo, asunto),
    texto: `${htmlATexto(cuerpo)}\n\n—\n${CENTRO.nombre} · ${CENTRO.direccion} · ${CENTRO.telefono}`,
  };
}

/** Envía la notificación: un correo por dirección, a la cola, y la apunta en cada expediente. */
export async function enviar(d: z.infer<typeof envioBody>, usuarioId: string) {
  const { alumnas: todas } = await seleccion(d);
  const fuera = new Set(d.excluir);
  const lista = todas.filter((a) => !fuera.has(a.id));
  const direcciones = [...new Set(lista.flatMap((a) => a.correos.map((c) => c.email)))];
  if (direcciones.length === 0) throw badRequest('SIN_DESTINATARIOS', 'Ninguna alumna de esos cursos tiene un correo al que enviar.');
  if (direcciones.length > MAX_CORREOS) {
    throw badRequest('DEMASIADOS_DESTINATARIOS', `Son ${direcciones.length} correos: el máximo por envío es ${MAX_CORREOS}. Divídelo por cursos.`);
  }

  const correo = correoDeNotificacion(d.asunto, d.mensaje);
  return db.transaction(async (tx) => {
    const [n] = await tx
      .insert(notificaciones)
      .values({
        asunto: d.asunto,
        mensaje: d.mensaje,
        destinatarios: d.destinatarios,
        cursoEscolar: d.cursoEscolar,
        grupos: d.grupos.map((g) => ({ familia: g.familia, curso: g.curso, ciclo: g.ciclo ?? null })),
        alumnas: lista.length,
        correos: direcciones.length,
        enviadaPorId: usuarioId,
      })
      .returning();
    for (const para of direcciones) {
      await encolarCorreo(tx, { plantilla: 'NOTIFICACION', para, correo, notificacionId: n!.id });
    }
    const conCorreo = lista.filter((a) => a.correos.length > 0);
    if (conCorreo.length) {
      await tx.insert(alumnaEventos).values(
        conCorreo.map((a) => ({
          alumnaId: a.id,
          tipo: 'NOTIFICACION' as const,
          texto: `«${d.asunto}» · por correo a ${a.correos.map((c) => c.email).join(', ')}`,
          detalle: { notificacionId: n!.id },
          usuarioId,
        })),
      );
    }
    return n!.id;
  });
}

/** Estado de los correos de unas notificaciones: enviados, pendientes y con error. */
async function estados(ids: string[]) {
  if (!ids.length) return new Map<string, { enviados: number; pendientes: number; errores: number }>();
  const filas = await db
    .select({ id: correosSalientes.notificacionId, estado: correosSalientes.estado, n: count() })
    .from(correosSalientes)
    .where(inArray(correosSalientes.notificacionId, ids))
    .groupBy(correosSalientes.notificacionId, correosSalientes.estado);
  const r = new Map<string, { enviados: number; pendientes: number; errores: number }>();
  for (const f of filas) {
    const e = r.get(f.id!) ?? { enviados: 0, pendientes: 0, errores: 0 };
    if (f.estado === 'ENVIADO') e.enviados += f.n;
    else if (f.estado === 'ERROR') e.errores += f.n;
    else e.pendientes += f.n;
    r.set(f.id!, e);
  }
  return r;
}

const vista = (n: typeof notificaciones.$inferSelect, autor: string | null, e?: { enviados: number; pendientes: number; errores: number }) => ({
  id: n.id,
  asunto: n.asunto,
  mensaje: n.mensaje,
  destinatarios: n.destinatarios,
  cursoEscolar: n.cursoEscolar,
  grupos: n.grupos.map((g) => ({ ...g, etiqueta: ETIQUETA_FAMILIA_VIA[g.familia as keyof typeof ETIQUETA_FAMILIA_VIA] ?? g.familia })),
  alumnas: n.alumnas,
  correos: n.correos,
  enviadas: e?.enviados ?? 0,
  pendientes: e?.pendientes ?? 0,
  errores: e?.errores ?? 0,
  enviadaPor: autor,
  enviadaEn: n.createdAt,
});

export async function listar(q: z.infer<typeof listadoQuery>) {
  const [filas, [total]] = await Promise.all([
    db
      .select({ n: notificaciones, autor: usuarios.nombre })
      .from(notificaciones)
      .leftJoin(usuarios, eq(usuarios.id, notificaciones.enviadaPorId))
      .orderBy(desc(notificaciones.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(notificaciones),
  ]);
  const e = await estados(filas.map((f) => f.n.id));
  return { items: filas.map((f) => vista(f.n, f.autor, e.get(f.n.id))), page: q.page, pageSize: q.pageSize, total: total?.n ?? 0 };
}

export async function detalle(id: string) {
  const [f] = await db
    .select({ n: notificaciones, autor: usuarios.nombre })
    .from(notificaciones)
    .leftJoin(usuarios, eq(usuarios.id, notificaciones.enviadaPorId))
    .where(eq(notificaciones.id, id));
  if (!f) throw notFound('Notificación no encontrada.');
  return vista(f.n, f.autor, (await estados([id])).get(id));
}
