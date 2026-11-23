#!/bin/sh
# Arranque del contenedor de la API:
#   0. si arranca como root, cede la carpeta de ficheros y se relanza como RUN_AS_USER
#   1. espera a PostgreSQL y aplica las migraciones pendientes
#   2. siembra datos iniciales (idempotente) si RUN_SEED=true
#   3. arranca el servidor (o el comando que se pase)
# Las migraciones, la semilla y el servidor nunca corren como root.
set -e

# La carpeta de ficheros viene de tu equipo (Docker local). Si arrancamos como root, se la
# cedemos al usuario sin privilegios y nos relanzamos como él. En el servidor de AWS el
# contenedor ya arranca como «node» (docker-compose.prod.yml) y los ficheros van a S3.
DIR="${UPLOADS_DIR:-/app/storage/uploads}"
mkdir -p "$DIR" 2>/dev/null || true
if [ "$(id -u)" = "0" ] && [ -n "$RUN_AS_USER" ]; then
  chown -R "$RUN_AS_USER:$RUN_AS_USER" "$DIR" 2>/dev/null || true
  exec su-exec "$RUN_AS_USER" "$0" "$@"
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node dist/db/migrate.js
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  node dist/db/seed.js
fi

exec "$@"
