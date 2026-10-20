import { z } from 'zod';
import { canalSolicitudEnum, estadoSolicitudEnum, familiaViaEnum } from '../../db/schema';
import { COLUMNAS_PIPELINE } from './dominio';

const texto = (max = 120) => z.string().trim().min(1, 'Obligatorio.').max(max);
const textoOpc = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Correo no válido.')
  .max(200);

export const telefono = z
  .string()
  .trim()
  .regex(/^\+?[\d\s().-]{9,20}$/, 'Teléfono no válido.');

/**
 * Campos de la solicitud (los del mockup). Todos obligatorios salvo la modalidad.
 */
export const camposFamilia = {
  viaId: z.string().uuid('Elige la etapa y el curso.'),
  alumnaNombre: texto(),
  alumnaApellidos: texto(),
  centroProcedencia: texto(200),
  modalidadInteres: textoOpc(),
  tutorNombre: texto(160),
  email,
  telefono,
};

/** Formulario público "Albaydar Solicitud". */
export const solicitudPublicaBody = z.object({
  ...camposFamilia,
  consentimientoPrivacidad: z.literal(true, { error: 'Debes aceptar la política de privacidad.' }),
  /** Honeypot anti-bots: el front lo deja oculto y vacío. */
  website: z.string().max(0).optional(),
});

/** Alta interna (solicitud por teléfono, presencial, puertas abiertas o SNEC). */
export const solicitudInternaBody = z.object({
  ...camposFamilia,
  // Por teléfono pueden faltar el correo o el centro: la revisión lo marca y se pide completar después.
  email: email.or(z.literal('')).transform((v) => v || ''),
  centroProcedencia: textoOpc(200),
  canal: z.enum(canalSolicitudEnum.enumValues).default('TELEFONO'),
  asignadaSnec: z.boolean().default(false),
  esAlumnaNueva: z.boolean().default(true),
  responsableId: z.string().uuid().optional().nullable(),
  observacionesInternas: textoOpc(4000),
  consentimientoPrivacidad: z.literal(true, { error: 'Registra el consentimiento de la familia.' }),
});

/** Completar desde el enlace: solo los campos de la familia, todos opcionales. */
export const completarBody = z
  .object(camposFamilia)
  .omit({ viaId: true })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'No has enviado ningún dato.');

export const gestionBody = z
  .object({
    responsableId: z.string().uuid().nullable().optional(),
    observacionesInternas: textoOpc(4000),
    asignadaSnec: z.boolean().optional(),
    canal: z.enum(canalSolicitudEnum.enumValues).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'Nada que actualizar.');

export const pedirCompletarBody = z.object({
  /** Si no se indica, se usan los campos que faltan según la revisión. */
  campos: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  mensaje: textoOpc(1000),
});

export const cambiarEstadoBody = z.object({
  estado: z.enum(estadoSolicitudEnum.enumValues),
  motivo: textoOpc(500),
});

const lista = <T extends [string, ...string[]]>(valores: T) =>
  z
    .union([z.enum(valores), z.array(z.enum(valores))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));

const columnas = COLUMNAS_PIPELINE.map((c) => c.id) as unknown as [string, ...string[]];

export const listarQuery = z.object({
  /** bandeja = pendientes de admisión; pipeline = todo menos descartadas/no admitidas */
  vista: z.enum(['bandeja', 'pipeline', 'todas']).default('todas'),
  columna: z.enum(columnas).optional(),
  estado: lista(estadoSolicitudEnum.enumValues as unknown as [string, ...string[]]),
  familiaVia: lista(familiaViaEnum.enumValues as unknown as [string, ...string[]]),
  curso: z.coerce.number().int().min(1).max(2).optional(),
  canal: lista(canalSolicitudEnum.enumValues as unknown as [string, ...string[]]),
  asignadaSnec: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  responsableId: z.string().uuid().optional(),
  /** Busca por alumna, familia, correo, teléfono o código. */
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  orden: z.enum(['recientes', 'antiguas', 'actualizadas']).default('recientes'),
});

export const pipelineQuery = listarQuery.omit({ vista: true, columna: true, page: true, orden: true }).extend({
  /** Tarjetas por columna en la primera carga; el resto se pide con /solicitudes?columna=… */
  porColumna: z.coerce.number().int().min(1).max(200).default(30),
});

export const idParam = z.object({ id: z.string().uuid() });
export const tokenParam = z.object({ token: z.string().min(20).max(100) });
