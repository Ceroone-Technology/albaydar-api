#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Albaydar · publica la API en un entorno de AWS
#
#    deploy/publicar-api.sh beta
#
#  Desde la raíz del repo de la API, con la AWS CLI y Docker:
#   1. construye la imagen ARM64 (la EC2 es Graviton) con la versión del commit;
#   2. sube imagen, compose y scripts al bucket «releases» del stack;
#   3. ordena a la EC2, por Session Manager, que la instale (instalar-en-servidor.sh)
#      y espera el resultado. Si /health falla, el servidor vuelve a la versión anterior.
#  Lo usan las personas (primer despliegue) y GitHub Actions (rol OIDC del stack).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENTORNO="${1:-}"
REGION="${AWS_REGION:-eu-west-1}"
case "$ENTORNO" in
  beta | produccion) ;;
  *) echo "Uso: $0 beta|produccion" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."

salida() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "Albaydar-$ENTORNO" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(salida BucketReleases)"
SERVIDOR="$(salida ServidorId)"

VERSION="$(git rev-parse --short=12 HEAD)"
if [ -n "$(git status --porcelain)" ]; then VERSION="$VERSION-local$(date +%H%M%S)"; fi
echo "Albaydar $ENTORNO · versión $VERSION · servidor $SERVIDOR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
docker buildx build --platform linux/arm64 -t "albaydar-api:$VERSION" --load .
docker save "albaydar-api:$VERSION" | gzip >"$TMP/albaydar-api.tar.gz"

DESTINO="s3://$BUCKET/api/$VERSION"
aws s3 cp "$TMP/albaydar-api.tar.gz" "$DESTINO/albaydar-api.tar.gz" --only-show-errors
for f in docker-compose.prod.yml cargar-secretos.sh instalar-en-servidor.sh; do
  aws s3 cp "deploy/$f" "$DESTINO/$f" --only-show-errors
done

ORDEN="aws s3 cp $DESTINO/instalar-en-servidor.sh /tmp/instalar-albaydar.sh --only-show-errors && bash /tmp/instalar-albaydar.sh $ENTORNO $BUCKET $VERSION"
ID="$(aws ssm send-command --region "$REGION" --instance-ids "$SERVIDOR" --document-name AWS-RunShellScript \
  --comment "Albaydar $ENTORNO $VERSION" --timeout-seconds 600 \
  --parameters "commands=[\"$ORDEN\"],executionTimeout=[\"900\"]" \
  --query Command.CommandId --output text)"
echo "Orden enviada al servidor ($ID). Esperando…"

# Hasta 15 min: cargar la imagen y arrancar lleva 1–2 min.
for _ in $(seq 1 180); do
  ESTADO="$(aws ssm get-command-invocation --region "$REGION" --command-id "$ID" --instance-id "$SERVIDOR" --query Status --output text 2>/dev/null || echo Pending)"
  case "$ESTADO" in Pending | InProgress | Delayed) sleep 5 ;; *) break ;; esac
done
RESULTADO="$(aws ssm get-command-invocation --region "$REGION" --command-id "$ID" --instance-id "$SERVIDOR" --output json)"
echo "$RESULTADO" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["StandardOutputContent"]); print(r["StandardErrorContent"], file=sys.stderr); sys.exit(0 if r["Status"]=="Success" else 1)'
