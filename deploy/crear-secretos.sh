#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Albaydar · crea los secretos de un entorno en SSM Parameter Store
#
#    deploy/crear-secretos.sh beta|produccion
#
#  Genera valores aleatorios para los secretos que no vienen de fuera (JWT, base de datos,
#  Dirección inicial y la cabecera secreta de CloudFront) y los guarda
#  como SecureString en /albaydar/<entorno>/. No sobrescribe los que ya existen
#  (para rotar uno, bórralo antes). No imprime ningún valor. Requiere la AWS CLI
#  con permisos de SSM (ssm:PutParameter). El resto de parámetros: deploy/README.md.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENTORNO="${1:-}"
REGION="${AWS_REGION:-eu-west-1}"

case "$ENTORNO" in
  beta | produccion) ;;
  *) echo "Uso: $0 beta|produccion" >&2; exit 2 ;;
esac

# Solo letras y cifras: van tal cual al .env y dentro de DATABASE_URL.
aleatorio() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

crear() {
  local nombre="/albaydar/$ENTORNO/$1"
  if aws ssm get-parameter --region "$REGION" --name "$nombre" >/dev/null 2>&1; then
    echo "  $1: ya existe, no se toca"
    return
  fi
  aws ssm put-parameter --region "$REGION" --name "$nombre" --type SecureString --value "$2" \
    --tags "Key=Project,Value=albaydar" "Key=Environment,Value=$ENTORNO" >/dev/null
  echo "  $1: creado"
}

echo "Secretos de $ENTORNO en /albaydar/$ENTORNO/ ($REGION):"
crear JWT_ACCESS_SECRET "$(aleatorio 64)"
crear POSTGRES_PASSWORD "$(aleatorio 32)"
crear SEED_ADMIN_PASSWORD "$(aleatorio 20)"
# El mismo valor lo pone CloudFront en la cabecera X-Origin-Verify (stack de CDK).
crear CLOUDFRONT_ORIGIN_SECRET "$(aleatorio 48)"
echo "La contraseña inicial de Dirección se consulta (y se cambia tras el primer acceso) con:"
echo "  aws ssm get-parameter --region $REGION --with-decryption --name /albaydar/$ENTORNO/SEED_ADMIN_PASSWORD --query Parameter.Value --output text"
