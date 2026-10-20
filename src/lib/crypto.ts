import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token aleatorio de 256 bits, apto para URL. */
export const nuevoToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Los tokens solo se guardan como hash: una fuga de la BD no da acceso. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

export const igualSeguro = (a: string, b: string) => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};
