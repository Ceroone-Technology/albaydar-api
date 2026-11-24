#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Albaydar · instala una versión de la API en el servidor (lo ejecuta la EC2)
#
#    instalar-en-servidor.sh <entorno> <bucket-releases> <version>
#
#  Lo lanza publicar-api.sh por Session Manager (AWS-RunShellScript, como root):
#  descarga de S3 el compose, el cargador de secretos y la imagen; la carga como
#  albaydar-api:actual (la que había queda como :anterior), vuelca los secretos de
#  SSM y hace «docker compose up -d». Si /health no responde, vuelve a la anterior.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENTORNO="$1"
BUCKET="$2"
VERSION="$3"
DIR=/opt/albaydar
ORIGEN="s3://$BUCKET/api/$VERSION"
COMPOSE=(docker compose -f "$DIR/docker-compose.prod.yml" --project-directory "$DIR")

cd "$DIR"
aws s3 cp "$ORIGEN/docker-compose.prod.yml" "$DIR/docker-compose.prod.yml" --only-show-errors
aws s3 cp "$ORIGEN/cargar-secretos.sh" "$DIR/cargar-secretos.sh" --only-show-errors
chmod 700 "$DIR/cargar-secretos.sh"

IMAGEN=/tmp/albaydar-api.tar.gz
aws s3 cp "$ORIGEN/albaydar-api.tar.gz" "$IMAGEN" --only-show-errors
docker load -i "$IMAGEN"
rm -f "$IMAGEN"

if docker image inspect albaydar-api:actual >/dev/null 2>&1; then
  docker tag albaydar-api:actual albaydar-api:anterior
fi
docker tag "albaydar-api:$VERSION" albaydar-api:actual

"$DIR/cargar-secretos.sh" "$ENTORNO" "$DIR/.env"
"${COMPOSE[@]}" up -d --remove-orphans

sano() {
  for _ in $(seq 1 45); do
    curl -fsS http://localhost/health >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

if sano; then
  echo "Albaydar $ENTORNO: versión $VERSION en marcha."
  docker image prune -f >/dev/null
  exit 0
fi

echo "La versión $VERSION no responde en /health. Registros de la API:" >&2
"${COMPOSE[@]}" logs --tail 60 api >&2 || true
if docker image inspect albaydar-api:anterior >/dev/null 2>&1; then
  echo "Vuelvo a la versión anterior." >&2
  docker tag albaydar-api:anterior albaydar-api:actual
  "${COMPOSE[@]}" up -d
  sano && echo "La versión anterior vuelve a estar en marcha." >&2
fi
exit 1
