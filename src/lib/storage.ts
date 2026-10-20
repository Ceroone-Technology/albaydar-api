import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { env } from '../config/env';

/**
 * Almacenamiento de ficheros. Implementación en disco local; la interfaz
 * permite cambiar a S3/Azure Blob sin tocar los servicios.
 */
export interface Almacen {
  guardar(clave: string, datos: Buffer): Promise<void>;
  leer(clave: string): Promise<Buffer>;
  borrar(clave: string): Promise<void>;
}

class AlmacenDisco implements Almacen {
  private raiz = resolve(env.UPLOADS_DIR);
  private ruta(clave: string) {
    const r = resolve(join(this.raiz, clave));
    if (!r.startsWith(this.raiz + sep)) throw new Error('Clave de almacenamiento no válida');
    return r;
  }
  async guardar(clave: string, datos: Buffer) {
    const r = this.ruta(clave);
    await mkdir(dirname(r), { recursive: true });
    await writeFile(r, datos, { flag: 'wx' });
  }
  leer(clave: string) {
    return readFile(this.ruta(clave));
  }
  async borrar(clave: string) {
    await unlink(this.ruta(clave)).catch(() => undefined);
  }
}

export const almacen: Almacen = new AlmacenDisco();

/** Detecta el tipo real por la firma del fichero (no nos fiamos de la extensión ni del mime declarado). */
export function tipoReal(b: Buffer): { mime: string; ext: string } | null {
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const marca = b.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(marca)) return { mime: 'image/heic', ext: 'heic' };
  }
  return null;
}
