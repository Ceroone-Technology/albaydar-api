/**
 * Error de negocio con código estable para el front.
 * El front muestra `message` (en español) y puede ramificar por `code`.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Necesitas iniciar sesión.', code = 'NO_AUTENTICADO') => new AppError(401, code, msg);
export const forbidden = (msg = 'No tienes permiso para esta acción.') => new AppError(403, 'SIN_PERMISO', msg);
export const notFound = (msg = 'No encontrado.', code = 'NO_ENCONTRADO') => new AppError(404, code, msg);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const gone = (code: string, msg: string) => new AppError(410, code, msg);
