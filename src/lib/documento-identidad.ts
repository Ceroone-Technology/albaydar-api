/**
 * DNI y NIE españoles. Se guardan normalizados (sin espacios ni guiones, en mayúsculas:
 * "12345678Z", "X1234567L") y se validan con su letra de control.
 * Los usará también la orden SEPA (DNI/NIE del titular de la cuenta).
 */

const LETRAS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** "y-4821533-k" → "Y4821533K". */
export const normalizarDocumento = (d: string) => d.replace(/[\s.-]/g, '').toUpperCase();

/** DNI (8 cifras + letra) o NIE (X/Y/Z + 7 cifras + letra) con la letra correcta. Recibe el texto ya normalizado. */
export function documentoValido(d: string): boolean {
  const m = /^([XYZ]|\d)(\d{7})([A-Z])$/.exec(d);
  if (!m) return false;
  const inicial = m[1]!;
  const numero = Number(`${'XYZ'.includes(inicial) ? 'XYZ'.indexOf(inicial) : inicial}${m[2]}`);
  return LETRAS[numero % 23] === m[3];
}
