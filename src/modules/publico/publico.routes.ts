import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env';
import { badRequest } from '../../lib/errors';
import { v, validate } from '../../middleware/validate';
import { viasPublicas } from '../catalogo/catalogo.routes';
import * as citacion from '../citacion/citacion.service';
import * as documentosSrv from '../documentos/documentos.service';
import * as solicitudesSrv from '../solicitudes/solicitudes.service';
import { completarBody, solicitudPublicaBody, tokenParam } from '../solicitudes/solicitudes.schemas';

/**
 * Rutas sin login para la familia:
 *  - formulario "Albaydar Solicitud"
 *  - completar la solicitud desde el enlace
 *  - página "Albaydar Cita" (elegir fecha, otra franja, notas, .ics)
 */
export const publicoRouter = Router();

const mensajeLimite = { error: { code: 'DEMASIADAS_PETICIONES', message: 'Demasiadas peticiones. Inténtalo de nuevo en unos minutos.' } };
const limiteEnvio = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: mensajeLimite });
const limiteEnlace = rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: mensajeLimite });

// Los enlaces personales no deben quedar en cachés intermedias ni en el Referer.
publicoRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

publicoRouter.get('/vias', async (_req, res) => {
  res.json(await viasPublicas());
});

/** Formulario público de captación. */
publicoRouter.post('/solicitudes', limiteEnvio, validate({ body: solicitudPublicaBody }), async (req, res) => {
  const body = v<typeof solicitudPublicaBody>(req, 'body');
  res.status(201).json(await solicitudesSrv.crearDesdeWeb(body, req.ip));
});

publicoRouter.get('/solicitudes/completar/:token', limiteEnlace, validate({ params: tokenParam }), async (req, res) => {
  res.json(await solicitudesSrv.verCompletar(v<typeof tokenParam>(req, 'params').token));
});

publicoRouter.patch('/solicitudes/completar/:token', limiteEnvio, validate({ params: tokenParam, body: completarBody }), async (req, res) => {
  res.json(await solicitudesSrv.enviarCompletar(v<typeof tokenParam>(req, 'params').token, v<typeof completarBody>(req, 'body')));
});

// ── Cita ────────────────────────────────────────────────────────────────────

const elegirBody = z.object({ huecoId: z.string().uuid() });
const otraFranjaBody = z.object({
  franja: z.string().trim().max(500).optional().nullable(),
  prefiereLlamada: z.boolean().default(false),
});

publicoRouter.get('/citas/:token', limiteEnlace, validate({ params: tokenParam }), async (req, res) => {
  res.json(await citacion.verCita(v<typeof tokenParam>(req, 'params').token));
});

publicoRouter.post('/citas/:token/elegir', limiteEnlace, validate({ params: tokenParam, body: elegirBody }), async (req, res) => {
  res.json(await citacion.elegir(v<typeof tokenParam>(req, 'params').token, v<typeof elegirBody>(req, 'body').huecoId));
});

const cancelarCitaBody = z.object({ motivo: z.string().trim().max(500).optional().nullable() });

/** La familia cancela su cita confirmada (desde el recordatorio del día antes o su enlace). */
publicoRouter.post('/citas/:token/cancelar', limiteEnlace, validate({ params: tokenParam, body: cancelarCitaBody }), async (req, res) => {
  res.json(await citacion.cancelarPorFamilia(v<typeof tokenParam>(req, 'params').token, v<typeof cancelarCitaBody>(req, 'body').motivo ?? null));
});

publicoRouter.post('/citas/:token/otra-franja', limiteEnlace, validate({ params: tokenParam, body: otraFranjaBody }), async (req, res) => {
  const b = v<typeof otraFranjaBody>(req, 'body');
  res.json(await citacion.pedirOtraFranja(v<typeof tokenParam>(req, 'params').token, b.franja ?? null, b.prefiereLlamada));
});

/** "Añadir a mi calendario" → entrevista-albaydar.ics */
publicoRouter.get('/citas/:token/ics', limiteEnlace, validate({ params: tokenParam }), async (req, res) => {
  const ics = await citacion.icsDeToken(v<typeof tokenParam>(req, 'params').token);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="entrevista-albaydar.ics"');
  res.send(ics);
});

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
});
const unFichero = (req: Request, res: Response, next: NextFunction) =>
  subida.single('archivo')(req, res, (err: unknown) => {
    if ((err as { code?: string })?.code === 'LIMIT_FILE_SIZE') return next(badRequest('ARCHIVO_DEMASIADO_GRANDE', `El archivo supera ${env.UPLOAD_MAX_MB} MB.`));
    next(err);
  });

/** Boletín de notas: multipart/form-data con el campo "archivo". Reemplaza el anterior. */
publicoRouter.post('/citas/:token/notas', limiteEnvio, validate({ params: tokenParam }), unFichero, async (req, res) => {
  if (!req.file) throw badRequest('FALTA_ARCHIVO', 'Adjunta el boletín de notas.');
  const s = await citacion.solicitudDeToken(v<typeof tokenParam>(req, 'params').token);
  res.status(201).json(await documentosSrv.subirNotas(s, req.file));
});

publicoRouter.delete('/citas/:token/notas', limiteEnlace, validate({ params: tokenParam }), async (req, res) => {
  const s = await citacion.solicitudDeToken(v<typeof tokenParam>(req, 'params').token);
  await documentosSrv.quitarNotas(s);
  res.status(204).end();
});
