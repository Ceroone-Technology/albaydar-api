import { Router } from 'express';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import * as srv from './indicadores.service';

/** Indicadores (reunión del 18/11/2026): permiso «indicadores.ver» (de serie, Dirección y Administración). */
export const indicadoresRouter = Router();

/** GET /indicadores?cursoEscolar=2027-2028 (sin él, el del formulario público). */
indicadoresRouter.get('/', requirePermiso('indicadores.ver'), validate({ query: srv.indicadoresQuery }), async (req, res) => {
  res.json(await srv.indicadores(v<typeof srv.indicadoresQuery>(req, 'query')));
});
