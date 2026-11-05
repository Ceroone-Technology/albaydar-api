import type { Request, Response } from 'express';
import { aCsv, enviarCsv, type Columna } from '../../lib/csv';
import { logger } from '../../lib/logger';

/**
 * Responde con el CSV y deja constancia en el log de quién exportó qué y cuántas filas
 * (son datos personales de menores). No se registran los valores de los filtros: la
 * búsqueda puede llevar nombres.
 */
export function responderCsv<T>(req: Request, res: Response, nombre: string, columnas: Columna<T>[], filas: T[]) {
  logger.info({ usuarioId: req.user?.id, exportacion: nombre, filas: filas.length, filtros: Object.keys(req.query) }, 'Exportación CSV');
  enviarCsv(res, nombre, aCsv(columnas, filas));
}
