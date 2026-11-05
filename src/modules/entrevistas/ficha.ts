import { z } from 'zod';
import type { FamiliaVia } from '../../db/schema';

/**
 * Ficha de la entrevista: la parte «ENTREVISTA» y «DATOS A RELLENAR POR EL CENTRO» de la
 * solicitud en papel de Bachillerato (docs/referencia, fuera del repo). Se guarda como JSON en
 * `entrevistas.ficha`: es 1:1 con la entrevista y la ficha de FP, cuando llegue, tendrá otros campos.
 * Las observaciones de la ficha son `entrevistas.notas`, que ya existía.
 */

export const MODALIDADES = ['HUMANIDADES_CCSS', 'CIENCIAS_TECNOLOGIA'] as const;
export const OPTATIVAS = ['LATIN', 'MATEMATICAS', 'BIOLOGIA', 'DIBUJO_TECNICO'] as const;
export const VALORACIONES = ['FAVORABLE', 'CON_RESERVAS', 'DESFAVORABLE'] as const;
export const ENTREVISTADOS = ['PADRE', 'MADRE', 'ALUMNA'] as const;

/** Optativas de cada modalidad, como en la ficha (en 2º, «Latín II»). */
export const OPTATIVAS_DE: Record<(typeof MODALIDADES)[number], readonly (typeof OPTATIVAS)[number][]> = {
  HUMANIDADES_CCSS: ['LATIN', 'MATEMATICAS'],
  CIENCIAS_TECNOLOGIA: ['BIOLOGIA', 'DIBUJO_TECNICO'],
};

const texto = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

/**
 * Entrada (PATCH): todos los campos opcionales y sin `.default()` (trampa 1 de Zod 4); lo que no
 * llega se conserva. `null` borra el dato.
 */
export const fichaEntrada = z
  .object({
    /** ¿Ha solicitado plaza en otro centro? Y cuál. */
    otroCentro: z.boolean().nullable().optional(),
    otroCentroNombre: texto(200),
    /** ¿Por qué ha elegido Albaydar? */
    motivoEleccion: texto(2000),
    /** ¿Ha repetido algún curso? Y cuál o por qué. */
    haRepetido: z.boolean().nullable().optional(),
    repeticionDetalle: texto(500),
    /** Nota media del último curso, de 0 a 10 con dos decimales. */
    notaMedia: z
      .number()
      .min(0, 'La nota media va de 0 a 10.')
      .max(10, 'La nota media va de 0 a 10.')
      .transform((n) => Math.round(n * 100) / 100)
      .nullable()
      .optional(),
    /** Modalidad y optativa de Bachillerato que confirma el entrevistador. */
    modalidad: z.enum(MODALIDADES).nullable().optional(),
    optativa: z.enum(OPTATIVAS).nullable().optional(),
    /** Documentación presentada: boletín entregado en mano (el subido por enlace ya consta aparte). */
    boletinEntregado: z.boolean().nullable().optional(),
    fechaEntregaNotas: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha con formato AAAA-MM-DD.')
      .nullable()
      .optional(),
    valoracion: z.enum(VALORACIONES).nullable().optional(),
    valoracionComentario: texto(2000),
    entrevistados: z.array(z.enum(ENTREVISTADOS)).max(3).optional(),
    /** Entrevista realizada por (texto: los entrevistadores aún no son usuarios, bloque C). */
    realizadaPor: texto(200),
  })
  .strict();

export type FichaEntrada = z.infer<typeof fichaEntrada>;

export interface Ficha {
  otroCentro: boolean | null;
  otroCentroNombre: string | null;
  motivoEleccion: string | null;
  haRepetido: boolean | null;
  repeticionDetalle: string | null;
  notaMedia: number | null;
  modalidad: (typeof MODALIDADES)[number] | null;
  optativa: (typeof OPTATIVAS)[number] | null;
  boletinEntregado: boolean | null;
  fechaEntregaNotas: string | null;
  valoracion: (typeof VALORACIONES)[number] | null;
  valoracionComentario: string | null;
  entrevistados: (typeof ENTREVISTADOS)[number][];
  realizadaPor: string | null;
}

export const FICHA_VACIA: Ficha = {
  otroCentro: null,
  otroCentroNombre: null,
  motivoEleccion: null,
  haRepetido: null,
  repeticionDetalle: null,
  notaMedia: null,
  modalidad: null,
  optativa: null,
  boletinEntregado: null,
  fechaEntregaNotas: null,
  valoracion: null,
  valoracionComentario: null,
  entrevistados: [],
  realizadaPor: null,
};

/** La guardada más lo que llega; lo que no llega se conserva. Sin duplicados en entrevistados. */
export function combinarFicha(actual: Ficha | null, d: FichaEntrada): Ficha {
  const base = { ...FICHA_VACIA, ...(actual ?? {}) };
  const cambios = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as Partial<Ficha>;
  const f = { ...base, ...cambios };
  return { ...f, entrevistados: ENTREVISTADOS.filter((x) => f.entrevistados.includes(x)) };
}

/** Errores de coherencia de la ficha (para 400 DATOS_INVALIDOS con `details`). */
export function erroresFicha(f: Ficha, familia: FamiliaVia, hoy: string): { campo: string; mensaje: string }[] {
  const errores: { campo: string; mensaje: string }[] = [];
  if (familia !== 'BACHILLERATO' && (f.modalidad || f.optativa)) {
    errores.push({ campo: 'ficha.modalidad', mensaje: 'La modalidad y la optativa solo se indican en Bachillerato.' });
  }
  if (f.optativa && !f.modalidad) {
    errores.push({ campo: 'ficha.optativa', mensaje: 'Indica la modalidad antes que la optativa.' });
  } else if (f.optativa && f.modalidad && !OPTATIVAS_DE[f.modalidad].includes(f.optativa)) {
    errores.push({ campo: 'ficha.optativa', mensaje: 'Esa optativa no corresponde a la modalidad elegida.' });
  }
  if (f.fechaEntregaNotas && f.fechaEntregaNotas > hoy) {
    errores.push({ campo: 'ficha.fechaEntregaNotas', mensaje: 'La fecha de entrega de las notas no puede ser futura.' });
  }
  return errores;
}

/** Lo mínimo para dar la entrevista por realizada (acordado el 05/11/2026): valoración y entrevistados. */
export function faltanParaRealizada(f: Ficha | null): ('valoracion' | 'entrevistados')[] {
  const faltan: ('valoracion' | 'entrevistados')[] = [];
  if (!f?.valoracion) faltan.push('valoracion');
  if (!f?.entrevistados.length) faltan.push('entrevistados');
  return faltan;
}
