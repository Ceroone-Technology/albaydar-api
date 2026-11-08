import { z } from 'zod';

/**
 * Borrador de la matrícula: los datos del asistente del front.
 *
 * Va con la MISMA forma y los mismos nombres (en inglés) que `EnrollmentDraft` del front
 * (`src/app/domain/interfaces/enrollment.interface.ts`), a propósito: las reglas
 * (`reglas.ts`) son una copia de `enrollment.rules.ts` y así se comparan línea a línea.
 * Lo que rodea al borrador (la matrícula, sus estados, enlaces e historial) sí va en español,
 * como el resto de la API. Decisión del 08/11/2026 (`docs/matricula.md`, punto 10).
 *
 * Los objetos son estrictos: un campo que no existe es un 400 con su ruta, para que un cambio
 * del front que no llegó aquí se vea enseguida en vez de perderse en silencio.
 *
 * Los textos no se validan al guardar (el borrador se guarda a medias, con autoguardado):
 * solo longitud máxima. Lo obligatorio lo dice `stepMissing` al enviar.
 */

const t = (max = 200) => z.string().max(max);
const n = <T extends z.ZodType>(s: T) => s.nullable();

export const VIAS = ['bach', 'gm', 'gs', 'gsp'] as const;
export const CURSOS = ['1', '2'] as const;
export type ViaId = (typeof VIAS)[number];
export type CourseLevel = (typeof CURSOS)[number];

export const PREVIOUS_STAGES = ['ESO', 'Bachillerato', 'FP Básica', 'Grado Medio'] as const;
export const STREET_TYPES = ['Calle', 'Avenida', 'Plaza', 'Camino', 'Paseo', 'Carretera', 'Otros'] as const;
export const CYCLES = [
  'Administración y Finanzas',
  'Desarrollo de Aplicaciones Multiplataforma',
  'Gestión Administrativa',
  'Sistemas Microinformáticos y Redes',
  'Marketing y Publicidad',
] as const;
export const ANNEX_OBJECTIONS = ['o1', 'o2', 'o3', 'o4', 'o5'] as const;
export const LOPD_AUTHORIZATIONS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13'] as const;
export const IDEARIO_POINTS = ['ideario', 'religion', 'outings'] as const;
export const CHECKLIST_DOCS = ['m1', 'm2', 'm3', 'm4', 'm5', 'c1', 'c2', 'b1', 'b2', 'e1', 'p1'] as const;

export type ChecklistDocId = (typeof CHECKLIST_DOCS)[number];
export type IdearioPointId = (typeof IDEARIO_POINTS)[number];
export type LopdAuthorizationId = (typeof LOPD_AUTHORIZATIONS)[number];

const guardian = z.strictObject({ fullName: t(), profession: t(), document: t(20), email: t(254), phone: t(30) });
const custodian = z.strictObject({
  fullName: t(),
  document: t(20),
  phone: t(30),
  email: t(254),
  relationship: n(z.enum(['father', 'mother', 'legal_guardian'])),
});

const registro = <K extends string, S extends z.ZodType>(claves: readonly K[], valor: S) =>
  z.strictObject(Object.fromEntries(claves.map((k) => [k, valor])) as { [P in K]: S });
const registroParcial = <K extends string, S extends z.ZodType>(claves: readonly K[], valor: S) =>
  z.strictObject(Object.fromEntries(claves.map((k) => [k, valor.optional()])) as { [P in K]: z.ZodOptional<S> });

export const borradorSchema = z.strictObject({
  via: n(z.enum(VIAS)),
  course: n(z.enum(CURSOS)),
  newStudent: n(z.boolean()),
  student: z.strictObject({
    firstSurname: t(),
    secondSurname: t(),
    firstName: t(),
    birthDate: t(10),
    document: t(20),
    birthPlace: t(),
    birthCountry: t(100),
    nuss: t(20),
    email: t(254),
    phone: t(30),
    address: t(300),
    municipality: t(100),
    province: t(100),
    postalCode: t(10),
  }),
  previousStudies: z.strictObject({
    school: t(),
    course: t(100),
    locality: t(100),
    stage: n(z.enum(PREVIOUS_STAGES)),
    averageGrade: t(10),
    promotes: n(z.boolean()),
    pendingSubjects: t(500),
  }),
  pasen: z.strictObject({ enabled: n(z.boolean()), holder: t(), phone: t(30) }),
  family: z.strictObject({
    guardians: z.tuple([guardian, guardian]),
    address: z.strictObject({ address: t(300), municipality: t(100), province: t(100), postalCode: t(10) }),
    familySize: n(z.enum(['no', 'general', 'special'])),
    familySizeTitle: t(50),
    siblings: n(z.number().int().min(0).max(20)),
    contactPreference: n(z.enum(['father', 'mother'])),
  }),
  bachillerato: z.strictObject({
    modality: n(z.enum(['hum', 'cie'])),
    subjects: z.record(z.string().max(10), t(100)).refine((r) => Object.keys(r).length <= 10, 'Demasiadas materias.'),
    previousModality: n(z.enum(['hum', 'cie'])),
  }),
  annex: z.strictObject({
    sex: n(z.enum(['H', 'M'])),
    birthMunicipality: t(100),
    birthProvince: t(100),
    birthCountry: t(100),
    streetType: n(z.enum(STREET_TYPES)),
    streetName: t(),
    number: t(10),
    letter: t(10),
    km: t(10),
    block: t(10),
    portal: t(10),
    stair: t(10),
    floor: t(10),
    door: t(10),
    populationEntity: t(100),
    municipality: t(100),
    province: t(100),
    postalCode: t(10),
    minor: z.boolean(),
    custodians: z.array(custodian).max(2),
    lastStudies: t(),
    lastStudiesYear: t(20),
    school: t(),
    schoolLocality: t(100),
    cycle: n(z.enum(CYCLES)),
    cycleType: n(z.enum(['basic', 'intermediate', 'higher', 'specialization'])),
    regime: n(z.enum(['ordinary', 'adults'])),
    enrollmentCourse: n(z.enum(CURSOS)),
    cine: n(z.number().int().min(0).max(8)),
    objections: registro(ANNEX_OBJECTIONS, z.boolean()),
    imageConsent: n(z.boolean()),
  }),
  ideario: z.strictObject({
    answers: registroParcial(IDEARIO_POINTS, z.boolean()),
    reasons: registroParcial(IDEARIO_POINTS, t(500)),
  }),
  lopd: z.strictObject({ authorizations: registro(LOPD_AUTHORIZATIONS, z.boolean()), dop: n(z.boolean()) }),
  economic: z.strictObject({
    scholarship: z.boolean(),
    scholarshipPercent: t(10),
    scholarshipBody: t(),
    gsPayment: n(z.enum(['direct_debit', 'cash', 'transfer'])),
    sepa: z.strictObject({
      iban: t(42),
      holder: t(),
      holderDocument: t(20),
      bic: t(11),
      paymentType: n(z.enum(['monthly', 'single'])),
    }),
    plus: z.boolean(),
  }),
  /** Documentos marcados a mano (fotos o AlbaydarPLUS en papel). Solo los marca secretaría. */
  manualChecks: registroParcial(CHECKLIST_DOCS, z.boolean()),
  /** Páginas marcadas como leídas en el Modo firma («lopd-3»). Se suman, nunca se quitan. */
  readPages: z.record(z.string().regex(/^(impreso|ideario|lopd|sepa|plus)-[1-9]$/, 'Página no válida.'), z.boolean()),
  declaration: z.strictObject({
    day: t(2),
    month: t(20),
    signer: n(z.enum(['student', 'guardian'])),
  }),
});

/**
 * Lo que manda el front al guardar. Trae también los campos que decide el servidor (foto,
 * archivos y firmas), porque el borrador del front es un único objeto: se aceptan y se ignoran.
 */
export const borradorEntrada = borradorSchema.extend({
  photo: z.unknown().optional(),
  documents: z.unknown().optional(),
  signatures: z.unknown().optional(),
});

export type Borrador = z.infer<typeof borradorSchema>;

export interface ArchivoSubido {
  name: string;
  size: number;
  uploadedAt: string;
}

export interface FirmaVista {
  image: string;
  signedAt: string;
}

/** El borrador con lo que controla el servidor: lo que reciben las reglas y el front. */
export type Expediente = Borrador & {
  photo: ArchivoSubido | null;
  documents: Partial<Record<ChecklistDocId, ArchivoSubido>>;
  signatures: Partial<Record<string, FirmaVista>>;
};

const guardianVacio = () => ({ fullName: '', profession: '', document: '', email: '', phone: '' });

export const custodianVacio = (): Borrador['annex']['custodians'][number] => ({
  fullName: '',
  document: '',
  phone: '',
  email: '',
  relationship: null,
});

/** Autorizaciones de la LOPD marcadas por defecto en el mockup. */
export const LOPD_DEFAULT_AUTHORIZATIONS: readonly LopdAuthorizationId[] = ['a1', 'a6', 'a8', 'a9', 'a12'];

/** Borrador vacío: el `createEmptyDraft()` del front. */
export function borradorVacio(): Borrador {
  return {
    via: null,
    course: null,
    newStudent: null,
    student: {
      firstSurname: '',
      secondSurname: '',
      firstName: '',
      birthDate: '',
      document: '',
      birthPlace: '',
      birthCountry: '',
      nuss: '',
      email: '',
      phone: '',
      address: '',
      municipality: '',
      province: '',
      postalCode: '',
    },
    previousStudies: { school: '', course: '', locality: '', stage: null, averageGrade: '', promotes: null, pendingSubjects: '' },
    pasen: { enabled: null, holder: '', phone: '' },
    family: {
      guardians: [guardianVacio(), guardianVacio()],
      address: { address: '', municipality: '', province: '', postalCode: '' },
      familySize: null,
      familySizeTitle: '',
      siblings: null,
      contactPreference: null,
    },
    bachillerato: { modality: null, subjects: {}, previousModality: null },
    annex: {
      sex: null,
      birthMunicipality: '',
      birthProvince: '',
      birthCountry: '',
      streetType: null,
      streetName: '',
      number: '',
      letter: '',
      km: '',
      block: '',
      portal: '',
      stair: '',
      floor: '',
      door: '',
      populationEntity: '',
      municipality: '',
      province: '',
      postalCode: '',
      minor: true,
      custodians: [custodianVacio()],
      lastStudies: '',
      lastStudiesYear: '',
      school: '',
      schoolLocality: '',
      cycle: null,
      cycleType: null,
      regime: null,
      enrollmentCourse: null,
      cine: null,
      objections: Object.fromEntries(ANNEX_OBJECTIONS.map((id) => [id, false])) as Borrador['annex']['objections'],
      imageConsent: null,
    },
    // Los puntos del ideario arrancan en «Sí», como en el mockup.
    ideario: { answers: { ideario: true, religion: true, outings: true }, reasons: {} },
    lopd: {
      authorizations: Object.fromEntries(LOPD_AUTHORIZATIONS.map((id) => [id, LOPD_DEFAULT_AUTHORIZATIONS.includes(id)])) as Borrador['lopd']['authorizations'],
      dop: null,
    },
    economic: {
      scholarship: false,
      scholarshipPercent: '',
      scholarshipBody: '',
      gsPayment: null,
      sepa: { iban: '', holder: '', holderDocument: '', bic: '', paymentType: null },
      plus: false,
    },
    manualChecks: {},
    readPages: {},
    declaration: { day: '', month: '', signer: null },
  };
}
