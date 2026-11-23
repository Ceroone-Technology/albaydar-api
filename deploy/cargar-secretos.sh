#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Albaydar · vuelca la configuración de SSM Parameter Store a un .env
#
#    deploy/cargar-secretos.sh beta|produccion [destino]
#
#  Lee todos los parámetros de /albaydar/<entorno>/ (los SecureString, descifrados)
#  con las credenciales del rol de la instancia y escribe KEY=VALOR en el destino
#  (por defecto /opt/albaydar/.env), con permisos 600. Lo ejecuta el servidor antes
#  de «docker compose up»; los secretos no se guardan en el repositorio ni en GitHub.
#  Parámetros esperados: deploy/README.md.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENTORNO="${1:-}"
DESTINO="${2:-/opt/albaydar/.env}"
REGION="${AWS_REGION:-eu-west-1}"

case "$ENTORNO" in
  beta | produccion) ;;
  *) echo "Uso: $0 beta|produccion [destino]" >&2; exit 2 ;;
esac

umask 077
TMP="$(mktemp "$(dirname "$DESTINO")/.env.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# El entorno y la región también van al .env: docker compose los usa al interpolar.
printf 'ENTORNO=%s\nAWS_REGION=%s\n' "$ENTORNO" "$REGION" >"$TMP"

aws ssm get-parameters-by-path \
  --region "$REGION" \
  --path "/albaydar/$ENTORNO/" \
  --recursive \
  --with-decryption \
  --output json |
  python3 -c '
import json, re, sys
params = json.load(sys.stdin).get("Parameters", [])
if not params:
    sys.exit("No hay parámetros en SSM para este entorno.")
for p in sorted(params, key=lambda p: p["Name"]):
    nombre = p["Name"]
    clave = nombre.rsplit("/", 1)[-1]
    valor = p["Value"]
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", clave):
        sys.exit("Nombre de parámetro no válido: " + nombre)
    if "\n" in valor or "\r" in valor:
        sys.exit(clave + ": el valor no puede tener saltos de línea.")
    print(clave + "=" + valor)
' >>"$TMP"

chmod 600 "$TMP"
mv "$TMP" "$DESTINO"
trap - EXIT
echo "Configuración de $ENTORNO escrita en $DESTINO ($(wc -l <"$DESTINO" | tr -d ' ') variables)."
