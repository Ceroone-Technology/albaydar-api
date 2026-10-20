import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:4200')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  TRUST_PROXY: bool,

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(14),
  COOKIE_SECURE: bool,
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional().transform((v) => v || undefined),

  PUBLIC_APP_URL: z.string().url().default('http://localhost:4200'),
  CITA_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  COMPLETAR_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional().transform((v) => v || undefined),
  SMTP_PASS: z.string().optional().transform((v) => v || undefined),
  MAIL_FROM: z.string().default('Centro Educativo Albaydar <admisiones@albaydar.org>'),
  MAIL_SECRETARIA: z.string().email().default('secretaria@albaydar.org'),
  /**
   * Demostraciones: si se indica, TODOS los correos van a este buzón (con el
   * destinatario real en el asunto). Evita escribir a direcciones de ejemplo reales.
   */
  MAIL_DESVIO: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.string().email('MAIL_DESVIO debe ser un correo.').optional()),

  TZ_CENTRO: z.string().default('Europe/Madrid'),
  RECORDATORIO_CITA_DIAS: z.coerce.number().int().positive().default(3),
  WORKERS_ENABLED: bool,

  UPLOADS_DIR: z.string().default('./storage/uploads'),
  UPLOAD_MAX_MB: z.coerce.number().positive().default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Configuración inválida:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Datos fijos del centro que aparecen en correos y en la página de cita. */
export const CENTRO = {
  nombre: 'Centro Educativo Albaydar',
  direccion: 'Avda. de la Palmera, 36 · 41012 Sevilla',
  telefono: '954 61 02 54',
  logo: 'https://albaydar.org/wp-content/uploads/2023/03/cropped-logo-final.png',
  /** La entrevista es siempre presencial, con el equipo directivo, en esta sala. */
  entrevista: {
    tipo: 'Presencial',
    con: 'Equipo directivo',
    lugar: 'Sala de reuniones de Dirección',
    duracionMin: 45,
  },
} as const;
