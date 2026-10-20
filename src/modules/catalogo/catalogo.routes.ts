import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { familiaViaEnum, vias } from '../../db/schema';
import { db } from '../../lib/db';
import { notFound } from '../../lib/errors';
import { requireRol } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { plazasOcupadas } from '../solicitudes/comun';
import { ETAPA, ETIQUETA_FAMILIA_VIA } from '../solicitudes/dominio';

/** Vías activas para el formulario público: familia (1er nivel) → curso (2º nivel). */
export async function viasPublicas() {
  const filas = await db.select().from(vias).where(eq(vias.activa, true)).orderBy(asc(vias.familia), asc(vias.curso));
  const familias = familiaViaEnum.enumValues
    .map((f) => ({
      familia: f,
      etiqueta: ETIQUETA_FAMILIA_VIA[f],
      etapa: ETAPA[f],
      cursos: filas.filter((x) => x.familia === f).map((x) => ({ viaId: x.id, curso: x.curso, nombre: x.nombre })),
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

export const catalogoRouter = Router();

/** Vías con plazas libres (Configuración y comprobación de plazas). */
catalogoRouter.get('/vias', async (_req, res) => {
  const filas = await db.select().from(vias).orderBy(asc(vias.cursoEscolar), asc(vias.familia), asc(vias.curso));
  res.json({
    items: await Promise.all(
      filas.map(async (x) => {
        const ocupadas = await plazasOcupadas(db, x.id);
        return { ...x, etiqueta: ETIQUETA_FAMILIA_VIA[x.familia], ocupadas, libres: x.plazasAsignadasPorJunta ? null : Math.max(0, x.plazas - ocupadas) };
      }),
    ),
  });
});

catalogoRouter.post('/vias', requireRol('ADMIN'), validate({ body: viaBody }), async (req, res) => {
  const [x] = await db.insert(vias).values(v<typeof viaBody>(req, 'body')).returning();
  res.status(201).json(x);
});

catalogoRouter.patch(
  '/vias/:id',
  requireRol('ADMIN'),
  validate({ params: z.object({ id: z.string().uuid() }), body: viaBody.partial() }),
  async (req, res) => {
    const { id } = v<z.ZodObject<{ id: z.ZodString }>>(req, 'params');
    const [x] = await db.update(vias).set(v<typeof viaBody>(req, 'body')).where(and(eq(vias.id, id))).returning();
    if (!x) throw notFound('Vía no encontrada.');
    res.json(x);
  },
);
