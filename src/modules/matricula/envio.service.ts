import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env';
import { enviarEvento } from '../../correo/enviar';
import { boton, lista } from '../../correo/plantillas';
import { alumnas, documentosMatricula, firmasMatricula, matriculaEventos, matriculas, pdfsMatricula, solicitudes, usuarios, type Matricula } from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import { db, type Tx } from '../../lib/db';
import { AppError, conflict, notFound } from '../../lib/errors';
import { almacen } from '../../lib/storage';
import { matriculaConfig } from '../ajustes/ajustes.service';
import { estadoPorMatricula } from '../alumnado/alumnado.service';
import { cambiarEstado } from '../solicitudes/comun';
import { ETAPA, cursoEscolarCorto, nombreVia } from '../solicitudes/dominio';
import { cargarArchivos } from './archivos.service';
import { generarPdf } from './documentos/pdf';
import { DOCUMENTOS } from './documentos/textos';
import { cargarFirmas, evaluarFirmas, type Firmante } from './firmas.service';
import { cargar, correoPrincipal, deToken, detalle, expediente, versionAntigua, vistaPublica } from './matricula.service';
import { canSubmit, pendientes, readerDocsFor, type ReaderDocId } from './reglas';
import type { FilaSeneca } from './seneca';

/**
 * Envío de la matrícula, devolución a borrador, PDF finales y exportación a Séneca
 * (docs/matricula.md, puntos 1, 5, 8 y 9).
 *
 *  BORRADOR ──enviar──▶ ENVIADA ──exportar a Séneca──▶ EXPORTADA
 *      ▲                   │
 *      └────devolver───────┘  (secretaría, con motivo)
 */

export const enviarBody = z.object({
  /** La versión del borrador que se está viendo: se envía exactamente eso. */
  version: z.number().int().min(1),
});

export const devolverBody = z.object({
  motivo: z.string().trim().min(1, 'Indica qué tiene que corregir la familia.').max(1000),
  /** Envía MATRICULA_DEVUELTA a la familia con el motivo. */
  avisar: z.boolean().default(true),
});

export const exportarBody = z.object({ matriculaIds: z.array(z.string().uuid()).min(1).max(300) });

/** El borrador completo (firmas que valen y archivos) y la evaluación de sus firmas. */
async function completa(tx: Tx, m: Matricula) {
  const archivos = await cargarArchivos(tx, [m.id]);
  const ev = evaluarFirmas(m, expediente(m, {}, archivos), await cargarFirmas(tx, [m.id]), { config: await matriculaConfig(tx) });
  return { exp: expediente(m, ev.signatures, archivos), ev };
}

async function nombreAlumna(tx: Tx, alumnaId: string) {
  const [a] = await tx.select({ nombre: alumnas.nombre, apellidos: alumnas.apellidos, expediente: alumnas.expediente }).from(alumnas).where(eq(alumnas.id, alumnaId));
  return { nombre: `${a!.nombre} ${a!.apellidos}`.trim(), expediente: a!.expediente };
}

/** Correo de la familia: el del contacto principal o, si no hay, el de la madre o tutora del borrador. */
async function correoFamilia(tx: Tx, m: Matricula) {
  return (await correoPrincipal(tx, m.alumnaId)) ?? (m.datos.family.guardians[0].email.trim() || null);
}

// ── Envío ────────────────────────────────────────────────────────────────────

/** Genera y guarda el PDF de cada documento firmado. Devuelve los adjuntos para el correo. */
async function generarPdfs(tx: Tx, m: Matricula, ev: Awaited<ReturnType<typeof completa>>['ev'], docs: ReaderDocId[], alumna: string) {
  const adjuntos: { filename: string; content: string; contentType: string; nombre: string }[] = [];
  for (const doc of docs) {
    // En serie a propósito (trampa 4): todo va en la transacción del envío.
    const validas = ev.validas.filter((f) => f.documento === doc);
    // AlbaydarPLUS en GS puede ir «entregado en papel» (p1): sin firmas, no hay PDF que generar.
    if (!validas.length) continue;
    const huella = validas[0]!.huella;
    const [contenido] = await tx
      .select({ c: documentosMatricula.contenido })
      .from(documentosMatricula)
      .where(and(eq(documentosMatricula.matriculaId, m.id), eq(documentosMatricula.huella, huella)));
    const filas = await tx
      .select({ f: firmasMatricula, usuario: usuarios.nombre })
      .from(firmasMatricula)
      .leftJoin(usuarios, eq(usuarios.id, firmasMatricula.usuarioId))
      .where(inArray(firmasMatricula.id, validas.map((v) => v.id)));
    const pdf = await generarPdf({
      contenido: contenido!.c,
      huella,
      matricula: { codigo: m.codigo, cursoEscolar: m.cursoEscolar },
      alumna,
      paginasLeidas: m.paginasLeidas,
      firmas: filas.map(({ f, usuario }) => {
        const v = validas.find((x) => x.id === f.id)!;
        return {
          hueco: f.hueco as never,
          imagen: f.imagen,
          imagenSha256: f.imagenSha256,
          firmadaEn: f.firmadaEn,
          ip: f.ip,
          userAgent: f.userAgent,
          enlace: f.enlaceId && v.alcance ? { id: f.enlaceId, alcance: v.alcance, progenitor: v.progenitor } : null,
          usuario,
        };
      }),
    });
    const clave = `matriculas/${m.id}/pdf/${doc}-${randomUUID()}.pdf`;
    await almacen.guardar(clave, pdf);
    await tx.insert(pdfsMatricula).values({ matriculaId: m.id, documento: doc, huella, clave, sha256: sha256(pdf), tamano: pdf.length });
    adjuntos.push({ filename: `${m.codigo}-${doc}.pdf`, content: pdf.toString('base64'), contentType: 'application/pdf', nombre: DOCUMENTOS[doc].nombre });
  }
  return adjuntos;
}

async function enviar(tx: Tx, m: Matricula, version: number, quien: Firmante) {
  if (m.estado !== 'BORRADOR') throw conflict('MATRICULA_ENVIADA', 'La matrícula ya está enviada.');
  if (quien.enlace?.alcance === 'PROGENITOR') throw new AppError(403, 'ENLACE_SIN_PERMISO', 'Con este enlace no se puede enviar la matrícula.');
  if (version !== m.version) throw await versionAntigua(tx, m);
  const { exp, ev } = await completa(tx, m);
  if (!canSubmit(exp)) {
    throw conflict('MATRICULA_INCOMPLETA', 'Falta algo para poder enviar la matrícula. Revisa los pasos marcados.', { pendientes: pendientes(exp) });
  }

  const alumna = await nombreAlumna(tx, m.alumnaId);
  const adjuntos = await generarPdfs(tx, m, ev, readerDocsFor(exp), alumna.nombre);
  await tx.update(matriculas).set({ estado: 'ENVIADA', enviadaEn: new Date(), devueltaEn: null, motivoDevolucion: null }).where(eq(matriculas.id, m.id));
  await tx.insert(matriculaEventos).values({
    matriculaId: m.id,
    tipo: 'ENVIADA',
    texto: `Matrícula enviada · ${adjuntos.length} documentos firmados en PDF`,
    actor: quien.enlace ? 'familia' : 'usuario',
    enlaceId: quien.enlace?.id ?? null,
    usuarioId: quien.usuarioId ?? null,
  });

  const vars = { codigo: m.codigo, alumna: alumna.nombre, tutor: '', curso: nombreVia(m.familia, m.curso), curso_escolar: cursoEscolarCorto(m.cursoEscolar) };
  const para = await correoFamilia(tx, m);
  if (para) {
    await enviarEvento(tx, 'MATRICULA_RECIBIDA', {
      para,
      vars: { ...vars, documentos: lista(adjuntos.map((a) => a.nombre)) },
      solicitudId: m.solicitudId ?? undefined,
      adjuntos: adjuntos.map(({ filename, content, contentType }) => ({ filename, content, contentType, base64: true })),
    });
  }
  if (quien.enlace && env.MAIL_SECRETARIA) {
    const enlace = `${env.PUBLIC_APP_URL}/enrollments/${m.id}`;
    await enviarEvento(tx, 'AVISO_MATRICULA_ENVIADA', { para: env.MAIL_SECRETARIA, vars: { ...vars, enlace, boton: boton(enlace, 'Abrir la matrícula') } });
  }
}

export async function enviarInterno(id: string, version: number, usuarioId: string) {
  return db.transaction(async (tx) => {
    await enviar(tx, await cargar(tx, id, true), version, { usuarioId });
    return detalle(id, tx);
  });
}

export async function enviarPublica(token: string, version: number) {
  return db.transaction(async (tx) => {
    const { e } = await deToken(token, tx);
    await enviar(tx, await cargar(tx, e.matriculaId, true), version, { enlace: e });
    return vistaPublica(tx, await cargar(tx, e.matriculaId), e);
  });
}

// ── Devolver a borrador ──────────────────────────────────────────────────────

export async function devolver(id: string, d: z.infer<typeof devolverBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const m = await cargar(tx, id, true);
    if (m.estado === 'EXPORTADA') throw conflict('MATRICULA_EXPORTADA', 'La matrícula ya está cargada en Séneca: no se puede devolver.');
    if (m.estado !== 'ENVIADA') throw conflict('MATRICULA_NO_ENVIADA', 'Solo se devuelve una matrícula enviada.');
    await tx.update(matriculas).set({ estado: 'BORRADOR', devueltaEn: new Date(), motivoDevolucion: d.motivo }).where(eq(matriculas.id, id));
    // Los PDF dejan de valer: al volver a enviarla se generan otros.
    await tx.update(pdfsMatricula).set({ anuladoEn: new Date() }).where(and(eq(pdfsMatricula.matriculaId, id), isNull(pdfsMatricula.anuladoEn)));
    await tx.insert(matriculaEventos).values({ matriculaId: id, tipo: 'DEVUELTA', texto: `Devuelta a la familia: ${d.motivo}`, actor: 'usuario', usuarioId });
    const para = d.avisar ? await correoFamilia(tx, m) : null;
    if (para) {
      const alumna = await nombreAlumna(tx, m.alumnaId);
      await enviarEvento(tx, 'MATRICULA_DEVUELTA', {
        para,
        vars: { codigo: m.codigo, alumna: alumna.nombre, tutor: '', curso: nombreVia(m.familia, m.curso), curso_escolar: cursoEscolarCorto(m.cursoEscolar), motivo: d.motivo },
        solicitudId: m.solicitudId ?? undefined,
      });
    }
    return detalle(id, tx);
  });
}

// ── PDF ──────────────────────────────────────────────────────────────────────

async function pdfDe(tx: Tx, m: Matricula, doc: ReaderDocId) {
  const [p] = await tx
    .select()
    .from(pdfsMatricula)
    .where(and(eq(pdfsMatricula.matriculaId, m.id), eq(pdfsMatricula.documento, doc), isNull(pdfsMatricula.anuladoEn)));
  if (!p) throw notFound('Ese documento aún no tiene PDF: se genera al enviar la matrícula.', 'PDF_NO_DISPONIBLE');
  return { datos: await almacen.leer(p.clave), nombre: `${m.codigo}-${doc}.pdf` };
}

export async function pdfInterno(id: string, doc: ReaderDocId) {
  return pdfDe(db, await cargar(db, id), doc);
}

/** La copia de la familia. Un enlace de progenitor solo descarga la LOPD. */
export async function pdfPublico(token: string, doc: ReaderDocId) {
  const { e, m } = await deToken(token);
  if (e.alcance === 'PROGENITOR' && doc !== 'lopd') throw new AppError(403, 'ENLACE_SIN_PERMISO', 'Con este enlace solo se puede descargar la información de protección de datos.');
  return pdfDe(db, m, doc);
}

// ── Séneca ───────────────────────────────────────────────────────────────────

/**
 * Exporta a Séneca: devuelve las filas del fichero y, la primera vez, deja cada matrícula
 * EXPORTADA, la alumna «Matriculada» en su curso nuevo y la solicitud de origen MATRICULADA, y
 * envía MATRICULA_CONFIRMADA. Todo o nada: si una no se puede exportar, no se exporta ninguna.
 */
export async function exportarSeneca(ids: string[], usuarioId: string): Promise<FilaSeneca[]> {
  return db.transaction(async (tx) => {
    const filas: FilaSeneca[] = [];
    const sinEnviar: string[] = [];
    const incompletas: string[] = [];
    for (const id of [...new Set(ids)]) {
      // En serie a propósito (trampa 4).
      const m = await cargar(tx, id, true);
      if (m.estado === 'BORRADOR') {
        sinEnviar.push(m.codigo);
        continue;
      }
      const { exp } = await completa(tx, m);
      if (!canSubmit(exp)) {
        incompletas.push(m.codigo);
        continue;
      }
      const alumna = await nombreAlumna(tx, m.alumnaId);
      filas.push({ m, exp, expediente: alumna.expediente });
      if (m.estado === 'EXPORTADA') {
        await tx.insert(matriculaEventos).values({ matriculaId: id, tipo: 'SENECA', texto: 'Fichero de Séneca generado de nuevo', actor: 'usuario', usuarioId });
        continue;
      }

      await tx.update(matriculas).set({ estado: 'EXPORTADA', exportadaEn: new Date() }).where(eq(matriculas.id, id));
      await tx.insert(matriculaEventos).values({ matriculaId: id, tipo: 'EXPORTADA', texto: 'Exportada a Séneca: la alumna queda matriculada', actor: 'usuario', usuarioId });
      await estadoPorMatricula(tx, m.alumnaId, 'MATRICULADA', `matrícula ${m.codigo} exportada a Séneca`, usuarioId, {
        familia: m.familia,
        curso: m.curso,
        cursoEscolar: m.cursoEscolar,
      });
      if (m.solicitudId) {
        const [s] = await tx.select({ id: solicitudes.id, estado: solicitudes.estado }).from(solicitudes).where(eq(solicitudes.id, m.solicitudId)).for('update');
        if (s?.estado === 'PLAZA_RESERVADA') await cambiarEstado(tx, s, 'MATRICULADA', { tipo: 'usuario', usuarioId }, 'MATRICULADA', { matricula: m.codigo });
      }
      const para = await correoFamilia(tx, m);
      if (para) {
        await enviarEvento(tx, 'MATRICULA_CONFIRMADA', {
          para,
          vars: { codigo: m.codigo, alumna: alumna.nombre, tutor: '', curso: nombreVia(m.familia, m.curso), etapa: ETAPA[m.familia], curso_escolar: cursoEscolarCorto(m.cursoEscolar) },
          solicitudId: m.solicitudId ?? undefined,
        });
      }
    }
    if (sinEnviar.length) throw conflict('MATRICULA_NO_ENVIADA', `Estas matrículas aún no están enviadas: ${sinEnviar.join(', ')}.`, { codigos: sinEnviar });
    if (incompletas.length) {
      throw conflict('MATRICULA_INCOMPLETA', `A estas matrículas les falta algo (¿se cambió un dato firmado?): ${incompletas.join(', ')}. Devuélvelas a la familia.`, { codigos: incompletas });
    }
    return filas;
  });
}
