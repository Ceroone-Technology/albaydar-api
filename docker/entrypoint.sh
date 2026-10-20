#!/bin/sh
# Arranque del contenedor de la API:
#   1. espera a PostgreSQL y aplica las migraciones pendientes
#   2. siembra datos iniciales (idempotente) si RUN_SEED=true
#   3. arranca el servidor (o el comando que se pase)
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node dist/db/migrate.js
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  node dist/db/seed.js
fi

exec "$@"
