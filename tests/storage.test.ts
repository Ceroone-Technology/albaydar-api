import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { AlmacenS3 } from '../src/lib/storage';

/** S3 en memoria con el comportamiento que usamos: If-None-Match en Put y Delete idempotente. */
function s3Falso() {
  const objetos = new Map<string, Buffer>();
  const enviados: { tipo: string; input: Record<string, unknown> }[] = [];
  const send = async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) {
      enviados.push({ tipo: 'put', input: cmd.input as unknown as Record<string, unknown> });
      const key = cmd.input.Key!;
      if (cmd.input.IfNoneMatch === '*' && objetos.has(key)) {
        throw new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: { httpStatusCode: 412 }, message: 'At least one of the pre-conditions you specified did not hold' });
      }
      objetos.set(key, Buffer.from(cmd.input.Body as Buffer));
      return {};
    }
    if (cmd instanceof GetObjectCommand) {
      const datos = objetos.get(cmd.input.Key!);
      if (!datos) throw new S3ServiceException({ name: 'NoSuchKey', $fault: 'client', $metadata: { httpStatusCode: 404 }, message: 'The specified key does not exist.' });
      return { Body: { transformToByteArray: async () => new Uint8Array(datos) } };
    }
    if (cmd instanceof DeleteObjectCommand) {
      enviados.push({ tipo: 'delete', input: cmd.input as unknown as Record<string, unknown> });
      objetos.delete(cmd.input.Key!);
      return {};
    }
    throw new Error('Comando no esperado');
  };
  return { cliente: { send } as never, objetos, enviados };
}

describe('Almacén S3 (despliegue en AWS, 22/11/2026)', () => {
  it('guarda cifrado y con prefijo, lee, no sobrescribe y borra sin fallar', async () => {
    const s3 = s3Falso();
    const almacen = new AlmacenS3(s3.cliente, 'albaydar-dev-uploads', 'uploads/');
    const pdf = Buffer.from('%PDF-1.4 prueba');

    await almacen.guardar('solicitudes/abc/boletin.pdf', pdf);
    expect(s3.enviados[0]).toMatchObject({
      tipo: 'put',
      input: { Bucket: 'albaydar-dev-uploads', Key: 'uploads/solicitudes/abc/boletin.pdf', IfNoneMatch: '*', ServerSideEncryption: 'AES256' },
    });
    expect((await almacen.leer('solicitudes/abc/boletin.pdf')).equals(pdf)).toBe(true);

    // Como en disco: la misma clave no se sobrescribe.
    await expect(almacen.guardar('solicitudes/abc/boletin.pdf', Buffer.from('otro'))).rejects.toThrow('Ya existe un fichero');
    expect((await almacen.leer('solicitudes/abc/boletin.pdf')).equals(pdf)).toBe(true);

    await almacen.borrar('solicitudes/abc/boletin.pdf');
    await almacen.borrar('solicitudes/abc/no-existe.pdf');
    expect(s3.objetos.size).toBe(0);
    await expect(almacen.leer('solicitudes/abc/boletin.pdf')).rejects.toThrow();
  });

  it('rechaza claves con rutas relativas o absolutas', async () => {
    const almacen = new AlmacenS3(s3Falso().cliente, 'b');
    for (const mala of ['../fuera.pdf', '/absoluta.pdf', 'a/../b.pdf', 'a//b.pdf', '']) {
      await expect(almacen.guardar(mala, Buffer.from('x'))).rejects.toThrow('Clave de almacenamiento no válida');
    }
  });
});
