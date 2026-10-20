import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

/** Forma única de error para el front: { error: { code, message, details? } } */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'DATOS_INVALIDOS',
        message: 'Revisa los datos enviados.',
        details: err.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
      },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Violaciones de unicidad que se escapen de las comprobaciones previas (carreras).
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === '23505') {
    return res.status(409).json({ error: { code: 'CONFLICTO', message: 'El recurso ya existe o acaba de cambiar.', details: pg.constraint } });
  }
  const tipo = (err as { type?: string })?.type;
  if (tipo === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'JSON_INVALIDO', message: 'El cuerpo de la petición no es JSON válido.' } });
  }
  if (tipo === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'DEMASIADO_GRANDE', message: 'La petición es demasiado grande.' } });
  }

  logger.error({ err, url: req.originalUrl }, 'Error no controlado');
  return res.status(500).json({ error: { code: 'ERROR_INTERNO', message: 'Ha ocurrido un error inesperado.' } });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'RUTA_NO_ENCONTRADA', message: 'Ruta no encontrada.' } });
}
