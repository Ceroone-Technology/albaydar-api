import type { Columna } from '../../lib/csv';
import type { Matricula } from '../../db/schema';
import { ETIQUETA_VIA } from './documentos/textos';
import { subjectChoice, subjectGroups } from './reglas';
import type { Expediente } from './borrador';

/**
 * Fichero para cargar la matrícula en Séneca (docs/matricula.md, punto 9).
 *
 * PROVISIONAL: el formato oficial depende del centro (pregunta 28). Todas las columnas viven aquí;
 * cuando llegue el formato o un fichero de ejemplo, solo cambia este adaptador. Mientras, un CSV
 * para Excel (separador «;», BOM) con los datos que recoge el asistente.
 */

export interface FilaSeneca {
  m: Matricula;
  exp: Expediente;
  expediente: string;
}

const MODALIDAD = { hum: 'Humanidades y Ciencias Sociales', cie: 'Ciencias y Tecnología' } as const;
const SEXO = { H: 'Hombre', M: 'Mujer' } as const;
const tutor = (i: 0 | 1, campo: 'fullName' | 'document' | 'phone' | 'email') => (f: FilaSeneca) => f.exp.family.guardians[i][campo];

export const COLUMNAS_SENECA: Columna<FilaSeneca>[] = [
  { titulo: 'matricula', valor: (f) => f.m.codigo },
  { titulo: 'expediente', valor: (f) => f.expediente },
  { titulo: 'curso_escolar', valor: (f) => f.m.cursoEscolar },
  { titulo: 'ensenanza', valor: (f) => (f.exp.via ? ETIQUETA_VIA[f.exp.via] : '') },
  { titulo: 'curso', valor: (f) => f.exp.course ?? '' },
  { titulo: 'ciclo', valor: (f) => f.exp.annex.cycle ?? '' },
  { titulo: 'modalidad', valor: (f) => (f.exp.bachillerato.modality ? MODALIDAD[f.exp.bachillerato.modality] : '') },
  { titulo: 'materias', valor: (f) => subjectGroups(f.exp).map((g) => subjectChoice(f.exp, g)).filter(Boolean).join(' | ') },
  { titulo: 'alumna_nueva', valor: (f) => f.m.nuevaAlumna },
  { titulo: 'primer_apellido', valor: (f) => f.exp.student.firstSurname },
  { titulo: 'segundo_apellido', valor: (f) => f.exp.student.secondSurname },
  { titulo: 'nombre', valor: (f) => f.exp.student.firstName },
  { titulo: 'fecha_nacimiento', valor: (f) => f.exp.student.birthDate },
  { titulo: 'sexo', valor: (f) => (f.exp.annex.sex ? SEXO[f.exp.annex.sex] : '') },
  { titulo: 'documento', valor: (f) => f.exp.student.document },
  { titulo: 'nuss', valor: (f) => f.exp.student.nuss },
  { titulo: 'localidad_nacimiento', valor: (f) => f.exp.student.birthPlace || f.exp.annex.birthMunicipality },
  { titulo: 'pais_nacimiento', valor: (f) => f.exp.student.birthCountry || f.exp.annex.birthCountry },
  { titulo: 'email', valor: (f) => f.exp.student.email },
  { titulo: 'telefono', valor: (f) => f.exp.student.phone },
  { titulo: 'domicilio', valor: (f) => f.exp.student.address },
  { titulo: 'municipio', valor: (f) => f.exp.student.municipality },
  { titulo: 'provincia', valor: (f) => f.exp.student.province },
  { titulo: 'codigo_postal', valor: (f) => f.exp.student.postalCode },
  { titulo: 'centro_anterior', valor: (f) => f.exp.previousStudies.school || f.exp.annex.school },
  { titulo: 'tutor1_nombre', valor: tutor(0, 'fullName') },
  { titulo: 'tutor1_documento', valor: tutor(0, 'document') },
  { titulo: 'tutor1_telefono', valor: tutor(0, 'phone') },
  { titulo: 'tutor1_email', valor: tutor(0, 'email') },
  { titulo: 'tutor2_nombre', valor: tutor(1, 'fullName') },
  { titulo: 'tutor2_documento', valor: tutor(1, 'document') },
  { titulo: 'tutor2_telefono', valor: tutor(1, 'phone') },
  { titulo: 'tutor2_email', valor: tutor(1, 'email') },
  { titulo: 'familia_numerosa', valor: (f) => ({ no: 'No', general: 'General', special: 'Especial' })[f.exp.family.familySize ?? 'no'] },
  { titulo: 'pasen_sms', valor: (f) => f.exp.pasen.enabled ?? '' },
];
