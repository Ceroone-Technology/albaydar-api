import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { hashToken } from '../../lib/crypto';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { tokenParam } from '../solicitudes/solicitudes.schemas';
import * as srv from './matricula.service';

const idParam = z.object({ id: z.string().uuid() });
const enlaceParam = z.object({ id: z.string().uuid(), enlaceId: z.string().uuid() });

// ── Secretaría ───────────────────────────────────────────────────────────────

export const matriculasRouter = Router();

/** Listado: GET /matriculas?q=&estado=&cursoEscolar=&familia=&curso=&page=&pageSize= */
matriculasRouter.get('/', requirePermiso('matricula.ver'), validate({ query: srv.listarMatriculasQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof srv.listarMatriculasQuery>(req, 'query')));
});

/** Abre la matrícula de una alumna y crea (y envía) el enlace de la familia. */
matriculasRouter.post('/', requirePermiso('matricula.editar'), validate({ body: srv.crearMatriculaBody }), async (req, res) => {
  res.status(201).json(await srv.crear(v<typeof srv.crearMatriculaBody>(req, 'body'), req.user!.id));
});

/** Renovación en bloque 1º → 2º de las alumnas que promocionan (antes de /:id). */
matriculasRouter.post('/renovacion', requirePermiso('matricula.editar'), validate({ body: srv.renovacionBody }), async (req, res) => {
  res.json(await srv.renovacion(v<typeof srv.renovacionBody>(req, 'body'), req.user!.id));
});

matriculasRouter.get('/:id', requirePermiso('matricula.ver'), validate({ params: idParam }), async (req, res) => {
  res.json(await srv.detalle(v<typeof idParam>(req, 'params').id));
});

/** Guarda el borrador: { borrador, version }. 409 VERSION_ANTIGUA si otro guardó antes. */
matriculasRouter.put('/:id', requirePermiso('matricula.editar'), validate({ params: idParam, body: srv.guardarBody }), async (req, res) => {
  res.json(await srv.guardarInterno(v<typeof idParam>(req, 'params').id, v<typeof srv.guardarBody>(req, 'body'), req.user!.id));
});

/** Páginas leídas en el Modo firma (secretaría con la familia delante). No sube la versión. */
matriculasRouter.post('/:id/paginas-leidas', requirePermiso('matricula.editar'), validate({ params: idParam, body: srv.paginasBody }), async (req, res) => {
  res.json(await srv.paginasInterno(v<typeof idParam>(req, 'params').id, v<typeof srv.paginasBody>(req, 'body').paginas));
});

/** Enlace nuevo para la familia o para un progenitor (sustituye al anterior del mismo tipo). */
matriculasRouter.post('/:id/enlaces', requirePermiso('matricula.editar'), validate({ params: idParam, body: srv.enlaceBody }), async (req, res) => {
  res.status(201).json(await srv.crearEnlace(v<typeof idParam>(req, 'params').id, v<typeof srv.enlaceBody>(req, 'body'), req.user!.id));
});

matriculasRouter.delete('/:id/enlaces/:enlaceId', requirePermiso('matricula.editar'), validate({ params: enlaceParam }), async (req, res) => {
  const p = v<typeof enlaceParam>(req, 'params');
  res.json(await srv.revocarEnlace(p.id, p.enlaceId, req.user!.id));
});

// ── Familia: /public/matricula/:token ───────────────────────────────────────

const mensajeLimite = { error: { code: 'DEMASIADAS_PETICIONES', message: 'Demasiadas peticiones. Espera unos minutos y vuelve a intentarlo.' } };

/**
 * Límites por enlace, no por IP: un colegio o una casa comparten IP (docs/matricula.md, punto 6).
 * Los tokens que no existen cuentan aparte, por IP: así no se pueden probar a ciegas.
 */
const porEnlace = (windowMs: number, limit: number) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: mensajeLimite,
    keyGenerator: (req: Request) => `matricula:${hashToken(String(req.params.token))}`,
  });

const tokensFallidos = rateLimit({
  windowMs: 15 * 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: mensajeLimite,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 404 && res.statusCode !== 410,
});

const limiteLectura = porEnlace(15 * 60_000, 600);
const limiteGuardado = porEnlace(15 * 60_000, 900);

export const matriculaPublicaRouter = Router();

matriculaPublicaRouter.get('/:token', tokensFallidos, limiteLectura, validate({ params: tokenParam }), async (req, res) => {
  res.json(await srv.verPublica(v<typeof tokenParam>(req, 'params').token));
});

matriculaPublicaRouter.put('/:token', tokensFallidos, limiteGuardado, validate({ params: tokenParam, body: srv.guardarBody }), async (req, res) => {
  res.json(await srv.guardarPublica(v<typeof tokenParam>(req, 'params').token, v<typeof srv.guardarBody>(req, 'body')));
});

matriculaPublicaRouter.post('/:token/paginas-leidas', tokensFallidos, limiteGuardado, validate({ params: tokenParam, body: srv.paginasBody }), async (req, res) => {
  res.json(await srv.paginasPublica(v<typeof tokenParam>(req, 'params').token, v<typeof srv.paginasBody>(req, 'body').paginas));
});
