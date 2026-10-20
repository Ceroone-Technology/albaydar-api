#!/bin/sh
# Arranque del contenedor de la API:
#   1. espera a PostgreSQL y aplica las migraciones pendientes
#   2. siembra datos iniciales (idempotente) si RUN_SEED=true
#   3. arranca el servidor (o el comando que se pase)
set -e

# La carpeta de ficheros viene de tu equipo. Si arrancamos como root, se la cedemos
# al usuario sin privilegios con el que corre el servidor (en Windows/Mac no hace falta).
DIR="${UPLOADS_DIR:-/app/storage/uploads}"
mkdir -p "$DIR" 2>/dev/null || true
if [ "$(id -u)" = "0" ] && [ -n "$RUN_AS_USER" ]; then
  chown -R "$RUN_AS_USER:$RUN_AS_USER" "$DIR" 2>/dev/null || true
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node dist/db/migrate.js
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  node dist/db/seed.js
fi

exec "$@"
