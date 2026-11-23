# Despliegue en AWS · configuración y secretos

Patrón EC2 de Subvfy: una EC2 con Docker (API y PostgreSQL), CloudFront delante y ficheros en S3. La configuración de cada entorno vive en **SSM Parameter Store**, en `/albaydar/<entorno>/`, con `<entorno>` = `beta` o `produccion`. Nunca va en el repositorio ni en GitHub.

## Scripts

| Script | Dónde se ejecuta | Qué hace |
|---|---|---|
| `crear-secretos.sh beta\|produccion` | Una vez, desde un equipo con la AWS CLI | Genera valores aleatorios (solo letras y cifras) para `JWT_ACCESS_SECRET`, `POSTGRES_PASSWORD` y `SEED_ADMIN_PASSWORD`, y los guarda como `SecureString`. No sobrescribe los que ya existen y no imprime ningún valor |
| `cargar-secretos.sh beta\|produccion [destino]` | En el servidor, antes de `docker compose up` | Vuelca los parámetros a `/opt/albaydar/.env` (permisos 600) con las credenciales del rol de la instancia, más `ENTORNO` y `AWS_REGION`. Si algo falla, no deja un `.env` a medias |
| `docker-compose.prod.yml` | En el servidor (`/opt/albaydar`) | API y PostgreSQL 16 para la EC2 de 1 GB (ver abajo) |

## Parámetros de `/albaydar/<entorno>/`

**Secretos** (`SecureString`):

| Parámetro | Origen |
|---|---|
| `JWT_ACCESS_SECRET` | `crear-secretos.sh` (64 caracteres) |
| `POSTGRES_PASSWORD` | `crear-secretos.sh` (32). El compose arma `DATABASE_URL` con ella |
| `SEED_ADMIN_PASSWORD` | `crear-secretos.sh` (20). Contraseña inicial de Dirección: se cambia tras el primer acceso |
| `CLOUDFRONT_ORIGIN_SECRET` | `crear-secretos.sh` (48). CloudFront lo envía en la cabecera `X-Origin-Verify` y la API rechaza (403) lo que no lo traiga, salvo `/health` |
| `SMTP_USER`, `SMTP_PASS` | Credenciales SMTP de SES (usuario IAM de envío) |
| `SEED_DEMO_PASSWORD` | Solo si se siembra la demo (`SEED_DEMO=true`). Al menos 12 caracteres |

**Configuración** (`String`):

| Parámetro | Ejemplo |
|---|---|
| `PUBLIC_APP_URL` | `https://dxxxx.cloudfront.net` (los enlaces de los correos) |
| `CORS_ORIGINS` | La misma URL |
| `S3_BUCKET` | `albaydar-beta-uploads-<cuenta>` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | `email-smtp.eu-west-1.amazonaws.com`, `587`, `false` |
| `MAIL_FROM` | `Centro Educativo Albaydar <dirección verificada en SES>` |
| `MAIL_SECRETARIA`, `MAIL_ADMINISTRACION`, `MAIL_REPLY_TO` | Correos del centro |
| `MAIL_DESVIO` | **Obligatorio en beta**: todos los correos van a esta dirección (verificada en SES mientras esté en sandbox) |
| `SEED_ADMIN_EMAIL` | Correo del usuario de Dirección inicial |
| `MAIL_MAX_POR_SEGUNDO`, `MAIL_MAX_POR_DIA` | Ritmo de la cola. Con SES en sandbox, `1` y `200`; cuando salga del sandbox, los de la cuenta. Lo que no cabe espera en la cola; las notificaciones masivas van detrás de los correos del flujo y no gastan el último 20 % del cupo diario |

**Fijos en el `docker-compose` del servidor** (no van en SSM): `ENTORNO`, `NODE_ENV=production`, `STORAGE=s3`, `TRUST_PROXY=true`, `COOKIE_SECURE=true` y `AWS_REGION`.

## Lo que la API comprueba al arrancar en un servidor

Con `ENTORNO=beta` o `produccion`, la API **no arranca** (y dice por qué) si:
- el `JWT_ACCESS_SECRET` es el de ejemplo del Docker local, o la contraseña de la base de datos tiene menos de 16 caracteres;
- falta `COOKIE_SECURE` o `TRUST_PROXY`, o el `CLOUDFRONT_ORIGIN_SECRET` (al menos 32 caracteres);
- el correo apunta a Mailpit, los ficheros no van a S3 o `PUBLIC_APP_URL` no es https;
- en beta, falta `MAIL_DESVIO`.

Y la semilla no crea ningún usuario con las contraseñas de ejemplo del repositorio (`CambiaEsto-2026!`, `Albaydar-2026`).

## El compose del servidor (`docker-compose.prod.yml`)

```bash
cd /opt/albaydar
./cargar-secretos.sh beta
docker compose -f docker-compose.prod.yml up -d
```

- **Sin Mailpit ni proxy:** CloudFront termina el HTTPS y reenvía `/api/*` al puerto 80. El grupo de seguridad solo admite el tráfico de CloudFront.
- **PostgreSQL 16:**
  - afinado para poca memoria: 30 conexiones, `shared_buffers` de 64 MB y `work_mem` de 4 MB, en hora de Madrid;
  - datos en `/data/postgres`, el volumen EBS de datos con snapshots;
  - **sin puertos publicados**.
- **API:**
  - imagen `albaydar-api:actual`, que se carga con `docker load` (en el servidor no se construye);
  - arranca como **`node`** (sin root);
  - sistema de ficheros de **solo lectura** (solo se escribe en `/tmp`), con los ficheros en S3 mediante el rol de la instancia.
- **Memoria:** PostgreSQL hasta 320 MB y la API hasta 384 MB (Node con un heap de 256 MB). En reposo usan unos 50 MB cada uno.
- **Logs:** rotación de 3 × 10 MB por contenedor.
- Sin `ENTORNO` o sin `POSTGRES_PASSWORD` el compose no arranca. La API comprueba el resto al arrancar (sección anterior).

Ensayado en local el 23/11/2026 (Mac ARM64, como la EC2 t4g), con una configuración de beta falsa y un S3 de prueba.
