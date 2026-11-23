import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { env } from '../config/env';

/**
 * Almacenamiento de ficheros (documentos de la solicitud, comprobantes de pago, archivos y PDF
 * de la matrícula). Dos implementaciones con el mismo comportamiento:
 *  - disco (UPLOADS_DIR): en local y en los tests.
 *  - S3 (S3_BUCKET): en AWS (22/11/2026), para que el servidor no guarde nada que no se pueda
 *    reconstruir. Se elige con STORAGE=disco|s3; los servicios no cambian.
 * En las dos, guardar no sobrescribe una clave que ya existe y borrar una que no existe no falla.
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

/** Las claves las generan los servicios; aun así, nada de rutas relativas ni absolutas. */
function claveValida(clave: string): string {
  if (!clave || clave.startsWith('/') || clave.split('/').some((parte) => parte === '..' || parte === '.' || parte === '')) {
    throw new Error('Clave de almacenamiento no válida');
  }
  return clave;
}

export class AlmacenS3 implements Almacen {
  constructor(
    private readonly cliente: Pick<S3Client, 'send'>,
    private readonly bucket: string,
    private readonly prefijo = '',
  ) {}

  private key(clave: string) {
    return `${this.prefijo}${claveValida(clave)}`;
  }

  async guardar(clave: string, datos: Buffer) {
    try {
      await this.cliente.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(clave),
          Body: datos,
          // Como el «wx» del disco: si la clave ya existe, falla en vez de sobrescribir.
          IfNoneMatch: '*',
          ServerSideEncryption: 'AES256',
        }),
      );
    } catch (e) {
      if (e instanceof S3ServiceException && (e.$metadata.httpStatusCode === 412 || e.name === 'PreconditionFailed')) {
        throw new Error(`Ya existe un fichero con la clave ${clave}`);
      }
      throw e;
    }
  }

  async leer(clave: string) {
    const r = await this.cliente.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(clave) }));
    if (!r.Body) throw new Error(`Fichero vacío: ${clave}`);
    return Buffer.from(await r.Body.transformToByteArray());
  }

  async borrar(clave: string) {
    // DeleteObject no falla si la clave no existe; otros errores, tampoco se propagan (como en disco).
    await this.cliente.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(clave) })).catch(() => undefined);
  }
}

function crearAlmacen(): Almacen {
  if (env.STORAGE !== 's3') return new AlmacenDisco();
  const cliente = new S3Client({
    region: env.AWS_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
  });
  return new AlmacenS3(cliente, env.S3_BUCKET!, env.S3_PREFIX);
}

export const almacen: Almacen = crearAlmacen();

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
