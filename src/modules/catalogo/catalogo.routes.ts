import { Router } from 'express';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ciclos, entrevistadores, familiaViaEnum, plazasCiclo, vias } from '../../db/schema';
import { db } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { asegurarPlazasCiclo, claveCiclo, ocupadasPorCiclo, plazasDeCiclos, plazasOcupadas, sumarPlazasVia } from '../solicitudes/comun';
import { ETAPA, ETIQUETA_FAMILIA_VIA } from '../solicitudes/dominio';

/** Ciclos del catálogo (A6), en su orden. Con `soloActivos`, los que se ofrecen hoy. */
export async function listarCiclos(soloActivos = false) {
  return db
    .select()
    .from(ciclos)
    .where(soloActivos ? eq(ciclos.activo, true) : undefined)
    .orderBy(asc(ciclos.familia), asc(ciclos.orden), asc(ciclos.nombre));
}

/**
 * Vías activas para el formulario público: familia (1er nivel) → curso (2º nivel), y en las
 * familias de ciclos, los ciclos que se pueden pedir (A6).
 */
export async function viasPublicas() {
  const [filas, catalogo] = await Promise.all([
    db.select().from(vias).where(eq(vias.activa, true)).orderBy(asc(vias.familia), asc(vias.curso)),
    listarCiclos(true),
  ]);
  const familias = familiaViaEnum.enumValues
    .map((f) => ({
      familia: f,
      etiqueta: ETIQUETA_FAMILIA_VIA[f],
      etapa: ETAPA[f],
      cursos: filas.filter((x) => x.familia === f).map((x) => ({ viaId: x.id, curso: x.curso, nombre: x.nombre })),
      ciclos: catalogo.filter((c) => c.familia === f).map((c) => ({ id: c.id, nombre: c.nombre })),
    }))
    .filter((f) => f.cursos.length);
  return { cursoEscolar: filas[0]?.cursoEscolar ?? null, familias };
}

const viaBody = z.object({
  familia: z.enum(familiaViaEnum.enumValues),
  curso: z.number().int().min(1).max(2),
  nombre: z.string().trim().min(1).max(120),
  cursoEscolar: z.string().regex(/^\d{4}-\d{4}$/),
  plazas: z.number().int().min(0),
  plazasAsignadasPorJunta: z.boolean().default(false),
  activa: z.boolean().default(true),
});

/** Edición parcial sin valores por defecto (Zod 4 los conservaría con .partial()). */
const viaEditarBody = z
  .object({
    nombre: viaBody.shape.nombre.optional(),
    plazas: viaBody.shape.plazas.optional(),
    plazasAsignadasPorJunta: z.boolean().optional(),
    activa: z.boolean().optional(),
  })
  .refine((o) => Object.values(o).some((x) => x !== undefined), 'Nada que actualizar.');

const plazasCicloBody = z.object({ plazas: z.number().int().min(0) });
const viaCicloParams = z.object({ id: z.string().uuid(), cicloId: z.string().uuid() });

export const catalogoRouter = Router();

/** Catálogo de ciclos (A6): selectores y filtros de secretaría, también los ciclos ya retirados. */
catalogoRouter.get('/ciclos', async (_req, res) => {
  res.json({ items: (await listarCiclos()).map((c) => ({ ...c, etiquetaFamilia: ETIQUETA_FAMILIA_VIA[c.familia] })) });
});

/**
 * Vías con plazas libres (Configuración y comprobación de plazas). En las de ciclos (A6), sus
 * `ciclos` con plazas, ocupadas y libres; las plazas de la vía son la suma de las de sus ciclos.
 */
catalogoRouter.get('/vias', async (_req, res) => {
  const filas = await db.select().from(vias).orderBy(asc(vias.cursoEscolar), asc(vias.familia), asc(vias.curso));
  const ids = filas.map((x) => x.id);
  const [porCiclo, ocupadasCiclo] = await Promise.all([plazasDeCiclos(db, ids), ocupadasPorCiclo(db, ids)]);
  res.json({
    items: await Promise.all(
      filas.map(async (x) => {
        const ocupadas = await plazasOcupadas(db, x.id);
        const deLaVia = porCiclo.filter((p) => p.viaId === x.id).map((p) => {
          const n = ocupadasCiclo.get(claveCiclo(x.id, p.cicloId)) ?? 0;
          return { cicloId: p.cicloId, nombre: p.nombre, plazas: p.plazas, ocupadas: n, libres: Math.max(0, p.plazas - n) };
        });
        return {
          ...x,
          etiqueta: ETIQUETA_FAMILIA_VIA[x.familia],
          ocupadas,
          libres: x.plazasAsignadasPorJunta ? null : Math.max(0, x.plazas - ocupadas),
          plazasPorCiclo: deLaVia.length > 0,
          ciclos: deLaVia,
        };
      }),
    ),
  });
});

// En una vía de ciclos, las plazas se ponen por ciclo: nace con una fila a 0 por cada ciclo activo.
catalogoRouter.post('/vias', requirePermiso('configuracion.editar'), validate({ body: viaBody }), async (req, res) => {
  const x = await db.transaction(async (tx) => {
    const [nueva] = await tx.insert(vias).values(v<typeof viaBody>(req, 'body')).returning();
    return asegurarPlazasCiclo(tx, nueva!, () => 0);
  });
  res.status(201).json(x);
});

catalogoRouter.patch(
  '/vias/:id',
  requirePermiso('configuracion.editar'),
  validate({ params: z.object({ id: z.string().uuid() }), body: viaEditarBody }),
  async (req, res) => {
    const { id } = v<z.ZodObject<{ id: z.ZodString }>>(req, 'params');
    const cambios = v<typeof viaEditarBody>(req, 'body');
    if (cambios.plazas !== undefined) {
      const [conCiclos] = await db.select({ id: plazasCiclo.id }).from(plazasCiclo).where(eq(plazasCiclo.viaId, id)).limit(1);
      if (conCiclos) throw badRequest('PLAZAS_POR_CICLO', 'Las plazas de esta vía son la suma de las de sus ciclos: cámbialas en cada ciclo.');
    }
    const [x] = await db.update(vias).set(cambios).where(and(eq(vias.id, id))).returning();
    if (!x) throw notFound('Vía no encontrada.');
    res.json(x);
  },
);

/** Plazas de un ciclo en una vía de ciclos (A6); la vía pasa a la nueva suma. */
catalogoRouter.patch(
  '/vias/:id/ciclos/:cicloId',
  requirePermiso('configuracion.editar'),
  validate({ params: viaCicloParams, body: plazasCicloBody }),
  async (req, res) => {
    const { id, cicloId } = v<typeof viaCicloParams>(req, 'params');
    const { plazas } = v<typeof plazasCicloBody>(req, 'body');
    const r = await db.transaction(async (tx) => {
      const [fila] = await tx
        .update(plazasCiclo)
        .set({ plazas })
        .where(and(eq(plazasCiclo.viaId, id), eq(plazasCiclo.cicloId, cicloId)))
        .returning();
      if (!fila) throw notFound('Ese ciclo no tiene plazas en esta vía.', 'PLAZAS_CICLO_NO_ENCONTRADAS');
      const via = await sumarPlazasVia(tx, id);
      return { cicloId, plazas: fila.plazas, via: { id: via.id, plazas: via.plazas } };
    });
    res.json(r);
  },
);

// ── Entrevistadoras (16/11/2026) ─────────────────────────────────────────────

const entrevistadorBody = z.object({
  nombre: z.string().trim().min(1, 'Escribe el nombre.').max(120),
  /** Opcional: servirá para su calendario (B1). */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Correo no válido.')
    .max(200)
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
});
const entrevistadorEditarBody = entrevistadorBody
  .partial()
  .extend({ activo: z.boolean().optional(), orden: z.number().int().min(0).optional() })
  .refine((o) => Object.values(o).some((x) => x !== undefined), 'Nada que actualizar.');
const entrevistadorParams = z.object({ id: z.string().uuid() });

/** Lista de entrevistadoras (también las desactivadas, para leer lo antiguo). */
catalogoRouter.get('/entrevistadores', async (_req, res) => {
  res.json({ items: await db.select().from(entrevistadores).orderBy(asc(entrevistadores.orden), asc(entrevistadores.nombre)) });
});

catalogoRouter.post('/entrevistadores', requirePermiso('configuracion.editar'), validate({ body: entrevistadorBody }), async (req, res) => {
  const d = v<typeof entrevistadorBody>(req, 'body');
  const [ultimo] = await db.select({ orden: sql<number>`coalesce(max(${entrevistadores.orden}), -1)` }).from(entrevistadores);
  const [x] = await db
    .insert(entrevistadores)
    .values({ nombre: d.nombre, email: d.email ?? null, orden: Number(ultimo?.orden ?? -1) + 1 })
    .returning();
  res.status(201).json(x);
});

/** Nombre, correo, orden o desactivar (no se borra: puede ser responsable de solicitudes antiguas). */
catalogoRouter.patch(
  '/entrevistadores/:id',
  requirePermiso('configuracion.editar'),
  validate({ params: entrevistadorParams, body: entrevistadorEditarBody }),
  async (req, res) => {
    const { id } = v<typeof entrevistadorParams>(req, 'params');
    const [x] = await db.update(entrevistadores).set(v<typeof entrevistadorEditarBody>(req, 'body')).where(eq(entrevistadores.id, id)).returning();
    if (!x) throw notFound('Entrevistadora no encontrada.', 'ENTREVISTADOR_NO_ENCONTRADO');
    res.json(x);
  },
);
