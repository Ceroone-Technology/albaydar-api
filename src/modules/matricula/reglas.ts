import {
  type ChecklistDocId,
  type CourseLevel,
  type Expediente,
  type IdearioPointId,
  type ViaId,
} from './borrador';

/**
 * Reglas de la matrícula digital: COPIA de `src/app/domain/rules/enrollment.rules.ts` del front
 * (mockup AlbaydarMockUp_draft_10, «Matrícula digital» y «Modo firma»). La API vuelve a comprobar
 * todo lo que el front comprueba (`docs/matricula.md`).
 *
 * Mismos nombres y misma lógica, a propósito, para poder compararlas línea a línea. Si cambia una
 * regla en el front, cambia aquí en el mismo PR, y al revés. Solo se adaptan los tipos.
 */

type Draft = Expediente;
export type BachModality = 'hum' | 'cie';
export type FamilySize = 'no' | 'general' | 'special';
export type SepaPaymentType = 'monthly' | 'single';

export const ENROLLMENT_STEPS = ['via', 'student', 'family', 'modality', 'annex', 'ideario', 'economic', 'documents', 'review'] as const;
export type EnrollmentStepId = (typeof ENROLLMENT_STEPS)[number];

export type ReaderDocId = 'impreso' | 'ideario' | 'lopd' | 'sepa' | 'plus';

export const SIGNATURE_SLOTS = [
  'impreso-titular',
  'ideario-titular',
  'lopd-padre',
  'lopd-madre',
  'lopd-img-padre',
  'lopd-img-madre',
  'lopd-pd-padre',
  'lopd-pd-madre',
  'sepa-titular',
  'plus-titular',
] as const;
export type SignatureSlotId = (typeof SIGNATURE_SLOTS)[number];

// ── Vía ─────────────────────────────────────────────────────────────────────

export function isBachillerato(via: ViaId | null): boolean {
  return via === 'bach';
}

// Ciclos Concertados: Grado Medio y Grado Superior.
export function isConcertado(via: ViaId | null): boolean {
  return via === 'gm' || via === 'gs';
}

export function isCycle(via: ViaId | null): boolean {
  return via === 'gm' || via === 'gs' || via === 'gsp';
}

// Automático por curso (1º, nueva; 2º, continúa) mientras no se toque a mano.
export function isNewStudent(draft: Pick<Draft, 'newStudent' | 'course'>): boolean {
  return draft.newStudent ?? draft.course === '1';
}

// ── Pasos ───────────────────────────────────────────────────────────────────

export function enrollmentFlow(draft: Draft, withViaStep: boolean): EnrollmentStepId[] {
  return [
    ...(withViaStep ? (['via'] as const) : []),
    'student',
    'family',
    ...(isBachillerato(draft.via) ? (['modality'] as const) : []),
    ...(isConcertado(draft.via) ? (['annex'] as const) : []),
    ...(isNewStudent(draft) ? (['ideario'] as const) : []),
    'economic',
    'documents',
    'review',
  ];
}

// ── Campos condicionales ────────────────────────────────────────────────────

export function showsBirthPlace(via: ViaId | null): boolean {
  return via === 'bach' || via === 'gsp';
}

export function showsNuss(via: ViaId | null): boolean {
  return isCycle(via);
}

export function showsPreviousStudies(via: ViaId | null): boolean {
  return isBachillerato(via);
}

// «No», General o Especial en todas las vías. El mockup quitaba «No» en
// Bachillerato y así una familia no numerosa no podía completar el paso
// Familia (pruebas E2E del 11/11/2026). El nº de título solo se pide si es
// numerosa. Copia de la regla del front (domain/rules/enrollment.rules.ts).
export function familySizeOptions(): FamilySize[] {
  return ['no', 'general', 'special'];
}

export function showsFamilySizeTitle(draft: Draft): boolean {
  return isBachillerato(draft.via) && draft.family.familySize !== null && draft.family.familySize !== 'no';
}

// ── Modalidad y materias (Bachillerato) ─────────────────────────────────────

export type SubjectGroupKind = 'modality' | 'both' | 'math';

export interface SubjectGroup {
  id: string;
  kind: SubjectGroupKind;
  options: string[];
  modality?: BachModality;
  fixed?: string;
}

const G = (id: string, kind: SubjectGroupKind, options: string[], extra: Partial<SubjectGroup> = {}): SubjectGroup => ({
  id,
  kind,
  options,
  ...extra,
});

const SUBJECT_GROUPS: Record<CourseLevel, Record<BachModality, SubjectGroup[]>> = {
  '1': {
    hum: [
      G('h1', 'modality', ['Latín I', 'Matemáticas Sociales I'], { modality: 'hum' }),
      G('c1', 'both', ['TIC', 'Debate', 'Francés']),
      G('c2', 'both', ['Patrimonio Cultural de Andalucía', 'Creación Digital y Pensamiento Computacional']),
    ],
    cie: [
      G('t1', 'modality', ['Biología', 'Física'], { modality: 'cie' }),
      G('t2', 'modality', ['Química', 'Dibujo Técnico I']),
      G('c1', 'both', ['TIC', 'Debate', 'Francés']),
      G('c3', 'both', ['Anatomía Aplicada', 'Creación Digital y Pensamiento Computacional']),
    ],
  },
  '2': {
    hum: [
      G('h2', 'modality', ['Latín II', 'Matemáticas Sociales II'], { modality: 'hum' }),
      G('m2', 'math', ['Matemáticas II', 'Matemáticas Sociales II']),
      G('d1', 'both', ['TIC', 'Francés']),
      G('d2', 'both', ['Programación', 'Psicología']),
    ],
    cie: [
      G('t3', 'modality', ['Biología y Geología', 'Dibujo Técnico II'], { modality: 'cie' }),
      G('m2', 'math', ['Matemáticas II', 'Matemáticas Sociales II'], { fixed: 'Matemáticas II' }),
      G('d1', 'both', ['TIC', 'Francés']),
      G('d2', 'both', ['Programación', 'Psicología']),
    ],
  },
};

export function subjectGroups(draft: Draft): SubjectGroup[] {
  const { modality } = draft.bachillerato;
  if (modality === null || draft.course === null) {
    return [];
  }

  return SUBJECT_GROUPS[draft.course][modality];
}

export function subjectChoice(draft: Draft, group: SubjectGroup): string | null {
  return group.fixed ?? draft.bachillerato.subjects[group.id] ?? null;
}

export function subjectsComplete(draft: Draft): boolean {
  const groups = subjectGroups(draft);

  return groups.length > 0 && groups.every((group) => subjectChoice(draft, group) !== null);
}

// ── Anexo VII (Ciclos Concertados) ──────────────────────────────────────────

export function annexComplete(draft: Draft): boolean {
  const { annex } = draft;
  const custodian = annex.custodians[0];
  const custodianOk = !annex.minor || (custodian !== undefined && filled(custodian.fullName) && filled(custodian.document));

  return (
    isConcertado(draft.via) &&
    annex.sex !== null &&
    annex.imageConsent !== null &&
    annex.cycleType !== null &&
    annex.regime !== null &&
    annex.enrollmentCourse !== null &&
    custodianOk
  );
}

// ── Ideario y LOPD (alumnado nuevo) ─────────────────────────────────────────

export function idearioPoints(via: ViaId | null): IdearioPointId[] {
  return isBachillerato(via) ? ['ideario', 'religion', 'outings'] : ['ideario', 'outings'];
}

// ── Modo firma ──────────────────────────────────────────────────────────────

export interface ReaderDocDefinition {
  pages: number;
  slots: SignatureSlotId[];
}

export const READER_DOCS: Record<ReaderDocId, ReaderDocDefinition> = {
  impreso: { pages: 1, slots: ['impreso-titular'] },
  ideario: { pages: 1, slots: ['ideario-titular'] },
  lopd: {
    pages: 7,
    slots: ['lopd-padre', 'lopd-madre', 'lopd-img-padre', 'lopd-img-madre', 'lopd-pd-padre', 'lopd-pd-madre'],
  },
  sepa: { pages: 1, slots: ['sepa-titular'] },
  plus: { pages: 1, slots: ['plus-titular'] },
};

export function readPageKey(doc: ReaderDocId, page: number): string {
  return `${doc}-${page}`;
}

export function isDocRead(draft: Draft, doc: ReaderDocId): boolean {
  return Array.from({ length: READER_DOCS[doc].pages }, (_, index) => index + 1).every(
    (page) => draft.readPages[readPageKey(doc, page)] === true,
  );
}

export function isDocSigned(draft: Draft, doc: ReaderDocId): boolean {
  return READER_DOCS[doc].slots.every((slot) => draft.signatures[slot] !== undefined);
}

export function readerDocsFor(draft: Draft): ReaderDocId[] {
  return [
    'impreso',
    ...(isNewStudent(draft) ? (['ideario', 'lopd'] as const) : []),
    ...(sepaApplies(draft) ? (['sepa'] as const) : []),
    ...(plusAvailable(draft.via) && draft.economic.plus ? (['plus'] as const) : []),
  ];
}

export function canSignDoc(draft: Draft, doc: ReaderDocId): boolean {
  return (
    isDocRead(draft, doc) &&
    (doc !== 'lopd' || draft.lopd.dop !== null) &&
    (doc !== 'sepa' || sepaPaymentType(draft) !== null)
  );
}

export function sepaPaymentType(draft: Draft): SepaPaymentType | null {
  return draft.via === 'gs' ? 'single' : draft.economic.sepa.paymentType;
}

// ── Económico ───────────────────────────────────────────────────────────────

export type EconomicUnit = 'month' | 'course';

export interface EconomicLine {
  id: string;
  amount?: number;
  unit?: EconomicUnit;
  locked?: boolean;
}

export function economicLines(draft: Draft): EconomicLine[] {
  const first = draft.course === '1';

  switch (draft.via) {
    case 'bach':
      return [
        first
          ? { id: 'bachReserve' }
          : isNewStudent(draft)
            ? { id: 'bachEnrollmentNew', amount: 100 }
            : { id: 'bachEnrollmentContinuing' },
        { id: 'bachMonthly', amount: 410, unit: 'month' },
        { id: first ? 'bachAmpaFirst' : 'bachAmpaSecond', amount: 90 },
        ...(first ? [{ id: 'bachUniform', amount: 45 }] : []),
      ];
    case 'gm':
      return [{ id: 'gmTuition' }, { id: 'plus', amount: 20, unit: 'month' }];
    case 'gs':
      return [
        { id: 'gsFee', amount: 180.3, unit: 'course', locked: true },
        { id: 'plus', amount: 20, unit: 'month' },
      ];
    case 'gsp':
      return [
        first ? { id: 'gspReserve', amount: 300 } : { id: 'gspEnrollment', amount: 250 },
        { id: 'gspMonthly', amount: first ? 295 : 275, unit: 'month' },
      ];
    default:
      return [];
  }
}

export function scholarshipPercent(draft: Draft): number {
  const value = Number.parseFloat(draft.economic.scholarshipPercent.replace(',', '.'));

  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

export function scholarshipActive(draft: Draft): boolean {
  return draft.economic.scholarship && scholarshipPercent(draft) > 0;
}

export function discountedAmount(draft: Draft, line: EconomicLine): number | null {
  if (line.amount === undefined || line.locked || !scholarshipActive(draft)) {
    return null;
  }

  return Math.round(line.amount * (1 - scholarshipPercent(draft) / 100) * 100) / 100;
}

export function gsPaysByDirectDebit(draft: Draft): boolean {
  return draft.economic.gsPayment === null || draft.economic.gsPayment === 'direct_debit';
}

export function sepaApplies(draft: Draft): boolean {
  return draft.via !== null && draft.via !== 'gm' && (draft.via !== 'gs' || gsPaysByDirectDebit(draft));
}

export function plusAvailable(via: ViaId | null): boolean {
  return isConcertado(via);
}

export function economicDone(draft: Draft): boolean {
  if (draft.via === 'gm') {
    return !draft.economic.plus || isDocSigned(draft, 'plus');
  }
  if (draft.via === 'gs' && !gsPaysByDirectDebit(draft)) {
    return true;
  }

  return draft.via !== null && isDocSigned(draft, 'sepa');
}

// ── Checklist de documentos ─────────────────────────────────────────────────

export type ChecklistOrigin = 'generated' | 'family' | 'manual';

export interface ChecklistItem {
  id: ChecklistDocId;
  origin: ChecklistOrigin;
  readerDoc?: ReaderDocId;
  counts: boolean;
  done: boolean;
}

export function checklist(draft: Draft): ChecklistItem[] {
  const isNew = isNewStudent(draft);
  const { via } = draft;
  const uploaded = (id: ChecklistDocId) => draft.documents[id] !== undefined;
  const items: ChecklistItem[] = [];

  items.push({ id: 'm1', origin: 'generated', readerDoc: 'impreso', counts: false, done: isDocSigned(draft, 'impreso') });
  if (isNew) {
    items.push({ id: 'm2', origin: 'generated', readerDoc: 'ideario', counts: true, done: isDocSigned(draft, 'ideario') });
    items.push({ id: 'm3', origin: 'generated', readerDoc: 'lopd', counts: true, done: isDocSigned(draft, 'lopd') });
  }
  if (via === 'bach' || isNew) {
    items.push({ id: 'm4', origin: 'family', counts: true, done: uploaded('m4') });
  }
  if (!(isConcertado(via) && !isNew)) {
    items.push({ id: 'm5', origin: 'manual', counts: true, done: draft.photo !== null || draft.manualChecks.m5 === true });
  }
  if (isConcertado(via)) {
    items.push({ id: 'c1', origin: 'generated', counts: true, done: annexComplete(draft) });
  }
  if (via === 'gs' && isNew) {
    items.push({ id: 'c2', origin: 'family', counts: true, done: uploaded('c2') });
  }
  if ((via === 'bach' || via === 'gsp') && isNew) {
    items.push({ id: 'b1', origin: 'family', counts: true, done: uploaded('b1') });
    items.push({ id: 'b2', origin: 'family', counts: true, done: uploaded('b2') });
  }

  const e1Reader: ReaderDocId | undefined =
    via === 'gm' ? (draft.economic.plus ? 'plus' : undefined) : sepaApplies(draft) ? 'sepa' : undefined;
  items.push({ id: 'e1', origin: 'generated', ...(e1Reader ? { readerDoc: e1Reader } : {}), counts: true, done: economicDone(draft) });

  if (via === 'gs') {
    items.push({
      id: 'p1',
      origin: 'generated',
      readerDoc: 'plus',
      counts: false,
      done: isDocSigned(draft, 'plus') || (draft.economic.plus && draft.manualChecks.p1 === true),
    });
  }

  return items;
}

export function checklistProgress(draft: Draft): { done: number; total: number } {
  const counted = checklist(draft).filter((item) => item.counts);

  return { done: counted.filter((item) => item.done).length, total: counted.length };
}

// ── Validación por paso ─────────────────────────────────────────────────────

// ── Formatos de los datos (16/11/2026) ─────────────────────────────────────
//
// Un dato con formato incorrecto cuenta como no completado: no deja continuar
// ni enviar. Misma copia en la API (modules/matricula/reglas.ts) y en el front
// (domain/rules/enrollment.rules.ts): si cambia una, cambia la otra.

const compact = (value: string) => value.replace(/[\s.\-/]/g, '').toUpperCase();

// Longitud del IBAN de cada país de la zona SEPA (lista del EPC).
const SEPA_IBAN_LENGTH: Record<string, number> = {
  AD: 24, AL: 28, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27,
  GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24,
  ME: 22, MK: 19, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

// IBAN de la zona SEPA: país, longitud de ese país (24 en España) y dígitos de
// control ISO 13616 (módulo 97). Admite espacios y guiones.
export function isValidIban(value: string): boolean {
  const iban = compact(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || SEPA_IBAN_LENGTH[iban.slice(0, 2)] !== iban.length) {
    return false;
  }
  let rest = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    const digits = char >= 'A' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) {
      rest = (rest * 10 + Number(digit)) % 97;
    }
  }

  return rest === 1;
}

const ID_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

// DNI (8 cifras y letra) o NIE (X, Y o Z, 7 cifras y letra) con su letra de control.
export function isValidSpanishId(value: string): boolean {
  const match = /^([XYZ]|\d)(\d{7})([A-Z])$/.exec(compact(value));
  if (match === null) {
    return false;
  }
  const [, initial = '', digits = '', letter = ''] = match;
  const first = 'XYZ'.includes(initial) ? String('XYZ'.indexOf(initial)) : initial;

  return ID_LETTERS[Number(first + digits) % 23] === letter;
}

// Documento de una persona: DNI o NIE con su letra o, si es extranjero, un
// pasaporte (de 5 a 20 letras y cifras, con alguna cifra). Un DNI o NIE sin
// letra no vale.
export function isValidIdentityDocument(value: string): boolean {
  const doc = compact(value);
  if (/^(\d{8}|[XYZ]\d{7})[A-Z]$/.test(doc)) {
    return isValidSpanishId(doc);
  }
  if (/^(\d{7,8}|[XYZ]\d{7})$/.test(doc)) {
    return false;
  }

  return /^[A-Z0-9]{5,20}$/.test(doc) && /\d/.test(doc);
}

// BIC o SWIFT: 8 u 11 caracteres (banco, país, localidad y oficina).
export function isValidBic(value: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(compact(value));
}

// Teléfono: de 9 a 15 cifras, con prefijo internacional opcional.
export function isValidPhone(value: string): boolean {
  return /^\+?\d{9,15}$/.test(value.replace(/[\s().-]/g, ''));
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

// Código postal español: 5 cifras de una provincia que existe (01 a 52).
export function isValidPostalCode(value: string): boolean {
  return /^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/.test(value.trim());
}

// Fecha DD/MM/AAAA que existe, desde 1900 y no posterior a hoy.
export function isValidPastDate(value: string): boolean {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (match === null) {
    return false;
  }
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  return year >= 1900 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getTime() <= Date.now();
}

// Nº de afiliación a la Seguridad Social: provincia (2), número (7 u 8) y dos
// dígitos de control (módulo 97). Admite espacios, puntos y barras.
export function isValidNuss(value: string): boolean {
  const nuss = value.replace(/[\s./-]/g, '');
  if (!/^\d{11,12}$/.test(nuss)) {
    return false;
  }
  const province = Number(nuss.slice(0, 2));
  const number = Number(nuss.slice(2, -2));
  const control = Number(nuss.slice(-2));
  const base = number < 10_000_000 ? number + province * 10_000_000 : Number(`${nuss.slice(0, 2)}${nuss.slice(2, -2).padStart(8, '0')}`);

  return base % 97 === control;
}

// Nota media de 0 a 10, con coma o punto y hasta dos decimales: «7,5».
export function isValidGrade(value: string): boolean {
  return /^(10([.,]0{1,2})?|\d([.,]\d{1,2})?)$/.test(value.trim());
}

function filled(value: string | undefined | null): boolean {
  return (value ?? '').trim() !== '';
}


export function stepMissing(draft: Draft, step: EnrollmentStepId): string[] {
  const missing: string[] = [];
  const need = (ok: boolean, field: string) => {
    if (!ok) {
      missing.push(field);
    }
  };
  // Con algo escrito, tiene que tener el formato; vacío lo marca `need` si es obligatorio.
  const valid = (value: string | undefined | null, check: (value: string) => boolean, field: string) => {
    if (filled(value) && !check(value ?? '') && !missing.includes(field)) {
      missing.push(field);
    }
  };

  switch (step) {
    case 'via':
      need(draft.via !== null, 'via');
      need(draft.course !== null, 'course');
      break;

    case 'student': {
      const { student, previousStudies: previous, pasen } = draft;
      for (const field of ['firstSurname', 'firstName', 'birthDate', 'document', 'phone', 'address', 'municipality', 'province', 'postalCode'] as const) {
        need(filled(student[field]), `student.${field}`);
      }
      need(EMAIL_PATTERN.test(student.email.trim()), 'student.email');
      valid(student.birthDate, isValidPastDate, 'student.birthDate');
      valid(student.document, isValidIdentityDocument, 'student.document');
      valid(student.phone, isValidPhone, 'student.phone');
      valid(student.postalCode, isValidPostalCode, 'student.postalCode');
      if (showsNuss(draft.via)) {
        need(filled(student.nuss), 'student.nuss');
        valid(student.nuss, isValidNuss, 'student.nuss');
      }
      if (showsPreviousStudies(draft.via)) {
        for (const field of ['school', 'course', 'locality', 'averageGrade'] as const) {
          need(filled(previous[field]), `previousStudies.${field}`);
        }
        valid(previous.averageGrade, isValidGrade, 'previousStudies.averageGrade');
        need(previous.stage !== null, 'previousStudies.stage');
        need(previous.promotes !== null, 'previousStudies.promotes');
        if (previous.promotes === false) {
          need(filled(previous.pendingSubjects), 'previousStudies.pendingSubjects');
        }
        need(pasen.enabled !== null, 'pasen.enabled');
        if (pasen.enabled) {
          need(filled(pasen.holder), 'pasen.holder');
          need(filled(pasen.phone), 'pasen.phone');
          valid(pasen.phone, isValidPhone, 'pasen.phone');
        }
      }
      break;
    }

    case 'family': {
      const { family } = draft;
      const first = family.guardians[0];
      need(filled(first.fullName), 'family.guardians.0.fullName');
      need(filled(first.document), 'family.guardians.0.document');
      need(EMAIL_PATTERN.test(first.email.trim()), 'family.guardians.0.email');
      need(filled(first.phone), 'family.guardians.0.phone');
      valid(first.document, isValidIdentityDocument, 'family.guardians.0.document');
      valid(first.phone, isValidPhone, 'family.guardians.0.phone');
      const second = family.guardians[1];
      valid(second?.document, isValidIdentityDocument, 'family.guardians.1.document');
      valid(second?.phone, isValidPhone, 'family.guardians.1.phone');
      valid(second?.email, isValidEmail, 'family.guardians.1.email');
      valid(family.address.postalCode, isValidPostalCode, 'family.address.postalCode');
      need(family.familySize !== null && familySizeOptions().includes(family.familySize), 'family.familySize');
      if (showsFamilySizeTitle(draft)) {
        need(filled(family.familySizeTitle), 'family.familySizeTitle');
      }
      need(family.siblings !== null && family.siblings >= 0, 'family.siblings');
      need(family.contactPreference !== null, 'family.contactPreference');
      break;
    }

    case 'modality':
      need(draft.bachillerato.modality !== null, 'bachillerato.modality');
      for (const group of subjectGroups(draft)) {
        need(subjectChoice(draft, group) !== null, `bachillerato.subjects.${group.id}`);
      }
      break;

    case 'annex': {
      const { annex } = draft;
      need(annex.sex !== null, 'annex.sex');
      need(annex.cycleType !== null, 'annex.cycleType');
      need(annex.regime !== null, 'annex.regime');
      need(annex.enrollmentCourse !== null, 'annex.enrollmentCourse');
      need(annex.imageConsent !== null, 'annex.imageConsent');
      if (annex.minor) {
        need(filled(annex.custodians[0]?.fullName), 'annex.custodians.0.fullName');
        need(filled(annex.custodians[0]?.document), 'annex.custodians.0.document');
      }
      valid(annex.custodians[0]?.document, isValidIdentityDocument, 'annex.custodians.0.document');
      valid(annex.custodians[0]?.phone, isValidPhone, 'annex.custodians.0.phone');
      valid(annex.custodians[0]?.email, isValidEmail, 'annex.custodians.0.email');
      valid(annex.postalCode, isValidPostalCode, 'annex.postalCode');
      break;
    }

    case 'ideario':
      for (const point of idearioPoints(draft.via)) {
        if (draft.ideario.answers[point] === false) {
          need(filled(draft.ideario.reasons[point]), `ideario.reasons.${point}`);
        }
      }
      need(isDocSigned(draft, 'ideario'), 'signature.ideario');
      need(draft.lopd.dop !== null, 'lopd.dop');
      need(isDocSigned(draft, 'lopd'), 'signature.lopd');
      break;

    case 'economic':
      if (draft.economic.scholarship) {
        need(scholarshipPercent(draft) > 0, 'economic.scholarshipPercent');
        need(filled(draft.economic.scholarshipBody), 'economic.scholarshipBody');
      }
      if (sepaApplies(draft)) {
        need(filled(draft.economic.sepa.iban), 'economic.sepa.iban');
        need(filled(draft.economic.sepa.holder), 'economic.sepa.holder');
        need(filled(draft.economic.sepa.holderDocument), 'economic.sepa.holderDocument');
        // Lo mismo que exige la orden SEPA al firmarla (IBAN de la zona SEPA, DNI o NIE del titular y BIC).
        valid(draft.economic.sepa.iban, isValidIban, 'economic.sepa.iban');
        valid(draft.economic.sepa.holderDocument, isValidSpanishId, 'economic.sepa.holderDocument');
        valid(draft.economic.sepa.bic, isValidBic, 'economic.sepa.bic');
      }
      need(economicDone(draft), 'signature.economic');
      break;

    case 'documents':
      for (const item of checklist(draft)) {
        if (item.counts) {
          need(item.done, `documents.${item.id}`);
        }
      }
      break;

    case 'review':
      need(isDocSigned(draft, 'impreso'), 'signature.impreso');
      need(filled(draft.declaration.day), 'declaration.day');
      need(filled(draft.declaration.month), 'declaration.month');
      need(draft.declaration.signer !== null, 'declaration.signer');
      break;
  }

  return missing;
}

export function stepComplete(draft: Draft, step: EnrollmentStepId): boolean {
  return stepMissing(draft, step).length === 0;
}

export function canSubmit(draft: Draft): boolean {
  return enrollmentFlow(draft, true).every((step) => stepComplete(draft, step));
}

/** Lo que falta en cada paso del flujo (con la vía como primer paso). Solo los pasos incompletos. */
export function pendientes(draft: Draft): Partial<Record<EnrollmentStepId, string[]>> {
  return Object.fromEntries(
    enrollmentFlow(draft, true)
      .map((step) => [step, stepMissing(draft, step)] as const)
      .filter(([, missing]) => missing.length > 0),
  );
}
