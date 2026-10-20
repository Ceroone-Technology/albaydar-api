import type { Rol } from '../db/schema';

declare global {
  namespace Express {
    interface Request {
      /** Usuario autenticado (lo pone `requireAuth`). */
      user?: { id: string; email: string; nombre: string; roles: Rol[] };
      /** Datos validados por `validate()`. */
      valid?: Record<string, unknown>;
    }
  }
}

export {};
