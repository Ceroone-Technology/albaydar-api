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

export function familySizeOptions(via: ViaId | null): FamilySize[] {
  return isBachillerato(via) ? ['general', 'special'] : ['no', 'general', 'special'];
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

function filled(value: string | undefined | null): boolean {
  return (value ?? '').trim() !== '';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function stepMissing(draft: Draft, step: EnrollmentStepId): string[] {
  const missing: string[] = [];
  const need = (ok: boolean, field: string) => {
    if (!ok) {
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
      if (showsNuss(draft.via)) {
        need(filled(student.nuss), 'student.nuss');
      }
      if (showsPreviousStudies(draft.via)) {
        for (const field of ['school', 'course', 'locality', 'averageGrade'] as const) {
          need(filled(previous[field]), `previousStudies.${field}`);
        }
        need(previous.stage !== null, 'previousStudies.stage');
        need(previous.promotes !== null, 'previousStudies.promotes');
        if (previous.promotes === false) {
          need(filled(previous.pendingSubjects), 'previousStudies.pendingSubjects');
        }
        need(pasen.enabled !== null, 'pasen.enabled');
        if (pasen.enabled) {
          need(filled(pasen.holder), 'pasen.holder');
          need(filled(pasen.phone), 'pasen.phone');
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
      need(family.familySize !== null && familySizeOptions(draft.via).includes(family.familySize), 'family.familySize');
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
