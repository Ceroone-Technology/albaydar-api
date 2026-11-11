import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { badRequest } from '../lib/errors';

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
});

/** Un fichero en el campo "archivo" (multipart/form-data), como mucho UPLOAD_MAX_MB. */
export const unFichero = (req: Request, res: Response, next: NextFunction) =>
  subida.single('archivo')(req, res, (err: unknown) => {
    if ((err as { code?: string })?.code === 'LIMIT_FILE_SIZE') return next(badRequest('ARCHIVO_DEMASIADO_GRANDE', `El archivo supera ${env.UPLOAD_MAX_MB} MB.`));
    next(err);
  });
