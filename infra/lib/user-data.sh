#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Albaydar · primer arranque de la EC2 (Amazon Linux 2023, ARM64)
#  Docker + Compose, 2 GB de swap, volumen de datos en /data y el servicio que
#  arranca la aplicación. La aplicación (compose, scripts e imagen) la deja el
#  despliegue en /opt/albaydar; hasta entonces el servicio no tiene nada que arrancar.
# ─────────────────────────────────────────────────────────────────────────────
set -euxo pipefail

ENTORNO="__ENTORNO__"
COMPOSE_VERSION="v2.29.7"

# Docker y el plugin de Compose (AL2023 no lo trae).
dnf install -y docker
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-aarch64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# 2 GB de swap: colchón para la instancia de 1 GB.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
swapon -a

# Volumen de datos (EBS aparte, con snapshots diarios): se formatea solo la primera vez.
DEV=/dev/sdf
for _ in $(seq 1 60); do [ -e "$DEV" ] && break; sleep 2; done
if ! blkid "$DEV"; then mkfs.xfs "$DEV"; fi
mkdir -p /data
UUID="$(blkid -s UUID -o value "$DEV")"
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /data xfs defaults,nofail 0 2" >>/etc/fstab
mount -a
# PostgreSQL (uid 70 en la imagen alpine) guarda aquí sus datos.
mkdir -p /data/postgres
chown 70:70 /data/postgres

# Carpeta de la aplicación y servicio que la arranca al encender el servidor.
mkdir -p /opt/albaydar
cat >/etc/systemd/system/albaydar.service <<SERVICIO
[Unit]
Description=Albaydar (API y PostgreSQL)
Requires=docker.service
After=docker.service network-online.target
ConditionPathExists=/opt/albaydar/docker-compose.prod.yml

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/albaydar
ExecStartPre=/opt/albaydar/cargar-secretos.sh ${ENTORNO} /opt/albaydar/.env
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down

[Install]
WantedBy=multi-user.target
SERVICIO
systemctl daemon-reload
systemctl enable albaydar.service

# Actualizaciones de seguridad automáticas.
dnf install -y dnf-automatic
sed -i 's/^upgrade_type.*/upgrade_type = security/; s/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer
