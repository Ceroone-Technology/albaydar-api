/**
 * Importes e IBAN. Los importes viajan y se guardan en céntimos (enteros):
 * 30000 = 300,00 €. Nunca con decimales.
 */

const EUROS = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, useGrouping: 'always' });

/** 30000 → "300,00 €" */
export const euros = (centimos: number) => EUROS.format(centimos / 100);

/** "es91 2100-0418…" → "ES9121000418…" */
export const normalizarIban = (iban: string) => iban.replace(/[\s-]/g, '').toUpperCase();

/** Dígitos de control ISO 13616 (módulo 97). */
export function ibanValido(iban: string): boolean {
  const i = normalizarIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(i)) return false;
  if (i.startsWith('ES') && i.length !== 24) return false;
  const reordenado = i.slice(4) + i.slice(0, 4);
  let resto = 0;
  for (const c of reordenado) {
    const n = c >= 'A' ? String(c.charCodeAt(0) - 55) : c;
    for (const d of n) resto = (resto * 10 + Number(d)) % 97;
  }
  return resto === 1;
}

/** "ES9121000418…" → "ES91 2100 0418 4502 0005 1332" */
export const formatearIban = (iban: string) => normalizarIban(iban).replace(/(.{4})(?=.)/g, '$1 ');

/** Longitud del IBAN de cada país de la zona SEPA (lista del EPC). */
const LONGITUD_IBAN_SEPA: Record<string, number> = {
  AD: 24, AL: 28, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27,
  GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24,
  ME: 22, MK: 19, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

/** IBAN de un país SEPA, con su longitud y sus dígitos de control: se puede domiciliar. */
export function ibanSepaValido(iban: string): boolean {
  const i = normalizarIban(iban);
  return LONGITUD_IBAN_SEPA[i.slice(0, 2)] === i.length && ibanValido(i);
}

/** "ES9121000418450200051332" → "ES91 **** **** **** **** 1332" (listados, historial y correos). */
export function enmascararIban(iban: string): string {
  const i = normalizarIban(iban);
  if (i.length < 8) return '****';
  const medio = i.slice(4, -4).replace(/./g, '*');
  return `${i.slice(0, 4)}${medio}${i.slice(-4)}`.replace(/(.{4})(?=.)/g, '$1 ');
}

/** BIC/SWIFT: 8 u 11 caracteres. */
export const bicValido = (bic: string) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic.replace(/\s/g, '').toUpperCase());

const mod97 = (s: string) => {
  let resto = 0;
  for (const c of s) {
    const n = c >= 'A' ? String(c.charCodeAt(0) - 55) : c;
    for (const d of n) resto = (resto * 10 + Number(d)) % 97;
  }
  return resto;
};

/**
 * Identificador de acreedor SEPA (norma AT-02): país, 2 dígitos de control, sufijo de 3 caracteres
 * y el NIF. Los dígitos de control se calculan sobre el NIF y el país, sin el sufijo.
 * "ES09000G41829037" → válido.
 */
export function identificadorAcreedorValido(id: string): boolean {
  const i = id.replace(/\s/g, '').toUpperCase();
  const m = /^([A-Z]{2})(\d{2})([A-Z0-9]{3})([A-Z0-9]{1,28})$/.exec(i);
  if (!m) return false;
  const [, pais, control, , nacional] = m;
  return 98 - mod97(`${nacional}${pais}00`) === Number(control);
}
