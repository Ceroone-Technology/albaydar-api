import { Router } from 'express';
import { z } from 'zod';
import { todasLasPaginas } from '../../lib/csv';
import { requirePermiso } from '../../middleware/auth';
import { v, validate } from '../../middleware/validate';
import { COLUMNAS_ALUMNADO } from '../exportaciones/columnas';
import { responderCsv } from '../exportaciones/exportar';
import * as srv from './alumnado.service';

const idParam = z.object({ id: z.string().uuid() });

export const alumnadoRouter = Router();

/** Listado: GET /alumnado?q=&familia=&curso=&cursoEscolar=&estado=&promociona=&page=&pageSize= */
alumnadoRouter.get('/', requirePermiso('alumnado.ver'), validate({ query: srv.listarAlumnasQuery }), async (req, res) => {
  res.json(await srv.listar(v<typeof srv.listarAlumnasQuery>(req, 'query')));
});

/** CSV con los mismos filtros (antes de /:id). */
alumnadoRouter.get('/exportar', requirePermiso('alumnado.ver'), validate({ query: srv.listarAlumnasQuery }), async (req, res) => {
  const filas = await todasLasPaginas(srv.listar, v<typeof srv.listarAlumnasQuery>(req, 'query'));
  responderCsv(req, res, 'alumnado', COLUMNAS_ALUMNADO, filas);
});

/** Ficha: datos, contactos e historial. */
alumnadoRouter.get('/:id', requirePermiso('alumnado.ver'), validate({ params: idParam }), async (req, res) => {
  res.json(await srv.detalle(v<typeof idParam>(req, 'params').id));
});

/** Alta manual. */
alumnadoRouter.post('/', requirePermiso('alumnado.editar'), validate({ body: srv.crearAlumnaBody }), async (req, res) => {
  res.status(201).json(await srv.crear(v<typeof srv.crearAlumnaBody>(req, 'body'), req.user!.id));
});

/** Editar datos, contactos o estado (en una baja, la reactiva). */
alumnadoRouter.patch('/:id', requirePermiso('alumnado.editar'), validate({ params: idParam, body: srv.editarAlumnaBody }), async (req, res) => {
  res.json(await srv.editar(v<typeof idParam>(req, 'params').id, v<typeof srv.editarAlumnaBody>(req, 'body'), req.user!.id));
});

alumnadoRouter.post('/:id/baja', requirePermiso('alumnado.editar'), validate({ params: idParam, body: srv.bajaBody }), async (req, res) => {
  res.json(await srv.darDeBaja(v<typeof idParam>(req, 'params').id, v<typeof srv.bajaBody>(req, 'body'), req.user!.id));
});

/** Nota interna en el historial. */
alumnadoRouter.post('/:id/notas', requirePermiso('alumnado.editar'), validate({ params: idParam, body: srv.notaBody }), async (req, res) => {
  res.status(201).json(await srv.anadirNota(v<typeof idParam>(req, 'params').id, v<typeof srv.notaBody>(req, 'body').texto, req.user!.id));
});
