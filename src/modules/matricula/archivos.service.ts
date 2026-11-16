import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { archivosMatricula, matriculaEventos, type ArchivoMatricula, type Matricula } from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import type { Tx } from '../../lib/db';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { almacen, tipoReal } from '../../lib/storage';
import type { ArchivoSubido, ChecklistDocId, Expediente } from './borrador';
import type { Firmante } from './firmas.service';
import { checklist } from './reglas';

/**
 * Archivos que aporta la familia (docs/matricula.md, punto 7): la foto de carné y las copias del
 * checklist (DNI, tarjeta sanitaria, Libro de Familia, certificación académica).
 *
 *  - Uno vigente por destino. Subir otro lo sustituye; el anterior se marca eliminado y su fichero
 *    se borra del almacén cuando la transacción termina bien.
 *  - Se comprueba el tipo real del fichero (PDF, JPG, PNG o HEIC; la foto, solo imagen).
 *  - Plazos de conservación pendientes del centro (pregunta 25): se guarda la categoría y nada se
 *    borra solo.
 */

export const DESTINOS = ['photo', 'm4', 'c2', 'b1', 'b2'] as const;
export type Destino = (typeof DESTINOS)[number];
export const destinoParam = z.enum(DESTINOS);

export const NOMBRE_DESTINO: Record<Destino, string> = {
  photo: 'Foto de carné',
  m4: 'Fotocopia del DNI de la alumna',
  c2: 'Fotocopia de la tarjeta de la Seguridad Social',
  b1: 'Hoja de la alumna del Libro de Familia',
  b2: 'Certificación académica oficial',
};

const MIME_FOTO = ['image/jpeg', 'image/png', 'image/heic'];
const MIME_DOCUMENTO = ['application/pdf', ...MIME_FOTO];

export async function cargarArchivos(tx: Tx, matriculaIds: string[]) {
  if (!matriculaIds.length) return [];
  return tx
    .select()
    .from(archivosMatricula)
    .where(and(inArray(archivosMatricula.matriculaId, matriculaIds), isNull(archivosMatricula.eliminadoEn)));
}

/** Lo que ven las reglas y el front: `photo` y `documents` del borrador. */
export function aBorrador(archivos: ArchivoMatricula[]): Pick<Expediente, 'photo' | 'documents'> {
  const vista = (a: ArchivoMatricula): ArchivoSubido => ({ name: a.nombreOriginal, size: a.tamano, uploadedAt: a.createdAt.toISOString() });
  const foto = archivos.find((a) => a.destino === 'photo');
  return {
    photo: foto ? vista(foto) : null,
    documents: Object.fromEntries(archivos.filter((a) => a.destino !== 'photo').map((a) => [a.destino, vista(a)])) as Expediente['documents'],
  };
}

/** ¿Pide esta matrícula ese archivo? La foto cuenta para «fotos tamaño carné» (m5). */
function aplica(base: Expediente, destino: Destino) {
  const items = checklist(base);
  return destino === 'photo' ? items.some((i) => i.id === 'm5') : items.some((i) => i.id === (destino as ChecklistDocId) && i.origin === 'family');
}

function comprobar(m: Matricula, quien: Firmante) {
  if (m.estado !== 'BORRADOR') throw conflict('MATRICULA_ENVIADA', 'La matrícula ya está enviada: no se pueden cambiar sus archivos.');
  if (quien.enlace?.alcance === 'PROGENITOR') throw new AppError(403, 'ENLACE_SIN_PERMISO', 'Con este enlace solo se pueden leer y firmar los documentos de protección de datos.');
}

const actor = (q: Firmante) => (q.enlace ? { actor: 'familia', enlaceId: q.enlace.id, usuarioId: null } : { actor: 'usuario', enlaceId: null, usuarioId: q.usuarioId });

/**
 * Sube (o sustituye) el archivo de un destino. Devuelve las claves de almacén que hay que borrar
 * cuando la transacción se confirme (`borrarDelAlmacen`).
 */
export async function subir(tx: Tx, m: Matricula, base: Expediente, destino: Destino, f: Express.Multer.File, quien: Firmante): Promise<string[]> {
  comprobar(m, quien);
  if (!aplica(base, destino)) throw conflict('DOCUMENTO_NO_APLICA', `«${NOMBRE_DESTINO[destino]}» no hace falta en esta matrícula.`);
  const tipo = tipoReal(f.buffer);
  const admitidos = destino === 'photo' ? MIME_FOTO : MIME_DOCUMENTO;
  if (!tipo || !admitidos.includes(tipo.mime)) {
    throw badRequest('TIPO_NO_PERMITIDO', destino === 'photo' ? 'La foto tiene que ser una imagen JPG, PNG o HEIC.' : 'Sube un PDF o una imagen (JPG, PNG o HEIC).');
  }

  const clave = `matriculas/${m.id}/${destino}-${randomUUID()}.${tipo.ext}`;
  await almacen.guardar(clave, f.buffer);
  const previos = await tx
    .update(archivosMatricula)
    .set({ eliminadoEn: new Date() })
    .where(and(eq(archivosMatricula.matriculaId, m.id), eq(archivosMatricula.destino, destino), isNull(archivosMatricula.eliminadoEn)))
    .returning({ clave: archivosMatricula.clave });
  await tx.insert(archivosMatricula).values({
    matriculaId: m.id,
    destino,
    tipoConservacion: destino === 'photo' ? 'FOTO' : 'COPIA_DOCUMENTO',
    nombreOriginal: f.originalname.slice(0, 200),
    mime: tipo.mime,
    tamano: f.size,
    clave,
    sha256: sha256(f.buffer),
    enlaceId: quien.enlace?.id ?? null,
    usuarioId: quien.usuarioId ?? null,
  });
  await tx.insert(matriculaEventos).values({
    matriculaId: m.id,
    tipo: 'ARCHIVO',
    texto: `${previos.length ? 'Sustituye' : 'Sube'}: ${NOMBRE_DESTINO[destino]}`,
    detalle: { destino },
    ...actor(quien),
  });
  return previos.map((p) => p.clave);
}

export async function quitar(tx: Tx, m: Matricula, destino: Destino, quien: Firmante): Promise<string[]> {
  comprobar(m, quien);
  const previos = await tx
    .update(archivosMatricula)
    .set({ eliminadoEn: new Date() })
    .where(and(eq(archivosMatricula.matriculaId, m.id), eq(archivosMatricula.destino, destino), isNull(archivosMatricula.eliminadoEn)))
    .returning({ clave: archivosMatricula.clave });
  if (!previos.length) throw notFound('No hay ningún archivo subido ahí.', 'ARCHIVO_NO_ENCONTRADO');
  await tx.insert(matriculaEventos).values({ matriculaId: m.id, tipo: 'ARCHIVO_QUITADO', texto: `Quita: ${NOMBRE_DESTINO[destino]}`, detalle: { destino }, ...actor(quien) });
  return previos.map((p) => p.clave);
}

/** Tras confirmar la transacción: los ficheros sustituidos o quitados salen del almacén. */
export async function borrarDelAlmacen(claves: string[]) {
  for (const c of claves) {
    await almacen.borrar(c).catch((e: unknown) => logger.warn({ err: e, clave: c }, 'No se pudo borrar un archivo de matrícula del almacén'));
  }
}

export async function descargar(tx: Tx, matriculaId: string, destino: Destino) {
  const [a] = await tx
    .select()
    .from(archivosMatricula)
    .where(and(eq(archivosMatricula.matriculaId, matriculaId), eq(archivosMatricula.destino, destino), isNull(archivosMatricula.eliminadoEn)));
  if (!a) throw notFound('No hay ningún archivo subido ahí.', 'ARCHIVO_NO_ENCONTRADO');
  return { datos: await almacen.leer(a.clave), mime: a.mime, nombre: a.nombreOriginal };
}
