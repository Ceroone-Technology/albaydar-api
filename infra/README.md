# Infraestructura de Albaydar en AWS (CDK)

Etiquetas de coste de la empresa, activas en Facturación: **`CLIENT=Albaydar`** y **`PROJECT_NAME=albaydar-gestion-academica`**, más `Environment`. El presupuesto filtra por `PROJECT_NAME`.

Un stack por entorno: `Albaydar-beta` y, más adelante, `Albaydar-produccion`. Va en Irlanda (eu-west-1), en la cuenta de la empresa, con el patrón EC2 de Subvfy. El código está en `lib/albaydar-stack.ts` y el primer arranque del servidor, en `lib/user-data.sh`.

## Qué crea (44 recursos)

| Pieza | Detalle |
|---|---|
| Red | VPC con una subred pública, sin NAT |
| Servidor | EC2 **t4g.micro** (1 GB, ARM) con Amazon Linux 2023. Disco raíz de 8 GB cifrado, IMDSv2 y **IP elástica** |
| Datos | Volumen EBS de **20 GB** cifrado, montado en `/data`, **que no se borra con la instancia**. Snapshot diario a las 02:00 (DLM), se guardan 7 |
| Firewall | Solo el puerto 80 y solo desde CloudFront (`pl-4fa04526`). Sin SSH: se entra por Session Manager |
| CloudFront | `/` → front en S3 (OAC, las rutas de la SPA van a `index.html`, cabeceras de seguridad). `/api/*` → servidor por HTTP, con la cabecera `X-Origin-Verify` y sin caché. `PriceClass_100` |
| S3 | `front`; `uploads`, con versiones durante 30 días; `backups`, que caducan a los 30 días; `releases`, que también caducan a los 30 días. Todos privados, cifrados y solo por HTTPS |
| Roles | **Servidor:** S3, SSM `/albaydar/<entorno>/` y Session Manager. **Despliegue de GitHub por OIDC:** solo la rama `develop` de los dos repos; puede subir el front, crear la release, invalidar CloudFront y mandar la orden de despliegue al servidor |
| Avisos | Recuperación automática si falla el hardware, más alarmas de instancia, CPU y créditos de CPU, por correo (SNS). Presupuesto mensual de 15 USD |

El primer arranque instala Docker y Compose, crea 2 GB de swap, monta `/data`, configura el servicio `albaydar` (`cargar-secretos.sh` + `docker compose up`) y activa las actualizaciones de seguridad automáticas.

## Antes del primer despliegue

1. `deploy/crear-secretos.sh beta`: el stack lee de SSM `CLOUDFRONT_ORIGIN_SECRET`.
2. Confirmar la suscripción a los avisos en el correo que llega de SNS, tras desplegar.

## Comandos

```bash
cd infra
npm install
AWS_PROFILE=albaydar npx cdk synth  Albaydar-beta -c avisos=<correo>
AWS_PROFILE=albaydar npx cdk diff   Albaydar-beta -c avisos=<correo>
AWS_PROFILE=albaydar npx cdk deploy Albaydar-beta -c avisos=<correo>
```

`cdk.context.json` guarda las consultas a la cuenta (zonas y lista de IP de CloudFront) y se versiona.
