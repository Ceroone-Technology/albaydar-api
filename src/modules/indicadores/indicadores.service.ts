import { and, asc, count, eq, gte, inArray, isNull, lt, ne, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { alumnas, cobros, interesados, reservas, solicitudes, vias, type FamiliaVia } from '../../db/schema';
import { db } from '../../lib/db';
import { pagadoPorReserva } from '../reservas/reservas.service';
import { COLUMNAS_PIPELINE } from '../solicitudes/dominio';
import { ESTADOS_OCUPAN_PLAZA } from '../solicitudes/comun';

/**
 * Indicadores (reunión del 18/11/2026): módulo aparte, de serie solo para Dirección y Administración.
 * Todo se calcula sobre un curso escolar (el de la admisión en marcha por defecto):
 *  - Ocupación: plazas de cada vía, las que ocupan las solicitudes (admitida, plaza reservada,
 *    matriculada) y el alumnado del curso por estado.
 *  - Captación: los interesados que entraron en la campaña de ese curso (del 1 de septiembre al
 *    31 de agosto anteriores: la de 2027-2028 va del 01/09/2026 al 31/08/2027).
 *  - Solicitudes: por columna del pipeline y por vía, con la tasa de admisión.
 *  - Ingresos: cobrado (sin anulados) y pendiente de las reservas de ese curso, por mes y por vía.
 * Importes en céntimos.
 */

export const indicadoresQuery = z.object({
  cursoEscolar: z
    .string()
    .regex(/^\d{4}-\d{4}$/)
    .optional(),
});

/** Campaña de captación de un curso: "2027-2028" → [2026-09-01, 2027-09-01). */
export function campanaDe(cursoEscolar: string): { desde: string; hasta: string } {
  const inicio = Number(cursoEscolar.slice(0, 4));
  return { desde: `${inicio - 1}-09-01`, hasta: `${inicio}-09-01` };
}

/** El curso que se pide, el del formulario público si no, y el último con vías en su defecto. */
async function cursoPorDefecto(cursos: string[]): Promise<string | null> {
  const [activa] = await db
    .select({ cursoEscolar: vias.cursoEscolar })
    .from(vias)
    .where(eq(vias.activa, true))
    .orderBy(asc(vias.cursoEscolar))
    .limit(1);
  return activa?.cursoEscolar ?? cursos.at(-1) ?? null;
}

const porcentaje = (parte: number, total: number) => (total > 0 ? Math.round((parte / total) * 1000) / 10 : null);

export async function indicadores(q: z.infer<typeof indicadoresQuery>) {
  const cursos = (await db.selectDistinct({ c: vias.cursoEscolar }).from(vias).orderBy(asc(vias.cursoEscolar))).map((x) => x.c);
  const cursoEscolar = q.cursoEscolar ?? (await cursoPorDefecto(cursos));
  if (cursoEscolar === null) {
    return { cursoEscolar: null, cursosEscolares: [], ocupacion: [], captacion: null, solicitudes: null, ingresos: null };
  }

  const delCurso = eq(vias.cursoEscolar, cursoEscolar);
  const campana = campanaDe(cursoEscolar);
  // Fecha de alta del interesado en hora del centro.
  const altaLocal = sql<string>`(${interesados.createdAt} at time zone 'Europe/Madrid')::date`;

  const [filasVias, porEstadoVia, alumnado, interesadosEstado, interesadosOrigen, perdidos, cobradoMes, cobradoVia, abiertas] =
    await Promise.all([
      db.select().from(vias).where(delCurso).orderBy(asc(vias.familia), asc(vias.curso)),
      db
        .select({ viaId: solicitudes.viaId, estado: solicitudes.estado, n: count() })
        .from(solicitudes)
        .innerJoin(vias, eq(vias.id, solicitudes.viaId))
        .where(delCurso)
        .groupBy(solicitudes.viaId, solicitudes.estado),
      db
        .select({ familia: alumnas.familia, curso: alumnas.curso, estado: alumnas.estado, n: count() })
        .from(alumnas)
        .where(and(eq(alumnas.cursoEscolar, cursoEscolar), ne(alumnas.estado, 'BAJA')))
        .groupBy(alumnas.familia, alumnas.curso, alumnas.estado),
      db
        .select({ estado: interesados.estado, n: count() })
        .from(interesados)
        .where(and(gte(altaLocal, campana.desde), lt(altaLocal, campana.hasta)))
        .groupBy(interesados.estado),
      db
        .select({
          origen: interesados.origen,
          n: count(),
          convertidos: sql<number>`count(*) filter (where ${interesados.estado} = 'SOLICITUD')`.mapWith(Number),
        })
        .from(interesados)
        .where(and(gte(altaLocal, campana.desde), lt(altaLocal, campana.hasta)))
        .groupBy(interesados.origen),
      db
        .select({ motivo: interesados.motivoPerdida, n: count() })
        .from(interesados)
        .where(and(eq(interesados.estado, 'PERDIDO'), gte(altaLocal, campana.desde), lt(altaLocal, campana.hasta)))
        .groupBy(interesados.motivoPerdida),
      db
        .select({ mes: sql<string>`to_char(${cobros.fecha}, 'YYYY-MM')`, total: sum(cobros.importe).mapWith(Number) })
        .from(cobros)
        .innerJoin(solicitudes, eq(solicitudes.id, cobros.solicitudId))
        .innerJoin(vias, eq(vias.id, solicitudes.viaId))
        .where(and(delCurso, isNull(cobros.anuladoEn)))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({ familia: vias.familia, total: sum(cobros.importe).mapWith(Number) })
        .from(cobros)
        .innerJoin(solicitudes, eq(solicitudes.id, cobros.solicitudId))
        .innerJoin(vias, eq(vias.id, solicitudes.viaId))
        .where(and(delCurso, isNull(cobros.anuladoEn)))
        .groupBy(vias.familia),
      db
        .select({ id: reservas.id, importe: reservas.importe, familia: vias.familia })
        .from(reservas)
        .innerJoin(solicitudes, eq(solicitudes.id, reservas.solicitudId))
        .innerJoin(vias, eq(vias.id, solicitudes.viaId))
        .where(and(delCurso, inArray(reservas.estado, ['PENDIENTE', 'VENCIDA']))),
    ]);

  // ── Ocupación ──
  const ocupan = new Set<string>(ESTADOS_OCUPAN_PLAZA);
  const alumnasDe = (familia: FamiliaVia, curso: number) => {
    const de = alumnado.filter((a) => a.familia === familia && a.curso === curso);
    const n = (estado: string) => de.find((a) => a.estado === estado)?.n ?? 0;
    return { reserva: n('RESERVA'), enProceso: n('EN_PROCESO'), matriculadas: n('MATRICULADA') };
  };
  const ocupacion = filasVias.map((x) => {
    const deLaVia = porEstadoVia.filter((s) => s.viaId === x.id);
    const ocupadas = deLaVia.filter((s) => ocupan.has(s.estado)).reduce((t, s) => t + s.n, 0);
    return {
      viaId: x.id,
      familia: x.familia,
      curso: x.curso,
      plazas: x.plazas,
      plazasAsignadasPorJunta: x.plazasAsignadasPorJunta,
      enFormulario: x.activa,
      ocupadas,
      alumnas: alumnasDe(x.familia, x.curso),
    };
  });

  // ── Captación ──
  const totalInteresados = interesadosEstado.reduce((t, x) => t + x.n, 0);
  const convertidos = interesadosEstado.find((x) => x.estado === 'SOLICITUD')?.n ?? 0;
  const captacion = {
    desde: campana.desde,
    hasta: campana.hasta,
    total: totalInteresados,
    porEstado: Object.fromEntries(interesadosEstado.map((x) => [x.estado, x.n])),
    porOrigen: interesadosOrigen
      .map((x) => ({ origen: x.origen, total: x.n, convertidos: x.convertidos }))
      .sort((a, b) => b.total - a.total),
    perdidosPorMotivo: perdidos
      .filter((x) => x.motivo !== null)
      .map((x) => ({ motivo: x.motivo!, total: x.n }))
      .sort((a, b) => b.total - a.total),
    conversion: porcentaje(convertidos, totalInteresados),
  };

  // ── Solicitudes ──
  const totalEstado = (estados: readonly string[]) =>
    porEstadoVia.filter((s) => estados.includes(s.estado)).reduce((t, s) => t + s.n, 0);
  const totalSolicitudes = porEstadoVia.reduce((t, s) => t + s.n, 0);
  const admitidas = totalEstado(ESTADOS_OCUPAN_PLAZA);
  const noAdmitidas = totalEstado(['NO_ADMITIDA']);
  const solicitudesInd = {
    total: totalSolicitudes,
    porColumna: Object.fromEntries(COLUMNAS_PIPELINE.map((c) => [c.id, totalEstado(c.estados)])),
    noAdmitidas,
    enEspera: totalEstado(['EN_ESPERA']),
    descartadas: totalEstado(['DESCARTADA']),
    admitidas,
    tasaAdmision: porcentaje(admitidas, admitidas + noAdmitidas),
    porVia: filasVias.map((x) => {
      const deLaVia = porEstadoVia.filter((s) => s.viaId === x.id);
      return {
        viaId: x.id,
        familia: x.familia,
        curso: x.curso,
        total: deLaVia.reduce((t, s) => t + s.n, 0),
        admitidas: deLaVia.filter((s) => ocupan.has(s.estado)).reduce((t, s) => t + s.n, 0),
      };
    }),
  };

  // ── Ingresos ──
  const pagado = await pagadoPorReserva(db, abiertas.map((r) => r.id));
  const pendientePorVia = new Map<FamiliaVia, number>();
  for (const r of abiertas) {
    pendientePorVia.set(r.familia, (pendientePorVia.get(r.familia) ?? 0) + r.importe - (pagado.get(r.id) ?? 0));
  }
  const familias = [...new Set([...filasVias.map((x) => x.familia), ...cobradoVia.map((x) => x.familia)])];
  const ingresos = {
    cobrado: cobradoVia.reduce((t, x) => t + (x.total ?? 0), 0),
    pendiente: [...pendientePorVia.values()].reduce((t, x) => t + x, 0),
    reservasAbiertas: abiertas.length,
    porMes: cobradoMes.map((x) => ({ mes: x.mes, cobrado: x.total ?? 0 })),
    porVia: familias.map((familia) => ({
      familia,
      cobrado: cobradoVia.find((x) => x.familia === familia)?.total ?? 0,
      pendiente: pendientePorVia.get(familia) ?? 0,
    })),
  };

  return { cursoEscolar, cursosEscolares: cursos, ocupacion, captacion, solicitudes: solicitudesInd, ingresos };
}
