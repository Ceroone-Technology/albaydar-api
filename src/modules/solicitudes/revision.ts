/**
 * Las cinco comprobaciones de la revisión de una solicitud (bandeja de admisión):
 *  1. Datos completos         2. Correo válido         3. Plazas libres por vía
 *  4. Familia ya vinculada    5. Cupo SNEC
 *
 * Función pura: recibe los datos ya consultados y devuelve el resultado.
 * Los textos reproducen los del mockup.
 */

export type ResultadoCheck = 'ok' | 'aviso' | 'error';

export interface Check {
  id: 'datos' | 'correo' | 'plazas' | 'familia' | 'snec';
  resultado: ResultadoCheck;
  texto: string;
}

export interface ResultadoRevision {
  checks: Check[];
  completa: boolean;
  /** Campos obligatorios que faltan (para precargar "Pedir que complete"). */
  faltan: string[];
  /** Citar a entrevista solo se permite con la solicitud completa. */
  puedeCitar: boolean;
  calculadaEn: string;
}

export interface EntradaRevision {
  alumnaNombre: string | null;
  alumnaApellidos: string | null;
  tutorNombre: string | null;
  email: string | null;
  telefono: string | null;
  centroProcedencia: string | null;
  asignadaSnec: boolean;
  via: { nombre: string; plazas: number; plazasAsignadasPorJunta: boolean; ocupadas: number };
  /** Familia conocida por el centro (tabla familias) y su vínculo. */
  familia: { vinculo: string | null } | null;
  /** Otras solicitudes con el mismo correo o teléfono. */
  otrasSolicitudes: { codigo: string; alumna: string }[];
}

/** Etiquetas de los campos obligatorios, en el orden en que se muestran. */
export const CAMPOS_OBLIGATORIOS = {
  alumnaNombre: 'Nombre de la alumna',
  alumnaApellidos: 'Apellidos de la alumna',
  tutorNombre: 'Nombre de la madre, padre o tutor',
  email: 'Correo de contacto',
  telefono: 'Teléfono de contacto',
  centroProcedencia: 'Centro de procedencia',
} as const;

// Validación práctica: algo@dominio.tld, sin espacios. (La validación estricta la hace Zod al entrar.)
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const correoValido = (e: string | null | undefined) => !!e && RE_EMAIL.test(e.trim());

export function revisar(x: EntradaRevision, ahora = new Date()): ResultadoRevision {
  const faltan: string[] = (Object.keys(CAMPOS_OBLIGATORIOS) as (keyof typeof CAMPOS_OBLIGATORIOS)[])
    .filter((k) => !String(x[k] ?? '').trim())
    .map((k) => CAMPOS_OBLIGATORIOS[k]);

  const mailOk = correoValido(x.email);
  if (x.email && !mailOk) faltan.push('Correo de contacto válido');
  const completa = faltan.length === 0 && mailOk;

  const checks: Check[] = [];

  checks.push(
    completa
      ? { id: 'datos', resultado: 'ok', texto: 'Datos básicos completos' }
      : { id: 'datos', resultado: 'error', texto: 'Faltan datos obligatorios de la familia o del centro de procedencia' },
  );

  checks.push(
    mailOk
      ? { id: 'correo', resultado: 'ok', texto: 'Correo de contacto válido · por él se enviará la propuesta de fechas' }
      : { id: 'correo', resultado: 'error', texto: 'El correo de contacto parece incompleto' },
  );

  if (x.via.plazasAsignadasPorJunta) {
    checks.push({ id: 'plazas', resultado: 'ok', texto: `${x.via.nombre}: cupo asignado por la Junta` });
  } else {
    const libres = Math.max(0, x.via.plazas - x.via.ocupadas);
    checks.push(
      libres > 0
        ? { id: 'plazas', resultado: 'ok', texto: `${x.via.nombre}: ${libres} ${libres === 1 ? 'plaza libre' : 'plazas libres'}` }
        : { id: 'plazas', resultado: 'aviso', texto: `${x.via.nombre}: sin plazas libres · la solicitud iría a lista de espera` },
    );
  }

  const vinculos = [
    ...(x.familia ? [x.familia.vinculo ?? 'familia registrada en el centro'] : []),
    ...x.otrasSolicitudes.map((o) => `otra solicitud ${o.codigo} (${o.alumna})`),
  ];
  checks.push(
    vinculos.length
      ? { id: 'familia', resultado: 'aviso', texto: `Familia ya vinculada al centro · ${vinculos.join(' · ')}` }
      : { id: 'familia', resultado: 'ok', texto: 'Sin expedientes previos de esta familia' },
  );

  checks.push(
    x.asignadaSnec
      ? { id: 'snec', resultado: 'aviso', texto: 'Solicitud asignada por la Junta (SNEC) · comprobar el cupo de la resolución' }
      : { id: 'snec', resultado: 'ok', texto: 'Solicitud por vía propia' },
  );

  return { checks, completa, faltan, puedeCitar: completa, calculadaEn: ahora.toISOString() };
}
