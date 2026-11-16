import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  documentosMatricula,
  enlacesMatricula,
  firmasMatricula,
  mandatosSepa,
  matriculaEventos,
  type EnlaceMatricula,
  type MandatoSepa,
  type Matricula,
} from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import type { Tx } from '../../lib/db';
import { bicValido, enmascararIban, ibanSepaValido, normalizarIban } from '../../lib/dinero';
import { documentoValido, normalizarDocumento } from '../../lib/documento-identidad';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { fechaLocal } from '../../lib/fechas';
import { tipoReal } from '../../lib/storage';
import { acreedorDe, matriculaConfig, type MatriculaConfig } from '../ajustes/ajustes.service';
import type { Expediente } from './borrador';
import { HUECOS_PROGENITOR, type Progenitor } from './dominio';
import { cambiosEntre, generarDocumento, contenidoFirmado, type ContenidoFirmado, type DocumentoRellenado } from './documentos/generar';
import { DOCUMENTOS, HUECOS } from './documentos/textos';
import {
  READER_DOCS,
  SIGNATURE_SLOTS,
  canSignDoc,
  readPageKey,
  readerDocsFor,
  sepaPaymentType,
  type ReaderDocId,
  type SignatureSlotId,
} from './reglas';

/**
 * Firmas de la matrícula (docs/matricula.md, puntos 1, 2 y 4).
 *
 *  - Una firma vale mientras la huella del documento que firmó coincida con la del documento
 *    actual. Mientras la matrícula es borrador, eso se comprueba en cada lectura; al guardar un
 *    cambio que altera un documento firmado, sus firmas se anulan (no se borran).
 *  - Firmar exige el documento aplicable, leído entero, con la DOP o la modalidad de pago elegidas,
 *    y la huella que el front tiene a la vista: si no coincide, 409 DOCUMENTO_CAMBIADO.
 *  - La firma de la orden SEPA y la de AlbaydarPLUS crean su mandato.
 */

export const huecoParam = z.enum(SIGNATURE_SLOTS);
export const docParam = z.enum(['impreso', 'ideario', 'lopd', 'sepa', 'plus']);

export const firmaBody = z.object({
  /** PNG en data URL, como lo da el lienzo del front. */
  imagen: z.string().max(300_000, 'La firma es demasiado grande.'),
  /** La huella del documento que se está viendo (GET …/documentos/:doc). */
  huella: z.string().regex(/^[0-9a-f]{64}$/, 'Huella no válida.'),
});

const MAX_FIRMA = 200 * 1024;

export const documentoDeHueco = (h: SignatureSlotId): ReaderDocId =>
  (Object.keys(READER_DOCS) as ReaderDocId[]).find((d) => READER_DOCS[d].slots.includes(h))!;

/** Quién firma o borra: la familia con su enlace o secretaría con la familia delante. */
export type Firmante = { enlace: EnlaceMatricula; usuarioId?: undefined } | { enlace?: undefined; usuarioId: string };
export interface Evidencias {
  ip: string | null;
  userAgent: string | null;
}

// ── Carga y evaluación ───────────────────────────────────────────────────────

const COLUMNAS = {
  id: firmasMatricula.id,
  matriculaId: firmasMatricula.matriculaId,
  hueco: firmasMatricula.hueco,
  documento: firmasMatricula.documento,
  version: firmasMatricula.version,
  huella: firmasMatricula.huella,
  firmadaEn: firmasMatricula.firmadaEn,
  enlaceId: firmasMatricula.enlaceId,
  usuarioId: firmasMatricula.usuarioId,
  anuladaEn: firmasMatricula.anuladaEn,
  motivoAnulacion: firmasMatricula.motivoAnulacion,
  alcance: enlacesMatricula.alcance,
  progenitor: enlacesMatricula.progenitor,
};

export type FilaFirma = Awaited<ReturnType<typeof cargarFirmas>>[number];

/** Firmas de varias matrículas (sin la imagen), las más recientes primero. */
export async function cargarFirmas(tx: Tx, matriculaIds: string[]) {
  if (!matriculaIds.length) return [];
  return tx
    .select(COLUMNAS)
    .from(firmasMatricula)
    .leftJoin(enlacesMatricula, eq(enlacesMatricula.id, firmasMatricula.enlaceId))
    .where(inArray(firmasMatricula.matriculaId, matriculaIds))
    .orderBy(desc(firmasMatricula.firmadaEn));
}

async function contenidos(tx: Tx, matriculaId: string): Promise<Map<string, ContenidoFirmado>> {
  const filas = await tx
    .select({ huella: documentosMatricula.huella, contenido: documentosMatricula.contenido })
    .from(documentosMatricula)
    .where(eq(documentosMatricula.matriculaId, matriculaId));
  return new Map(filas.map((f) => [f.huella, f.contenido]));
}

export type EstadoFirma = 'VALIDA' | 'DESACTUALIZADA' | 'ANULADA';

export interface VistaFirma {
  hueco: SignatureSlotId;
  documento: ReaderDocId;
  estado: EstadoFirma;
  firmadaEn: Date;
  /** Por qué ya no vale: «Cambió: Número de cuenta · IBAN». */
  motivo: string | null;
  /** FAMILIA, PROGENITOR (con `progenitor`) o null si firmó en secretaría. */
  enlace: { alcance: string; progenitor: string | null } | null;
  enSecretaria: boolean;
}

export interface Evaluacion {
  /** Las firmas que valen: lo que ven las reglas (`borrador.signatures`). */
  signatures: Partial<Record<SignatureSlotId, { signedAt: string }>>;
  validas: FilaFirma[];
  /** Firmas vigentes que ya no valen porque cambió su documento (se anulan al guardar). */
  desactualizadas: { fila: FilaFirma; motivo: string }[];
  /** La última firma de cada hueco, con su estado. */
  vista: VistaFirma[];
}

const motivoCambio = (cambios: string[]) => `Cambió: ${cambios.slice(0, 5).join(', ')}${cambios.length > 5 ? '…' : ''}`;
const MOTIVO_NO_APLICA = 'El documento ya no hace falta en esta matrícula';

export interface ContextoFirmas {
  config: MatriculaConfig;
  /** Lo firmado, para explicar qué cambió. Sin él, el motivo es genérico (listados). */
  contenidos?: Map<string, ContenidoFirmado>;
}

/**
 * Qué firmas valen. En borrador, solo las que firmaron el documento tal como es ahora; una vez
 * enviada, las vigentes (lo que cambie secretaría se revisa al guardar).
 */
export function evaluarFirmas(m: Matricula, base: Expediente, filas: FilaFirma[], ctx: ContextoFirmas): Evaluacion {
  const aplican = new Set(readerDocsFor(base));
  const docs = new Map<ReaderDocId, DocumentoRellenado>();
  const actual = (d: ReaderDocId) => {
    if (!docs.has(d)) docs.set(d, generarDocumento(d, base, { familia: m.familia, cursoEscolar: m.cursoEscolar, config: ctx.config }));
    return docs.get(d)!;
  };

  const r: Evaluacion = { signatures: {}, validas: [], desactualizadas: [], vista: [] };
  const vistos = new Set<string>();
  for (const f of filas) {
    if (vistos.has(f.hueco)) continue;
    vistos.add(f.hueco);
    const hueco = f.hueco as SignatureSlotId;
    const documento = f.documento as ReaderDocId;
    let estado: EstadoFirma = 'VALIDA';
    let motivo: string | null = null;
    if (f.anuladaEn) {
      estado = 'ANULADA';
      motivo = f.motivoAnulacion;
    } else if (m.estado === 'BORRADOR') {
      if (!aplican.has(documento)) {
        estado = 'DESACTUALIZADA';
        motivo = MOTIVO_NO_APLICA;
      } else if (actual(documento).huella !== f.huella) {
        estado = 'DESACTUALIZADA';
        const antes = ctx.contenidos?.get(f.huella);
        motivo = antes ? motivoCambio(cambiosEntre(antes, actual(documento))) : 'Cambió el documento';
      }
    }
    if (estado === 'VALIDA') {
      r.signatures[hueco] = { signedAt: f.firmadaEn.toISOString() };
      r.validas.push(f);
    } else if (estado === 'DESACTUALIZADA') {
      r.desactualizadas.push({ fila: f, motivo: motivo! });
    }
    r.vista.push({
      hueco,
      documento,
      estado,
      firmadaEn: f.firmadaEn,
      motivo,
      enlace: f.alcance ? { alcance: f.alcance, progenitor: f.progenitor } : null,
      enSecretaria: !!f.usuarioId,
    });
  }
  r.vista.sort((a, b) => SIGNATURE_SLOTS.indexOf(a.hueco) - SIGNATURE_SLOTS.indexOf(b.hueco));
  return r;
}

/** Todo lo de las firmas de una matrícula para su ficha. */
export async function firmasDe(tx: Tx, m: Matricula, base: Expediente) {
  const [filas, cs, config, mandatos] = [
    await cargarFirmas(tx, [m.id]),
    await contenidos(tx, m.id),
    await matriculaConfig(tx),
    await tx.select().from(mandatosSepa).where(eq(mandatosSepa.matriculaId, m.id)).orderBy(asc(mandatosSepa.createdAt)),
  ];
  return { evaluacion: evaluarFirmas(m, base, filas, { config, contenidos: cs }), mandatos };
}

export function vistaMandato(x: MandatoSepa, completo: boolean) {
  return {
    referencia: x.referencia,
    tipo: x.tipo,
    secuencia: x.secuencia,
    esquema: x.esquema,
    acreedor: { identificador: x.acreedorIdentificador, nombre: x.acreedorNombre },
    iban: completo ? x.iban : enmascararIban(x.iban),
    bic: x.bic,
    titular: x.titular,
    titularDocumento: completo ? x.titularDocumento : null,
    fechaFirma: x.fechaFirma,
    estado: x.estado,
    anulado: x.anuladoEn ? { en: x.anuladoEn, motivo: x.motivoAnulacion } : null,
  };
}

// ── Anular ───────────────────────────────────────────────────────────────────

type ActorEvento = { actor: 'familia' | 'usuario' | 'sistema'; usuarioId: string | null; enlaceId: string | null };

const actorDe = (q: Firmante | null): ActorEvento =>
  q === null ? { actor: 'sistema', usuarioId: null, enlaceId: null } : q.enlace ? { actor: 'familia', usuarioId: null, enlaceId: q.enlace.id } : { actor: 'usuario', usuarioId: q.usuarioId, enlaceId: null };

async function anular(tx: Tx, firmaId: string, motivo: string) {
  const ahora = new Date();
  await tx.update(firmasMatricula).set({ anuladaEn: ahora, motivoAnulacion: motivo }).where(and(eq(firmasMatricula.id, firmaId), isNull(firmasMatricula.anuladaEn)));
  await tx
    .update(mandatosSepa)
    .set({ estado: 'ANULADO', anuladoEn: ahora, motivoAnulacion: motivo })
    .where(and(eq(mandatosSepa.firmaId, firmaId), eq(mandatosSepa.estado, 'VIGENTE')));
}

/**
 * Tras guardar un borrador: anula las firmas cuyo documento cambió o ya no aplica, con el motivo,
 * y lo deja en el historial (un evento por documento). Devuelve los documentos afectados.
 */
export async function anularDesactualizadas(tx: Tx, m: Matricula, base: Expediente, quien: Firmante | null) {
  const filas = (await cargarFirmas(tx, [m.id])).filter((f) => !f.anuladaEn);
  if (!filas.length) return [];
  const ev = evaluarFirmas({ ...m, estado: 'BORRADOR' }, base, filas, { config: await matriculaConfig(tx), contenidos: await contenidos(tx, m.id) });
  const porDocumento = new Map<string, string>();
  for (const { fila, motivo } of ev.desactualizadas) {
    await anular(tx, fila.id, motivo);
    porDocumento.set(fila.documento, motivo);
  }
  const a = actorDe(quien);
  for (const [doc, motivo] of porDocumento) {
    await tx.insert(matriculaEventos).values({
      matriculaId: m.id,
      tipo: 'FIRMA_ANULADA',
      texto: `Hay que volver a firmar «${DOCUMENTOS[doc as ReaderDocId].nombre}». ${motivo}`,
      detalle: { documento: doc },
      ...a,
    });
  }
  return [...porDocumento.keys()];
}

// ── Firmar y borrar ──────────────────────────────────────────────────────────

function comprobarFirmante(m: Matricula, hueco: SignatureSlotId, quien: Firmante) {
  if (m.estado !== 'BORRADOR') throw conflict('MATRICULA_ENVIADA', 'La matrícula ya está enviada: no se puede firmar ni borrar firmas.');
  if (quien.enlace?.alcance === 'PROGENITOR' && !(HUECOS_PROGENITOR[quien.enlace.progenitor as Progenitor] as readonly string[]).includes(hueco)) {
    throw new AppError(403, 'ENLACE_SIN_PERMISO', 'Con este enlace solo se pueden firmar los huecos de su progenitor.');
  }
}

function imagenPng(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  const buf = m ? Buffer.from(m[1]!, 'base64') : null;
  // Firma de bytes y cabecera IHDR: lo mínimo para que el PDF final pueda dibujar el trazo.
  if (!buf || tipoReal(buf)?.mime !== 'image/png' || buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw badRequest('FIRMA_NO_VALIDA', 'La firma no es una imagen PNG válida.');
  }
  if (buf.length > MAX_FIRMA) throw badRequest('FIRMA_NO_VALIDA', 'La imagen de la firma supera 200 KB.');
  if (buf.length < 100) throw badRequest('FIRMA_NO_VALIDA', 'La firma está vacía.');
  return buf;
}

/** La orden SEPA y la de AlbaydarPLUS: la cuenta tiene que poder domiciliarse. */
function comprobarCuenta(exp: Expediente) {
  const s = exp.economic.sepa;
  const errores: string[] = [];
  if (!s.holder.trim()) errores.push('Falta el nombre del titular de la cuenta.');
  if (!documentoValido(normalizarDocumento(s.holderDocument))) errores.push('El DNI/NIE del titular no es válido: revisa los números y la letra.');
  if (!ibanSepaValido(s.iban)) errores.push('El IBAN no es válido o no es de un país de la zona SEPA.');
  if (s.bic.trim() && !bicValido(s.bic)) errores.push('El BIC no tiene un formato válido (8 u 11 caracteres).');
  if (errores.length) throw badRequest('DATOS_CUENTA_NO_VALIDOS', errores.join(' '), { errores });
}

/** Comprueba que el documento se puede firmar ahora. Devuelve el documento actual. */
function comprobarDocumento(m: Matricula, base: Expediente, doc: ReaderDocId, config: MatriculaConfig) {
  if (!readerDocsFor(base).includes(doc)) throw conflict('DOCUMENTO_NO_APLICA', `«${DOCUMENTOS[doc].nombre}» no forma parte de esta matrícula.`);
  const faltan = Array.from({ length: READER_DOCS[doc].pages }, (_, i) => readPageKey(doc, i + 1)).filter((k) => base.readPages[k] !== true);
  if (faltan.length) throw conflict('DOCUMENTO_SIN_LEER', 'Hay que leer el documento entero antes de firmar.', { faltan });
  if (!canSignDoc(base, doc)) {
    throw conflict('FALTAN_DATOS', doc === 'lopd' ? 'Elige una opción del Departamento de Orientación (DOP) antes de firmar.' : 'Elige la modalidad de pago antes de firmar.');
  }
  if (doc === 'sepa' || doc === 'plus') comprobarCuenta(base);
  return generarDocumento(doc, base, { familia: m.familia, cursoEscolar: m.cursoEscolar, config });
}

async function crearMandato(tx: Tx, m: Matricula, base: Expediente, firmaId: string, doc: 'sepa' | 'plus', config: MatriculaConfig) {
  const tipo = doc === 'sepa' ? 'SEPA' : 'PLUS';
  const [previos] = await tx.select({ n: count() }).from(mandatosSepa).where(and(eq(mandatosSepa.matriculaId, m.id), eq(mandatosSepa.tipo, tipo)));
  const referencia = `${m.codigo}-${tipo}${(previos?.n ?? 0) + 1}`;
  const acreedor = acreedorDe(config, tipo === 'PLUS' ? 'PLUS' : m.familia);
  const s = base.economic.sepa;
  await tx.insert(mandatosSepa).values({
    matriculaId: m.id,
    firmaId,
    referencia,
    tipo,
    secuencia: tipo === 'SEPA' && sepaPaymentType(base) === 'single' ? 'OOFF' : 'RCUR',
    acreedorIdentificador: acreedor.identificador,
    acreedorNombre: acreedor.nombre,
    iban: normalizarIban(s.iban),
    bic: s.bic.trim() ? s.bic.replace(/\s/g, '').toUpperCase() : null,
    titular: s.holder.trim(),
    titularDocumento: normalizarDocumento(s.holderDocument),
    fechaFirma: fechaLocal(new Date()),
  });
  return referencia;
}

/**
 * Firma un hueco. `m` viene bloqueada (FOR UPDATE) y `base` es su borrador con las páginas leídas.
 * Si el hueco ya tenía firma, la anterior se anula («Firmada de nuevo»).
 */
export async function firmar(tx: Tx, m: Matricula, base: Expediente, hueco: SignatureSlotId, d: z.infer<typeof firmaBody>, quien: Firmante, ev: Evidencias) {
  comprobarFirmante(m, hueco, quien);
  const imagen = imagenPng(d.imagen);
  const doc = documentoDeHueco(hueco);
  const config = await matriculaConfig(tx);
  const documento = comprobarDocumento(m, base, doc, config);
  if (documento.huella !== d.huella) {
    throw conflict('DOCUMENTO_CAMBIADO', 'El documento ha cambiado mientras lo leías. Vuelve a cargarlo y revísalo antes de firmar.', { huella: documento.huella });
  }

  await tx
    .insert(documentosMatricula)
    .values({ matriculaId: m.id, documento: doc, version: documento.version, huella: documento.huella, contenido: contenidoFirmado(documento) })
    .onConflictDoNothing();
  const [previa] = await tx
    .select({ id: firmasMatricula.id })
    .from(firmasMatricula)
    .where(and(eq(firmasMatricula.matriculaId, m.id), eq(firmasMatricula.hueco, hueco), isNull(firmasMatricula.anuladaEn)));
  if (previa) await anular(tx, previa.id, 'Firmada de nuevo');

  const [f] = await tx
    .insert(firmasMatricula)
    .values({
      matriculaId: m.id,
      hueco,
      documento: doc,
      version: documento.version,
      huella: documento.huella,
      imagen,
      imagenSha256: sha256(imagen),
      ip: ev.ip,
      userAgent: ev.userAgent?.slice(0, 500) ?? null,
      enlaceId: quien.enlace?.id ?? null,
      usuarioId: quien.usuarioId ?? null,
    })
    .returning({ id: firmasMatricula.id });
  const referencia = doc === 'sepa' || doc === 'plus' ? await crearMandato(tx, m, base, f!.id, doc, config) : null;

  await tx.insert(matriculaEventos).values({
    matriculaId: m.id,
    tipo: 'FIRMADA',
    texto: `${DOCUMENTOS[doc].nombre} · ${HUECOS[hueco].toLowerCase()}${referencia ? ` · mandato ${referencia}` : ''}`,
    detalle: { hueco, documento: doc, huella: documento.huella, ...(referencia ? { mandato: referencia } : {}) },
    ...actorDe(quien),
  });
}

/** «Borrar» la firma de un hueco: se anula con motivo, no se borra. */
export async function borrar(tx: Tx, m: Matricula, hueco: SignatureSlotId, quien: Firmante) {
  comprobarFirmante(m, hueco, quien);
  const [f] = await tx
    .select({ id: firmasMatricula.id, documento: firmasMatricula.documento })
    .from(firmasMatricula)
    .where(and(eq(firmasMatricula.matriculaId, m.id), eq(firmasMatricula.hueco, hueco), isNull(firmasMatricula.anuladaEn)));
  if (!f) throw notFound('Ese hueco no tiene firma.', 'FIRMA_NO_ENCONTRADA');
  await anular(tx, f.id, 'Borrada');
  await tx.insert(matriculaEventos).values({
    matriculaId: m.id,
    tipo: 'FIRMA_BORRADA',
    texto: `${DOCUMENTOS[f.documento as ReaderDocId].nombre} · ${HUECOS[hueco].toLowerCase()}`,
    detalle: { hueco, documento: f.documento },
    ...actorDe(quien),
  });
}

// ── Ver un documento ─────────────────────────────────────────────────────────

/**
 * El documento rellenado, con las firmas que valen (con su imagen), lo que falta por leer y si se
 * puede firmar ya. Un enlace de progenitor solo ve la LOPD. La fecha es la de la primera firma
 * válida del documento o, sin firmar, hoy.
 */
export async function documento(tx: Tx, m: Matricula, base: Expediente, doc: ReaderDocId, enlace: EnlaceMatricula | null) {
  if (enlace?.alcance === 'PROGENITOR' && doc !== 'lopd') {
    throw new AppError(403, 'ENLACE_SIN_PERMISO', 'Con este enlace solo se puede ver la información de protección de datos.');
  }
  if (!readerDocsFor(base).includes(doc)) throw notFound(`«${DOCUMENTOS[doc].nombre}» no forma parte de esta matrícula.`, 'DOCUMENTO_NO_APLICA');
  const config = await matriculaConfig(tx);
  const ev = evaluarFirmas(m, base, await cargarFirmas(tx, [m.id]), { config });
  const validas = ev.validas.filter((f) => f.documento === doc);
  const primera = validas.reduce<Date | undefined>((min, f) => (!min || f.firmadaEn < min ? f.firmadaEn : min), undefined);
  const generado = generarDocumento(doc, base, { familia: m.familia, cursoEscolar: m.cursoEscolar, config, fecha: primera });

  const imagenes = validas.length
    ? await tx
        .select({ hueco: firmasMatricula.hueco, imagen: firmasMatricula.imagen, firmadaEn: firmasMatricula.firmadaEn })
        .from(firmasMatricula)
        .where(inArray(firmasMatricula.id, validas.map((f) => f.id)))
    : [];
  const paginas = Array.from({ length: READER_DOCS[doc].pages }, (_, i) => readPageKey(doc, i + 1));
  return {
    ...generado,
    paginasLeidas: paginas.filter((k) => base.readPages[k] === true),
    puedeFirmar: m.estado === 'BORRADOR' && canSignDoc(base, doc),
    firmas: Object.fromEntries(
      imagenes.map((f) => [f.hueco, { firmadaEn: f.firmadaEn, imagen: `data:image/png;base64,${f.imagen.toString('base64')}` }]),
    ),
  };
}
