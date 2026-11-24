import { App } from 'aws-cdk-lib';
import { AlbaydarStack } from '../lib/albaydar-stack';

/**
 * Albaydar en AWS. Un stack por entorno, en Irlanda (eu-west-1), en la cuenta de la empresa.
 *
 *   cd infra
 *   npx cdk diff   Albaydar-beta -c avisos=<correo> --profile albaydar
 *   npx cdk deploy Albaydar-beta -c avisos=<correo> --profile albaydar
 *
 * El correo de los avisos (alarmas y presupuesto) se pasa al desplegar: no va en el repositorio.
 * Antes del primer despliegue: deploy/crear-secretos.sh beta (CloudFront lee de SSM el secreto
 * de la cabecera).
 */
const app = new App();
const cuenta = { account: '302263071236', region: 'eu-west-1' };
const correoAvisos = app.node.tryGetContext('avisos') as string | undefined;
if (!correoAvisos) throw new Error('Indica el correo de los avisos: -c avisos=<correo>');

new AlbaydarStack(app, 'Albaydar-beta', {
  env: cuenta,
  entorno: 'beta',
  ramaDespliegue: 'develop',
  correoAvisos,
  // Techo acordado con Luis Huapaya (23/11/2026): hasta 15 USD al mes.
  presupuestoUsd: 15,
  datosGb: 20,
  description: 'Albaydar beta: EC2 con Docker (API y PostgreSQL), CloudFront, S3 y copias',
});
