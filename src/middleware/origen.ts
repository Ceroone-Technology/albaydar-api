import type { RequestHandler } from 'express';
import { igualSeguro } from '../lib/crypto';

/** Cabecera que CloudFront añade al reenviar las peticiones al servidor (origin custom header). */
export const CABECERA_ORIGEN = 'x-origin-verify';

/**
 * Solo atiende lo que llega por nuestra distribución de CloudFront (despliegue en AWS,
 * 23/11/2026). El grupo de seguridad de la EC2 admite la lista de IP de CloudFront, que es la
 * de cualquier distribución; el secreto distingue la nuestra. /health queda fuera: lo usa el
 * healthcheck del contenedor desde dentro del propio servidor.
 */
export function soloDesdeCloudFront(secreto: string): RequestHandler {
  return (req, res, next) => {
    if (req.path === '/health') return next();
    const valor = req.get(CABECERA_ORIGEN);
    if (valor && igualSeguro(valor, secreto)) return next();
    res.status(403).json({ error: { code: 'ORIGEN_NO_PERMITIDO', message: 'Acceso no permitido.' } });
  };
}
