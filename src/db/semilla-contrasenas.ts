import { env } from '../config/env';

/** Contraseñas de ejemplo que están en el repositorio: nunca en un servidor. */
const CONTRASENAS_CONOCIDAS = ['CambiaEsto-2026!', 'Albaydar-2026'];

/**
 * Contraseña de un usuario que crea la semilla (Dirección inicial o los usuarios de demo).
 *  - En local: la variable o, si no está, la de ejemplo de siempre.
 *  - En un servidor (ENTORNO=beta|produccion): obligatoria, de al menos 12 caracteres y que no
 *    sea ninguna de las de ejemplo del repositorio. Si no, la semilla se detiene sin tocar la BD.
 */
export function contrasenaSemilla(variable: string, valor: string | undefined, porDefecto: string, entorno = env.ENTORNO): string {
  if (entorno === 'local') return valor || porDefecto;
  if (!valor) throw new Error(`${variable} es obligatoria en ENTORNO=${entorno} (no se usa la contraseña de ejemplo).`);
  if (valor.length < 12 || CONTRASENAS_CONOCIDAS.includes(valor)) {
    throw new Error(`${variable} tiene que tener al menos 12 caracteres y no ser una de las de ejemplo del repositorio.`);
  }
  return valor;
}
