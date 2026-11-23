import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

/** El JWT de ejemplo del docker-compose local: nunca en un servidor. */
const JWT_DE_DESARROLLO = 'solo-para-desarrollo-local-cambiar-en-servidor-0123456789';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Dónde corre la API (22/11/2026). El Docker local también usa NODE_ENV=production, así que
   * esto es lo que distingue un servidor accesible desde internet: en beta y producción la API
   * no arranca con secretos de ejemplo, cookies sin Secure, Mailpit ni (en beta) sin desvío.
   */
  ENTORNO: z.enum(['local', 'beta', 'produccion']).default('local'),
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
   * A dónde llegan las respuestas a los correos (Reply-To). Acordado el 21/10/2026: si la familia
   * responde al correo para cancelar o cambiar, que lo lea secretaría. Si no se indica, MAIL_SECRETARIA.
   */
  MAIL_REPLY_TO: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.string().email('MAIL_REPLY_TO debe ser un correo.').optional()),
  /** Avisos de cobros (reserva vencida). Si no se indica, van solo a MAIL_SECRETARIA. */
  MAIL_ADMINISTRACION: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.string().email('MAIL_ADMINISTRACION debe ser un correo.').optional()),
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

  /**
   * Secreto que CloudFront añade en la cabecera X-Origin-Verify al reenviar /api/* al servidor.
   * Con él, la API rechaza lo que no venga de NUESTRA distribución (el grupo de seguridad
   * admite a cualquier CloudFront). Sin él (local), no se comprueba.
   */
  CLOUDFRONT_ORIGIN_SECRET: z.string().optional().transform((v) => v || undefined),
  /**
   * Ritmo de la cola de correo (0 = sin límite, como en local). SES en sandbox: 1 por segundo
   * y 200 en 24 h. Lo que no cabe espera en la cola; las notificaciones masivas van detrás de
   * los correos del flujo y no gastan el último 20 % del cupo diario.
   */
  MAIL_MAX_POR_SEGUNDO: z.coerce.number().min(0).default(0),
  MAIL_MAX_POR_DIA: z.coerce.number().int().min(0).default(0),
  /**
   * Dónde se guardan los ficheros (documentos, comprobantes, PDF de la matrícula):
   * 'disco' (UPLOADS_DIR, en local) o 's3' (S3_BUCKET, en AWS). Credenciales de S3: las
   * del entorno (rol de la instancia en AWS; perfil o variables AWS_* en local).
   */
  STORAGE: z.enum(['disco', 's3']).default('disco'),
  UPLOADS_DIR: z.string().default('./storage/uploads'),
  S3_BUCKET: z.string().optional().transform((v) => v || undefined),
  /** Prefijo de las claves dentro del bucket (p. ej. «uploads/»). */
  S3_PREFIX: z.string().default(''),
  AWS_REGION: z.string().default('eu-west-1'),
  /** Solo para probar contra un S3 compatible (MinIO); en AWS no se indica. */
  S3_ENDPOINT: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  UPLOAD_MAX_MB: z.coerce.number().positive().default(10),
})
  .refine((e) => e.STORAGE !== 's3' || !!e.S3_BUCKET, { message: 'Con STORAGE=s3 hay que indicar S3_BUCKET.', path: ['S3_BUCKET'] })
  .superRefine((e, ctx) => {
    if (e.ENTORNO === 'local') return;
    const error = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message: `${message} (ENTORNO=${e.ENTORNO})` });
    if (e.JWT_ACCESS_SECRET === JWT_DE_DESARROLLO) error('JWT_ACCESS_SECRET', 'Es el secreto de ejemplo del Docker local: genera uno propio');
    const pass = (() => {
      try {
        return decodeURIComponent(new URL(e.DATABASE_URL).password);
      } catch {
        return '';
      }
    })();
    if (pass.length < 16) error('DATABASE_URL', 'La contraseña de la base de datos debe tener al menos 16 caracteres');
    if (!e.COOKIE_SECURE) error('COOKIE_SECURE', 'Detrás de HTTPS la cookie de sesión tiene que ser Secure');
    if (!e.TRUST_PROXY) error('TRUST_PROXY', 'Detrás de CloudFront hace falta para la IP real (límites por IP) y el HTTPS');
    if (['mailpit', 'localhost', '127.0.0.1'].includes(e.SMTP_HOST)) error('SMTP_HOST', 'Mailpit es solo para local: indica el servidor de correo real (SES)');
    if (e.ENTORNO === 'beta' && !e.MAIL_DESVIO) error('MAIL_DESVIO', 'En beta todos los correos tienen que ir a una dirección de desvío');
    if (e.STORAGE !== 's3') error('STORAGE', 'En un servidor los ficheros van a S3');
    if (e.PUBLIC_APP_URL.startsWith('http://')) error('PUBLIC_APP_URL', 'Tiene que ser https');
    if (!e.CLOUDFRONT_ORIGIN_SECRET || e.CLOUDFRONT_ORIGIN_SECRET.length < 32) {
      error('CLOUDFRONT_ORIGIN_SECRET', 'Hace falta el secreto de la cabecera de CloudFront (al menos 32 caracteres)');
    }
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
