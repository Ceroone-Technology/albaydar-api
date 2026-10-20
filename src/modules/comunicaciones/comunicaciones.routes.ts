import { Router } from 'express';
import { and, asc, count, desc, eq, gte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env';
import { correosSalientes, estadoCorreoEnum, plantillasCorreo, usuarios } from '../../db/schema';
import { db } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { VARS_COMUNES } from '../../correo/enviar';
import { EVENTOS, evento } from '../../correo/eventos';
import { encolarCorreo, getTransporter } from '../../correo/outbox';
import { renderizar, sanear, variablesDesconocidas, varsDeEjemplo } from '../../correo/plantillas';

const idParam = z.object({ id: z.string().uuid() });
const claves = EVENTOS.map((e) => e.clave) as [string, ...string[]];

const plantillaBody = z.object({
  evento: z.enum(claves, { error: 'Evento desconocido.' }),
  nombre: z.string().trim().min(1, 'Ponle un nombre.').max(120),
  asunto: z.string().trim().min(1, 'El asunto es obligatorio.').max(250),
  cuerpoHtml: z.string().trim().min(1, 'El cuerpo es obligatorio.').max(100_000),
  estado: z.enum(['ACTIVADA', 'BORRADOR']).default('BORRADOR'),
});
// Sin valores por defecto: en Zod 4 .partial() los conservaría y una edición
// cualquiera devolvería la plantilla a borrador.
const editarBody = z
  .object({
    evento: plantillaBody.shape.evento.optional(),
    nombre: plantillaBody.shape.nombre.optional(),
    asunto: plantillaBody.shape.asunto.optional(),
    cuerpoHtml: plantillaBody.shape.cuerpoHtml.optional(),
    estado: z.enum(['ACTIVADA', 'BORRADOR']).optional(),
  })
  .refine((o) => Object.values(o).some((x) => x !== undefined), 'Nada que actualizar.');
const previaBody = plantillaBody.pick({ evento: true, asunto: true, cuerpoHtml: true });
const pruebaBody = z.object({ para: z.string().trim().toLowerCase().email().optional() });
const enviosQuery = z.object({
  evento: z.string().optional(),
  estado: z.enum(estadoCorreoEnum.enumValues).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Sanea el HTML y comprueba que solo use variables del evento. */
function preparar(ev: string, asunto: string, cuerpoHtml: string) {
  const def = evento(ev)!;
  const limpio = sanear(cuerpoHtml);
  const malas = variablesDesconocidas(def, asunto, limpio);
  if (malas.length) {
    throw badRequest('VARIABLES_DESCONOCIDAS', `Variables que no existen para este evento: ${malas.map((m) => `{{${m}}}`).join(', ')}.`, {
      desconocidas: malas,
      disponibles: def.variables.map((x) => x.nombre),
    });
  }
  return limpio;
}

const vista = (p: typeof plantillasCorreo.$inferSelect & { actualizadoPor?: string | null }) => {
  const ev = evento(p.evento);
  return {
    id: p.id,
    evento: p.evento,
    eventoNombre: ev?.nombre ?? p.evento,
    cuando: ev?.cuando ?? '',
    nombre: p.nombre,
    asunto: p.asunto,
    cuerpoHtml: p.cuerpoHtml,
    estado: p.estado,
    estadoEtiqueta: p.estado === 'ACTIVADA' ? 'Activada' : 'Borrador',
    disponible: ev?.disponible ?? false,
    actualizadoPor: p.actualizadoPor ?? null,
    actualizadaEn: p.updatedAt,
  };
};

export const comunicacionesRouter = Router();
const ver = requirePermiso('comunicaciones.ver');
const editar = requirePermiso('comunicaciones.editar');

/** Eventos disponibles y sus variables (chips "Variables:" del editor). */
comunicacionesRouter.get('/eventos', ver, (_req, res) => {
  res.json({
    items: EVENTOS.map((e) => ({
      clave: e.clave,
      nombre: e.nombre,
      cuando: e.cuando,
      destinatario: e.destinatario,
      obligatorio: e.obligatorio,
      disponible: e.disponible,
      variables: e.variables.map(({ nombre, descripcion, ejemplo, html }) => ({ nombre, descripcion, ejemplo: html ? '' : ejemplo, html: !!html })),
      predeterminada: e.predeterminada,
    })),
  });
});

// ── Plantillas ──────────────────────────────────────────────────────────────

comunicacionesRouter.get('/plantillas', ver, async (_req, res) => {
  const filas = await db
    .select({ p: plantillasCorreo, actualizadoPor: usuarios.nombre })
    .from(plantillasCorreo)
    .leftJoin(usuarios, eq(usuarios.id, plantillasCorreo.actualizadoPorId))
    .orderBy(asc(plantillasCorreo.evento), desc(plantillasCorreo.updatedAt));
  const orden = new Map(EVENTOS.map((e, i) => [e.clave, i]));
  res.json({ items: filas.map((f) => vista({ ...f.p, actualizadoPor: f.actualizadoPor })).sort((a, b) => (orden.get(a.evento) ?? 99) - (orden.get(b.evento) ?? 99)) });
});

comunicacionesRouter.get('/plantillas/:id', ver, validate({ params: idParam }), async (req, res) => {
  const [p] = await db.select().from(plantillasCorreo).where(eq(plantillasCorreo.id, v<typeof idParam>(req, 'params').id));
  if (!p) throw notFound('Plantilla no encontrada.');
  res.json(vista(p));
});

/** Al activar una plantilla, la que estuviera activa para ese evento pasa a borrador. */
async function activarEnExclusiva(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], evento: string, idQueQueda: string) {
  await tx
    .update(plantillasCorreo)
    .set({ estado: 'BORRADOR' })
    .where(and(eq(plantillasCorreo.evento, evento), eq(plantillasCorreo.estado, 'ACTIVADA'), ne(plantillasCorreo.id, idQueQueda)));
}

comunicacionesRouter.post('/plantillas', editar, validate({ body: plantillaBody }), async (req, res) => {
  const d = v<typeof plantillaBody>(req, 'body');
  const cuerpoHtml = preparar(d.evento, d.asunto, d.cuerpoHtml);
  const p = await db.transaction(async (tx) => {
    const [n] = await tx
      .insert(plantillasCorreo)
      .values({ ...d, cuerpoHtml, estado: 'BORRADOR', creadoPorId: req.user!.id, actualizadoPorId: req.user!.id })
      .returning();
    if (d.estado !== 'ACTIVADA') return n!;
    await activarEnExclusiva(tx, d.evento, n!.id);
    const [act] = await tx.update(plantillasCorreo).set({ estado: 'ACTIVADA' }).where(eq(plantillasCorreo.id, n!.id)).returning();
    return act!;
  });
  res.status(201).json(vista(p));
});

comunicacionesRouter.patch('/plantillas/:id', editar, validate({ params: idParam, body: editarBody }), async (req, res) => {
  const { id } = v<typeof idParam>(req, 'params');
  const d = v<typeof editarBody>(req, 'body');
  const [actual] = await db.select().from(plantillasCorreo).where(eq(plantillasCorreo.id, id));
  if (!actual) throw notFound('Plantilla no encontrada.');
  const ev = d.evento ?? actual.evento;
  const asunto = d.asunto ?? actual.asunto;
  const cuerpoHtml = preparar(ev, asunto, d.cuerpoHtml ?? actual.cuerpoHtml);
  const p = await db.transaction(async (tx) => {
    if ((d.estado ?? actual.estado) === 'ACTIVADA') await activarEnExclusiva(tx, ev, id);
    const [act] = await tx
      .update(plantillasCorreo)
      .set({ ...d, evento: ev, asunto, cuerpoHtml, actualizadoPorId: req.user!.id })
      .where(eq(plantillasCorreo.id, id))
      .returning();
    return act!;
  });
  res.json(vista(p));
});

comunicacionesRouter.delete('/plantillas/:id', editar, validate({ params: idParam }), async (req, res) => {
  const [p] = await db.delete(plantillasCorreo).where(eq(plantillasCorreo.id, v<typeof idParam>(req, 'params').id)).returning();
  if (!p) throw notFound('Plantilla no encontrada.');
  const ev = evento(p.evento);
  res.json({
    eliminada: true,
    aviso:
      p.estado === 'ACTIVADA' && ev?.obligatorio
        ? 'Este correo es imprescindible para el flujo: hasta que actives otra plantilla se enviará la versión predeterminada.'
        : p.estado === 'ACTIVADA'
          ? 'Ya no hay plantilla activada para este evento: este correo dejará de enviarse.'
          : null,
  });
});

/** Vista previa con datos de ejemplo (sin guardar). */
comunicacionesRouter.post('/plantillas/previsualizar', ver, validate({ body: previaBody }), async (req, res) => {
  const d = v<typeof previaBody>(req, 'body');
  const cuerpoHtml = preparar(d.evento, d.asunto, d.cuerpoHtml);
  res.json(renderizar({ evento: d.evento, asunto: d.asunto, cuerpoHtml, vars: { ...varsDeEjemplo(evento(d.evento)!), ...VARS_COMUNES } }));
});

/** "Enviar prueba": la plantilla con datos de ejemplo a tu correo (o al indicado). */
comunicacionesRouter.post('/plantillas/:id/prueba', editar, validate({ params: idParam, body: pruebaBody }), async (req, res) => {
  const [p] = await db.select().from(plantillasCorreo).where(eq(plantillasCorreo.id, v<typeof idParam>(req, 'params').id));
  if (!p) throw notFound('Plantilla no encontrada.');
  const para = v<typeof pruebaBody>(req, 'body').para ?? req.user!.email;
  const correo = renderizar({ evento: p.evento, asunto: `[Prueba] ${p.asunto}`, cuerpoHtml: p.cuerpoHtml, vars: { ...varsDeEjemplo(evento(p.evento)!), ...VARS_COMUNES } });
  await encolarCorreo(db, { plantilla: 'PRUEBA', plantillaId: p.id, para, correo }); // el worker lo envía en ≤ 15 s
  res.status(202).json({ para, mensaje: `Prueba enviada a ${para}.` });
});

// ── Histórico de envíos ─────────────────────────────────────────────────────

comunicacionesRouter.get('/envios', ver, validate({ query: enviosQuery }), async (req, res) => {
  const q = v<typeof enviosQuery>(req, 'query');
  const c: SQL[] = [];
  if (q.evento) c.push(eq(correosSalientes.plantilla, q.evento));
  if (q.estado) c.push(eq(correosSalientes.estado, q.estado));
  if (q.q) c.push(sql`(${correosSalientes.para} ilike ${'%' + q.q + '%'} or ${correosSalientes.asunto} ilike ${'%' + q.q + '%'})`);
  const where = and(...c);
  const [filas, [total]] = await Promise.all([
    db
      .select({
        id: correosSalientes.id,
        evento: correosSalientes.plantilla,
        plantilla: plantillasCorreo.nombre,
        para: correosSalientes.para,
        asunto: correosSalientes.asunto,
        estado: correosSalientes.estado,
        intentos: correosSalientes.intentos,
        error: correosSalientes.ultimoError,
        creadoEn: correosSalientes.createdAt,
        enviadoEn: correosSalientes.enviadoEn,
        solicitudId: correosSalientes.solicitudId,
      })
      .from(correosSalientes)
      .leftJoin(plantillasCorreo, eq(plantillasCorreo.id, correosSalientes.plantillaId))
      .where(where)
      .orderBy(desc(correosSalientes.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(correosSalientes).where(where),
  ]);
  res.json({
    items: filas.map((f) => ({ ...f, eventoNombre: f.evento === 'PRUEBA' ? 'Prueba' : (evento(f.evento)?.nombre ?? f.evento) })),
    page: q.page,
    pageSize: q.pageSize,
    total: total?.n ?? 0,
  });
});

/** "Últimas 24 horas · 96,4 % de entrega" */
comunicacionesRouter.get('/envios/resumen', ver, async (_req, res) => {
  const filas = await db
    .select({ estado: correosSalientes.estado, n: count() })
    .from(correosSalientes)
    .where(gte(correosSalientes.createdAt, new Date(Date.now() - 86_400_000)))
    .groupBy(correosSalientes.estado);
  const n = (e: string) => filas.find((f) => f.estado === e)?.n ?? 0;
  const total = filas.reduce((t, f) => t + f.n, 0);
  const terminados = n('ENVIADO') + n('ERROR');
  res.json({ total, enviados: n('ENVIADO'), pendientes: n('PENDIENTE') + n('ENVIANDO'), errores: n('ERROR'), porcentajeEntrega: terminados ? Math.round((n('ENVIADO') / terminados) * 1000) / 10 : null });
});

/** Reintentar un envío fallido. */
comunicacionesRouter.post('/envios/:id/reintentar', editar, validate({ params: idParam }), async (req, res) => {
  const [c] = await db
    .update(correosSalientes)
    .set({ estado: 'PENDIENTE', programadoPara: new Date(), intentos: 0 })
    .where(and(eq(correosSalientes.id, v<typeof idParam>(req, 'params').id), eq(correosSalientes.estado, 'ERROR')))
    .returning({ id: correosSalientes.id });
  if (!c) throw notFound('Solo se pueden reintentar envíos con error.');
  res.status(202).json({ ok: true });
});

/** Comprueba la conexión con el servidor de correo (Gmail, etc.) sin enviar nada. */
comunicacionesRouter.get('/smtp/estado', requirePermiso('configuracion.ver'), async (_req, res) => {
  try {
    await getTransporter().verify();
    res.json({ ok: true, servidor: `${env.SMTP_HOST}:${env.SMTP_PORT}`, remitente: env.MAIL_FROM, desvio: env.MAIL_DESVIO ?? null });
  } catch (e) {
    res.json({ ok: false, servidor: `${env.SMTP_HOST}:${env.SMTP_PORT}`, error: (e as Error).message });
  }
});
