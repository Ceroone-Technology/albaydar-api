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
