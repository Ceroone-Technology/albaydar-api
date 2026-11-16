import PDFDocument from 'pdfkit';
import { env } from '../../../config/env';
import type { ReaderDocId, SignatureSlotId } from '../reglas';
import type { BloqueCanonico, ContenidoFirmado } from './generar';
import { DOCUMENTOS, HUECOS, MEMBRETE } from './textos';

/**
 * PDF final de un documento firmado (docs/matricula.md, punto 1): el documento tal como se firmó,
 * los trazos en su sitio y una hoja de evidencias. Se genera al enviar la matrícula.
 *
 * Se parte de lo guardado al firmar (`documentos_matricula`), no del borrador de ahora: el PDF
 * dice exactamente lo que se firmó. Fuente Helvetica (WinAnsi: tildes, ñ, «», €, º, ·, —).
 */

export interface FirmaPdf {
  hueco: SignatureSlotId;
  imagen: Buffer;
  imagenSha256: string;
  firmadaEn: Date;
  ip: string | null;
  userAgent: string | null;
  enlace: { id: string; alcance: string; progenitor: string | null } | null;
  /** Quién de secretaría estaba delante, si firmó allí. */
  usuario: string | null;
}

export interface DatosPdf {
  contenido: ContenidoFirmado;
  huella: string;
  matricula: { codigo: string; cursoEscolar: string };
  alumna: string;
  firmas: FirmaPdf[];
  /** Página → primera vez que se marcó como leída (ISO). */
  paginasLeidas: Record<string, string>;
}

const TZ = { timeZone: env.TZ_CENTRO };
const FECHA_LARGA = new Intl.DateTimeFormat('es-ES', { ...TZ, day: 'numeric', month: 'long', year: 'numeric' });
const FECHA_HORA = new Intl.DateTimeFormat('es-ES', { ...TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fechaHora = (d: Date) => `${FECHA_HORA.format(d).replace(',', '')} (hora de Madrid)`;

const GRIS = '#5f6672';
const ROJO = '#9C0026';

function origen(f: FirmaPdf): string {
  if (f.usuario) return `En secretaría, con ${f.usuario} delante`;
  if (!f.enlace) return 'Sin datos';
  const quien = f.enlace.alcance === 'PROGENITOR' ? `enlace propio del ${f.enlace.progenitor === 'madre' ? 'progenitor (madre)' : 'progenitor (padre)'}` : 'enlace de la familia';
  return `Desde el ${quien} · id ${f.enlace.id}`;
}

/** «Páginas 1 a 7 marcadas como leídas en el navegador (primera marca …, última …)». Nunca «ha leído». */
function frasePaginas(doc: ReaderDocId, total: number, leidas: Record<string, string>): string {
  const marcas = Array.from({ length: total }, (_, i) => leidas[`${doc}-${i + 1}`]).filter((x): x is string => !!x).map((x) => new Date(x));
  if (!marcas.length) return 'No consta ninguna página marcada como leída.';
  const orden = marcas.sort((a, b) => a.getTime() - b.getTime());
  const paginas = total === 1 ? 'Página 1 marcada' : `Páginas 1 a ${total} marcadas`;
  const rango = orden.length === 1 ? `marca: ${fechaHora(orden[0]!)}` : `primera marca: ${fechaHora(orden[0]!)}; última: ${fechaHora(orden.at(-1)!)}`;
  return `${paginas} como leídas en el navegador (${rango}).`;
}

export function generarPdf(d: DatosPdf): Promise<Buffer> {
  const doc = d.contenido.id as ReaderDocId;
  const nombre = DOCUMENTOS[doc].nombre;
  const fechaFirma = d.firmas.reduce<Date | null>((min, f) => (!min || f.firmadaEn < min ? f.firmadaEn : min), null) ?? new Date();
  const pdf = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 55, left: 55, right: 55 },
    info: { Title: `${nombre} · ${d.matricula.codigo}`, Author: 'Centro Educativo Albaydar', Subject: `Matrícula ${d.matricula.codigo} · ${d.alumna}` },
  });
  const trozos: Buffer[] = [];
  pdf.on('data', (c: Buffer) => trozos.push(c));
  const fin = new Promise<Buffer>((ok, mal) => {
    pdf.on('end', () => ok(Buffer.concat(trozos)));
    pdf.on('error', mal);
  });
  const ancho = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;

  const membrete = () => {
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(ROJO).text(MEMBRETE.nombre);
    pdf.font('Helvetica').fontSize(8).fillColor(GRIS).text(MEMBRETE.direccion);
    pdf.moveDown(0.3).moveTo(pdf.page.margins.left, pdf.y).lineTo(pdf.page.margins.left + ancho, pdf.y).strokeColor('#e4e7ec').stroke();
    pdf.moveDown(0.8).fillColor('black');
  };

  const bloque = (b: BloqueCanonico) => {
    switch (b.tipo) {
      case 'titulo':
        pdf.font('Helvetica-Bold').fontSize(13).text(b.texto).moveDown(0.5);
        break;
      case 'subtitulo':
        pdf.font('Helvetica-Bold').fontSize(10.5).text(b.texto).moveDown(0.3);
        break;
      case 'parrafo':
        pdf.font('Helvetica').fontSize(9.5).text(b.texto, { align: 'justify' }).moveDown(0.5);
        break;
      case 'nota':
        pdf.font('Helvetica-Oblique').fontSize(8.5).fillColor(GRIS).text(b.texto).fillColor('black').moveDown(0.5);
        break;
      case 'campos':
        if (b.titulo) pdf.font('Helvetica-Bold').fontSize(9.5).text(b.titulo).moveDown(0.2);
        for (const c of b.campos) {
          pdf.font('Helvetica').fontSize(8).fillColor(GRIS).text(c.etiqueta, { continued: true }).text('  ');
          pdf.font('Helvetica').fontSize(10).fillColor('black').text(c.valor || '—').moveDown(0.15);
        }
        pdf.moveDown(0.4);
        break;
      case 'casillas':
      case 'opcion':
        for (const o of b.opciones) {
          const marca = b.tipo === 'opcion' ? (o.marcada ? '(X)' : '( )') : o.marcada ? '[X]' : '[  ]';
          pdf.font('Helvetica-Bold').fontSize(9.5).text(`${marca} ${o.etiqueta}${o.estado ? ` · ${o.estado}` : ''}`);
          pdf.font('Helvetica').fontSize(8.5).text(o.texto, { indent: 18, align: 'justify' });
          if (o.motivo) pdf.font('Helvetica-Oblique').fontSize(8.5).text(o.motivo, { indent: 18 });
          pdf.moveDown(0.3);
        }
        if (b.tipo === 'opcion' && b.aviso) pdf.font('Helvetica-Oblique').fontSize(8.5).fillColor(ROJO).text(b.aviso).fillColor('black');
        pdf.moveDown(0.3);
        break;
      case 'tabla':
        for (const f of b.filas) {
          pdf.font('Helvetica-Bold').fontSize(9).text(f.clave, { continued: true }).font('Helvetica').text(`  ${f.valor}`).moveDown(0.2);
        }
        pdf.moveDown(0.3);
        break;
      case 'fecha':
        pdf.font('Helvetica').fontSize(9.5).text(b.plantilla.replace('{fecha}', FECHA_LARGA.format(fechaFirma))).moveDown(0.6);
        break;
    }
  };

  d.contenido.paginas.forEach((p, i) => {
    if (i > 0) pdf.addPage();
    membrete();
    pdf.font('Helvetica').fontSize(8).fillColor(GRIS).text(`${nombre} · página ${p.numero} de ${d.contenido.paginas.length}`, { align: 'right' }).fillColor('black').moveDown(0.5);
    for (const b of p.bloques) bloque(b);
    if (!p.firma) return;

    pdf.moveDown(0.4).font('Helvetica-Bold').fontSize(10).text(p.firma.titulo);
    if (p.firma.aviso) pdf.font('Helvetica-Oblique').fontSize(8.5).fillColor(GRIS).text(p.firma.aviso).fillColor('black');
    pdf.font('Helvetica-Oblique').fontSize(9).text(p.firma.declaracion).moveDown(0.4);
    for (const h of p.firma.huecos) {
      const f = d.firmas.find((x) => x.hueco === h.id);
      if (pdf.y > pdf.page.height - pdf.page.margins.bottom - 120) pdf.addPage();
      pdf.font('Helvetica-Bold').fontSize(8.5).text(h.etiqueta);
      if (h.subtitulo) pdf.font('Helvetica').fontSize(8).fillColor(GRIS).text(h.subtitulo).fillColor('black');
      const y = pdf.y + 4;
      pdf.rect(pdf.page.margins.left, y, 220, 80).strokeColor('#c9ced6').stroke();
      if (f) {
        try {
          pdf.image(f.imagen, pdf.page.margins.left + 6, y + 6, { fit: [208, 68], align: 'center', valign: 'center' });
        } catch {
          pdf.font('Helvetica-Oblique').fontSize(8).text('[No se ha podido dibujar el trazo: ver la imagen original en el expediente]', pdf.page.margins.left + 8, y + 30, { width: 204 });
        }
      }
      pdf.x = pdf.page.margins.left;
      pdf.y = y + 84;
      pdf.font('Helvetica').fontSize(8).fillColor(GRIS).text(f ? `Firmado electrónicamente · ${fechaHora(f.firmadaEn)}` : 'Sin firmar').fillColor('black').moveDown(0.6);
    }
  });

  // ── Hoja de evidencias ──
  pdf.addPage();
  membrete();
  pdf.font('Helvetica-Bold').fontSize(13).text('HOJA DE EVIDENCIAS').moveDown(0.5);
  const fila = (k: string, v: string) => pdf.font('Helvetica-Bold').fontSize(9).text(`${k}: `, { continued: true }).font('Helvetica').text(v).moveDown(0.15);
  fila('Documento', `${nombre} (versión del texto ${d.contenido.version})`);
  fila('Matrícula', `${d.matricula.codigo} · curso ${d.matricula.cursoEscolar.replace('-', '/')}`);
  fila('Alumna', d.alumna);
  fila('Huella del documento firmado (SHA-256)', d.huella);
  pdf.font('Helvetica').fontSize(8.5).fillColor(GRIS).text('La huella se calcula sobre el texto y todos los datos del documento, salvo la línea de la fecha, que es la de la firma. Cualquier cambio de un dato daría otra huella.').fillColor('black').moveDown(0.6);
  fila('Lectura', frasePaginas(doc, d.contenido.paginas.length, d.paginasLeidas));
  pdf.moveDown(0.4);

  for (const f of [...d.firmas].sort((a, b) => a.firmadaEn.getTime() - b.firmadaEn.getTime())) {
    if (pdf.y > pdf.page.height - pdf.page.margins.bottom - 110) pdf.addPage();
    pdf.font('Helvetica-Bold').fontSize(10).text(`${HUECOS[f.hueco]} (${f.hueco})`).moveDown(0.15);
    fila('Fecha y hora del servidor', fechaHora(f.firmadaEn));
    fila('Origen', origen(f));
    fila('IP', f.ip ?? 'Sin datos');
    fila('Navegador', f.userAgent ?? 'Sin datos');
    fila('Huella firmada', d.huella);
    fila('Imagen del trazo (SHA-256)', f.imagenSha256);
    pdf.moveDown(0.5);
  }

  pdf
    .moveDown(0.5)
    .font('Helvetica-Oblique')
    .fontSize(8)
    .fillColor(GRIS)
    .text(
      'Firma electrónica simple (art. 3.10 del Reglamento (UE) 910/2014, eIDAS). Cada firma se hizo sobre el documento identificado por su huella, después de declarar «He leído el documento completo y lo firmo». Las marcas de lectura las registra el navegador al recorrer cada página: dejan constancia de que se mostraron, no acreditan por sí solas que se leyeran.',
      { align: 'justify' },
    );
  pdf.end();
  return fin;
}
