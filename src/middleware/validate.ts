import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';

type Partes = { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType };

/**
 * Valida y normaliza body/query/params con Zod.
 * El resultado ya tipado queda en `req.valid`.
 */
export const validate =
  (p: Partes) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const valid: Record<string, unknown> = {};
    for (const k of ['params', 'query', 'body'] as const) {
      const sch = p[k];
      if (sch) valid[k] = sch.parse(req[k] ?? {});
    }
    req.valid = valid;
    next();
  };

/** Acceso tipado a lo validado: `const body = v<typeof esquema>(req, 'body')`. */
export const v = <S extends z.ZodType>(req: Request, k: 'body' | 'query' | 'params'): z.infer<S> =>
  (req.valid as Record<string, unknown>)[k] as z.infer<S>;
