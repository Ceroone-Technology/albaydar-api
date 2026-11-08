import { createHash } from 'node:crypto';
import { env } from '../../../config/env';
import type { FamiliaVia } from '../../../db/schema';
import { acreedorDe, type MatriculaConfig } from '../../ajustes/ajustes.service';
import type { Expediente, LopdAuthorizationId } from '../borrador';
import { jsonCanonico } from '../json-canonico';
import { idearioPoints, isBachillerato, READER_DOCS, sepaPaymentType, type ReaderDocId, type SignatureSlotId } from '../reglas';
import {
  AMBAS_FIRMAS,
  AUTORIZA,
  CAMPOS,
  DECLARACION_LECTURA,
  DOCUMENTOS,
  ETIQUETA_VIA,
  FECHA_SEVILLA,
  HUECOS,
  IDEARIO,
  IMPRESO,
  LOPD,
  MEMBRETE,
  NOTA_SEPA_GS,
  NO_AUTORIZA,
  PLUS,
  SEPA,
  VERSIONES,
} from './textos';

/**
 * Documento rellenado con los datos de la matrícula: lo que pinta el lector del front y lo que
 * se firma (docs/matricula.md, punto 1). La huella es el SHA-256 de su contenido canónico.
 */

export type AnchoCampo = 'estrecho' | 'normal' | 'ancho' | 'completo' | 'cuenta';

export interface Campo {
  etiqueta: string;
  valor: string;
  /** Ruta del borrador que se puede corregir desde el propio documento («economic.sepa.iban»). */
  campo?: string;
  ancho?: AnchoCampo;
}

export interface Opcion {
  etiqueta: string;
  texto: string;
  marcada: boolean;
  /** «Autoriza» / «No autoriza», «Acepta» / «No acepta». */
  estado?: string;
  motivo?: string;
  /** Casilla editable: ruta del borrador («lopd.authorizations.a1»). */
  campo?: string;
  /** Opción única: el valor que toma `campo` al elegirla. */
  valor?: boolean | string;
}

export type Bloque =
  | { tipo: 'titulo' | 'subtitulo' | 'parrafo' | 'nota'; texto: string }
  | { tipo: 'campos'; titulo: string | null; campos: Campo[] }
  | { tipo: 'casillas'; opciones: Opcion[] }
  | { tipo: 'opcion'; campo: string; aviso: string | null; opciones: Opcion[] }
  | { tipo: 'tabla'; filas: { clave: string; valor: string }[] }
  /** La fecha es la de la firma: no entra en la huella (la prueba es la hora de la firma). */
  | { tipo: 'fecha'; plantilla: string; texto: string };

/** El bloque tal como entra en la huella y se guarda al firmar: la fecha, sin su texto. */
export type BloqueCanonico = Exclude<Bloque, { tipo: 'fecha' }> | { tipo: 'fecha'; plantilla: string };

export interface BloqueFirma {
  titulo: string;
  aviso: string | null;
  declaracion: string;
  huecos: { id: SignatureSlotId; etiqueta: string; subtitulo: string | null }[];
}

export interface Pagina {
  numero: number;
  bloques: Bloque[];
  firma: BloqueFirma | null;
}

export interface DocumentoRellenado {
  id: ReaderDocId;
  version: string;
  nombre: string;
  nota: string;
  membrete: typeof MEMBRETE;
  paginas: Pagina[];
  huella: string;
}

export interface ContextoDocumento {
  familia: FamiliaVia;
  cursoEscolar: string;
  config: MatriculaConfig;
  /** Día de la firma del documento (la primera) o, sin firmar, hoy. */
  fecha?: Date;
}

// ── Ayudas ───────────────────────────────────────────────────────────────────

const unir = (partes: string[], sep: string) => partes.map((p) => p.trim()).filter(Boolean).join(sep);

const FECHA = new Intl.DateTimeFormat('es-ES', { timeZone: env.TZ_CENTRO, day: 'numeric', month: 'long', year: 'numeric' });
const fecha = (plantilla: string, d: Date): Bloque => ({ tipo: 'fecha', plantilla, texto: plantilla.replace('{fecha}', FECHA.format(d)) });

const t = (tipo: 'titulo' | 'subtitulo' | 'parrafo' | 'nota', texto: string): Bloque => ({ tipo, texto });

/** «1º Bachillerato», «2º Ciclos Concertados (GS)». */
export function etiquetaCurso(exp: Expediente): string {
  if (exp.via === null) return '';
  return unir([exp.course ? `${exp.course}º` : '', ETIQUETA_VIA[exp.via]], ' ');
}

/** Domicilio del titular y familiar: el familiar si se indicó; si no, el de la alumna. */
const domicilio = (exp: Expediente) => (exp.family.address.address.trim() ? exp.family.address : exp.student);

const firma = (titulo: string, huecos: SignatureSlotId[], o: { aviso?: string; subtitulo?: string } = {}): BloqueFirma => ({
  titulo,
  aviso: o.aviso ?? null,
  declaracion: DECLARACION_LECTURA,
  huecos: huecos.map((id) => ({ id, etiqueta: HUECOS[id], subtitulo: o.subtitulo ?? null })),
});

const pagina = (numero: number, bloques: Bloque[], f: BloqueFirma | null = null): Pagina => ({ numero, bloques, firma: f });

function grupoAlumna(exp: Expediente, etiquetaCursoCampo: string): Bloque {
  return {
    tipo: 'campos',
    titulo: CAMPOS.student,
    campos: [
      { etiqueta: CAMPOS.studentFirstSurname, valor: exp.student.firstSurname, campo: 'student.firstSurname' },
      { etiqueta: CAMPOS.studentSecondSurname, valor: exp.student.secondSurname, campo: 'student.secondSurname' },
      { etiqueta: CAMPOS.studentName, valor: exp.student.firstName, campo: 'student.firstName' },
      { etiqueta: etiquetaCursoCampo, valor: etiquetaCurso(exp) },
    ],
  };
}

function grupoTitular(exp: Expediente): Bloque {
  const d = domicilio(exp);
  return {
    tipo: 'campos',
    titulo: CAMPOS.holder,
    campos: [
      { etiqueta: CAMPOS.holderName, valor: exp.economic.sepa.holder, campo: 'economic.sepa.holder', ancho: 'ancho' },
      { etiqueta: CAMPOS.holderDocument, valor: exp.economic.sepa.holderDocument, campo: 'economic.sepa.holderDocument' },
      { etiqueta: CAMPOS.holderAddress, valor: d.address, ancho: 'completo' },
      { etiqueta: CAMPOS.municipality, valor: d.municipality },
      { etiqueta: CAMPOS.province, valor: d.province },
      { etiqueta: CAMPOS.postalCode, valor: d.postalCode, ancho: 'estrecho' },
      { etiqueta: CAMPOS.country, valor: CAMPOS.countryValue, ancho: 'estrecho' },
    ],
  };
}

function grupoAcreedor(ctx: ContextoDocumento, quien: FamiliaVia | 'PLUS'): Bloque {
  const a = acreedorDe(ctx.config, quien);
  return {
    tipo: 'campos',
    titulo: SEPA.acreedor,
    campos: [
      { etiqueta: SEPA.acreedorId, valor: a.identificador },
      { etiqueta: SEPA.acreedorNombre, valor: a.nombre },
      { etiqueta: SEPA.acreedorDireccion, valor: a.direccion, ancho: 'completo' },
    ],
  };
}

function autorizaciones(exp: Expediente, ids: LopdAuthorizationId[]): Bloque {
  return {
    tipo: 'casillas',
    opciones: ids.map((id) => {
      const marcada = exp.lopd.authorizations[id] === true;
      return { ...LOPD.autorizaciones[id], marcada, estado: marcada ? AUTORIZA : NO_AUTORIZA, campo: `lopd.authorizations.${id}` };
    }),
  };
}

// ── Documentos ───────────────────────────────────────────────────────────────

function impreso(exp: Expediente, ctx: ContextoDocumento, hoy: Date): Pagina[] {
  const etiquetas = isBachillerato(exp.via) ? IMPRESO.etiquetasTutores.bach : IMPRESO.etiquetasTutores.ciclo;
  const d = domicilio(exp);
  return [
    pagina(
      1,
      [
        t('titulo', IMPRESO.titulo(ctx.cursoEscolar.replace(/^(\d{4})-\d{2}(\d{2})$/, '$1/$2'))),
        t('parrafo', IMPRESO.intro),
        {
          tipo: 'campos',
          titulo: CAMPOS.student,
          campos: [
            { etiqueta: CAMPOS.surnames, valor: unir([exp.student.firstSurname, exp.student.secondSurname], ' ') },
            { etiqueta: CAMPOS.name, valor: exp.student.firstName },
            { etiqueta: CAMPOS.birthDate, valor: exp.student.birthDate },
            { etiqueta: CAMPOS.document, valor: exp.student.document },
            { etiqueta: CAMPOS.courseGroup, valor: etiquetaCurso(exp) },
          ],
        },
        {
          tipo: 'campos',
          titulo: IMPRESO.tutores,
          campos: [
            { etiqueta: etiquetas[0]!, valor: exp.family.guardians[0].fullName },
            { etiqueta: etiquetas[1]!, valor: exp.family.guardians[1].fullName },
            { etiqueta: IMPRESO.domicilioFamiliar, valor: unir([d.address, unir([d.postalCode, d.municipality], ' ')], ' · '), ancho: 'completo' },
          ],
        },
        t('subtitulo', IMPRESO.declaracionTitulo),
        t('parrafo', IMPRESO.declaracion),
        t('nota', IMPRESO.nota),
        fecha(FECHA_SEVILLA, hoy),
      ],
      firma(IMPRESO.firmaTitulo, ['impreso-titular']),
    ),
  ];
}

function ideario(exp: Expediente, hoy: Date): Pagina[] {
  const via = exp.via === null ? '' : ETIQUETA_VIA[exp.via];
  const curso = exp.course ? `${exp.course}º` : '';
  const opciones: Opcion[] = idearioPoints(exp.via).map((id, i) => {
    const marcada = exp.ideario.answers[id] !== false;
    const motivo = exp.ideario.reasons[id]?.trim() ?? '';
    const etiqueta = id === 'outings' ? IDEARIO.puntos.outings.etiqueta(i + 1, IDEARIO.cursoDe(curso, via)) : IDEARIO.puntos[id].etiqueta(i + 1);
    const texto =
      id === 'outings'
        ? isBachillerato(exp.via) && exp.course === '1'
          ? IDEARIO.puntos.outings.textoConEf
          : IDEARIO.puntos.outings.texto
        : IDEARIO.puntos[id].texto;
    const [si, no] = id === 'outings' ? [AUTORIZA, NO_AUTORIZA] : [IDEARIO.acepta, IDEARIO.noAcepta];
    return { etiqueta, texto, marcada, estado: marcada ? si : no, ...(!marcada && motivo ? { motivo: IDEARIO.motivo(motivo) } : {}) };
  });
  return [
    pagina(
      1,
      [
        t('titulo', IDEARIO.titulo),
        {
          tipo: 'campos',
          titulo: null,
          campos: [
            { etiqueta: CAMPOS.fullName, valor: unir([exp.student.firstName, exp.student.firstSurname, exp.student.secondSurname], ' '), ancho: 'completo' },
            { etiqueta: CAMPOS.courseGroup, valor: etiquetaCurso(exp), ancho: 'completo' },
          ],
        },
        t('nota', IDEARIO.desdeAsistente),
        { tipo: 'casillas', opciones },
        t('nota', IDEARIO.nota),
        fecha(IDEARIO.fecha, hoy),
      ],
      firma(IDEARIO.firmaTitulo, ['ideario-titular'], { subtitulo: IDEARIO.firmaSub }),
    ),
  ];
}

const huecosLopd = (n: number) => READER_DOCS.lopd.slots.filter((s) => ({ 4: ['lopd-padre', 'lopd-madre'], 5: ['lopd-img-padre', 'lopd-img-madre'], 6: ['lopd-pd-padre', 'lopd-pd-madre'] })[n]?.includes(s));

function lopd(exp: Expediente, hoy: Date): Pagina[] {
  const etiquetas = isBachillerato(exp.via) ? IMPRESO.etiquetasTutores.bach : IMPRESO.etiquetasTutores.ciclo;
  const firmaLopd = (n: number) => firma(LOPD.firmaTitulos[n]!, huecosLopd(n), { aviso: AMBAS_FIRMAS });
  return [
    pagina(1, [t('titulo', LOPD.politicaTitulo), ...LOPD.politica.map((p) => t('parrafo', p)), t('subtitulo', LOPD.derechosTitulo), t('parrafo', LOPD.derechos)]),
    pagina(2, [
      t('titulo', LOPD.manifestacionesTitulo),
      ...LOPD.manifestaciones.flatMap((m) => [t('subtitulo', m.titulo), t('parrafo', m.texto)]),
      t('nota', LOPD.manifestacionesNota),
    ]),
    pagina(3, [
      t('titulo', LOPD.autorizacionesTitulo),
      t('parrafo', LOPD.autorizacionesIntro),
      autorizaciones(exp, LOPD.grupos.pagina3),
      t('subtitulo', LOPD.dopTitulo),
      t('parrafo', LOPD.dopTexto),
      {
        tipo: 'opcion',
        campo: 'lopd.dop',
        aviso: exp.lopd.dop === null ? LOPD.dopObligatoria : null,
        opciones: [
          { ...LOPD.dopSi, marcada: exp.lopd.dop === true, valor: true },
          { ...LOPD.dopNo, marcada: exp.lopd.dop === false, valor: false },
        ].map(({ etiqueta, texto, marcada, valor }) => ({ etiqueta, texto, marcada, valor })),
      },
    ]),
    pagina(
      4,
      [
        t('titulo', LOPD.continuacionTitulo),
        t('subtitulo', LOPD.medicaTitulo),
        autorizaciones(exp, LOPD.grupos.medica),
        t('subtitulo', LOPD.comercialTitulo),
        autorizaciones(exp, LOPD.grupos.comercial),
      ],
      firmaLopd(4),
    ),
    pagina(
      5,
      [t('titulo', LOPD.imagenesTitulo), t('parrafo', LOPD.imagenesIntro), t('subtitulo', LOPD.imagenesAutorizamos), autorizaciones(exp, LOPD.grupos.imagenes), t('parrafo', LOPD.imagenesRevocacion)],
      firmaLopd(5),
    ),
    pagina(
      6,
      [
        t('titulo', LOPD.declaracionTitulo),
        t('parrafo', LOPD.declaracion),
        {
          tipo: 'campos',
          titulo: LOPD.identificacionTitulo,
          campos: [
            { etiqueta: CAMPOS.fullName, valor: unir([exp.student.firstName, exp.student.firstSurname, exp.student.secondSurname], ' '), ancho: 'ancho' },
            { etiqueta: CAMPOS.courseGroup, valor: etiquetaCurso(exp) },
            { etiqueta: etiquetas[0]!, valor: exp.family.guardians[0].fullName },
            { etiqueta: etiquetas[1]!, valor: exp.family.guardians[1].fullName },
          ],
        },
        fecha(FECHA_SEVILLA, hoy),
      ],
      firmaLopd(6),
    ),
    pagina(7, [t('titulo', LOPD.basicaTitulo), { tipo: 'tabla', filas: LOPD.basica }, t('nota', LOPD.basicaNota)]),
  ];
}

function importesSepa(exp: Expediente) {
  if (exp.via === 'gs') return SEPA.importes.gs;
  if (exp.via === 'gsp') return exp.course === '2' ? SEPA.importes.gspSegundo : SEPA.importes.gspPrimero;
  return SEPA.importes.bach;
}

function sepa(exp: Expediente, ctx: ContextoDocumento, hoy: Date): Pagina[] {
  const importes = importesSepa(exp);
  const tipo = sepaPaymentType(exp);
  const tipos = exp.via === 'gs' ? (['single'] as const) : (['monthly', 'single'] as const);
  return [
    pagina(
      1,
      [
        t('titulo', SEPA.titulo),
        t('subtitulo', SEPA.cabecera(etiquetaCurso(exp), ctx.cursoEscolar)),
        grupoAcreedor(ctx, ctx.familia),
        t('parrafo', SEPA.legal),
        grupoAlumna(exp, CAMPOS.course),
        grupoTitular(exp),
        {
          tipo: 'campos',
          titulo: CAMPOS.account,
          campos: [
            { etiqueta: CAMPOS.iban, valor: exp.economic.sepa.iban, campo: 'economic.sepa.iban', ancho: 'cuenta' },
            { etiqueta: CAMPOS.bic, valor: exp.economic.sepa.bic, campo: 'economic.sepa.bic' },
          ],
        },
        {
          tipo: 'opcion',
          campo: 'economic.sepa.paymentType',
          aviso: tipo === null ? SEPA.modalidadObligatoria : null,
          opciones: tipos.map((v) => ({
            etiqueta: SEPA.modalidades[v],
            texto: v === 'monthly' ? SEPA.textoMensual(importes.monthly) : SEPA.textoUnico(importes.single),
            marcada: tipo === v,
            valor: v,
          })),
        },
        t('nota', `${SEPA.notaPrefijo} ${tipo === 'single' ? SEPA.notaUnico(importes.single) : SEPA.notaMensual(importes.monthly)}`),
        fecha(FECHA_SEVILLA, hoy),
      ],
      firma(SEPA.firmaTitulo, ['sepa-titular']),
    ),
  ];
}

function plus(exp: Expediente, ctx: ContextoDocumento, hoy: Date): Pagina[] {
  return [
    pagina(
      1,
      [
        t('titulo', PLUS.titulo),
        t('parrafo', PLUS.intro),
        t('subtitulo', PLUS.beneficiosTitulo),
        t('parrafo', PLUS.beneficios),
        // Añadido por la API: es una orden de domiciliación y lleva el acreedor.
        grupoAcreedor(ctx, 'PLUS'),
        grupoAlumna(exp, CAMPOS.fullCourse),
        grupoTitular(exp),
        { tipo: 'campos', titulo: CAMPOS.account, campos: [{ etiqueta: CAMPOS.iban, valor: exp.economic.sepa.iban, campo: 'economic.sepa.iban', ancho: 'cuenta' }] },
        t('nota', PLUS.nota),
        fecha(PLUS.fecha, hoy),
      ],
      firma(PLUS.firmaTitulo, ['plus-titular']),
    ),
  ];
}

// ── Huella ───────────────────────────────────────────────────────────────────

/** Lo que entra en la huella: todo menos el texto de la fecha (se deja su plantilla). */
function contenidoCanonico(d: Omit<DocumentoRellenado, 'huella'>) {
  return {
    id: d.id,
    version: d.version,
    paginas: d.paginas.map((p) => ({
      ...p,
      bloques: p.bloques.map((b): BloqueCanonico => (b.tipo === 'fecha' ? { tipo: 'fecha', plantilla: b.plantilla } : b)),
    })),
  };
}

export const huellaDe = (d: Omit<DocumentoRellenado, 'huella'>) => createHash('sha256').update(jsonCanonico(contenidoCanonico(d))).digest('hex');

export function generarDocumento(doc: ReaderDocId, exp: Expediente, ctx: ContextoDocumento): DocumentoRellenado {
  const hoy = ctx.fecha ?? new Date();
  const paginas =
    doc === 'impreso' ? impreso(exp, ctx, hoy) : doc === 'ideario' ? ideario(exp, hoy) : doc === 'lopd' ? lopd(exp, hoy) : doc === 'sepa' ? sepa(exp, ctx, hoy) : plus(exp, ctx, hoy);
  const nota = doc === 'sepa' && exp.via === 'gs' ? NOTA_SEPA_GS : DOCUMENTOS[doc].nota;
  const base = { id: doc, version: VERSIONES[doc], nombre: DOCUMENTOS[doc].nombre, nota, membrete: MEMBRETE, paginas };
  return { ...base, huella: huellaDe(base) };
}

/** Lo que se guarda al firmar: el documento tal como se firmó, sin la fecha (va en la firma). */
export const contenidoFirmado = (d: DocumentoRellenado) => contenidoCanonico(d);
export type ContenidoFirmado = ReturnType<typeof contenidoCanonico>;

// ── Qué cambió ───────────────────────────────────────────────────────────────

/** Etiqueta → valor visible de cada campo y casilla del documento. */
function valores(paginas: { bloques: BloqueCanonico[] }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of paginas) {
    for (const b of p.bloques) {
      if (b.tipo === 'campos') for (const c of b.campos) m.set(c.etiqueta, c.valor);
      if (b.tipo === 'casillas' || b.tipo === 'opcion') for (const o of b.opciones) m.set(o.etiqueta, `${o.marcada}|${o.motivo ?? ''}`);
    }
  }
  return m;
}

/**
 * Qué cambió entre lo firmado y el documento actual, en palabras del documento:
 * «Número de cuenta · IBAN, Nombre completo del titular». Para «Hay que volver a firmar: cambió …».
 */
export function cambiosEntre(antes: ContenidoFirmado, ahora: DocumentoRellenado): string[] {
  if (antes.version !== ahora.version) return ['el texto del documento (versión nueva)'];
  const a = valores(antes.paginas);
  const b = valores(ahora.paginas);
  const cambiados = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  return cambiados.length ? cambiados : ['el contenido del documento'];
}
