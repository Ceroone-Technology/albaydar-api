import sanitizeHtml from 'sanitize-html';
import { CENTRO } from '../config/env';
import { evento, type EventoDef } from './eventos';

/**
 * Motor de plantillas de correo.
 *  - El cuerpo que edita el centro es HTML (saneado al guardar).
 *  - Las variables van entre llaves dobles: {{alumna}}.
 *  - El resultado se envuelve en el diseño común (logo, colores, pie).
 */

export interface Correo {
  asunto: string;
  html: string;
  texto: string;
}

export const escapar = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ROJO = '#C2002F';
const RE_VAR = /\{\{\s*([a-z_]+)\s*\}\}/g;

// ── Bloques HTML que genera el sistema (variables de tipo html) ─────────────

export const boton = (url: string, texto: string) =>
  `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:22px 0 8px"><tr><td style="border-radius:10px;background:${ROJO}">` +
  `<a href="${escapar(url)}" style="display:inline-block;padding:13px 22px;font:700 14px/1 Montserrat,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:10px">${escapar(texto)}</a>` +
  `</td></tr></table>` +
  `<p style="font:400 12px/1.5 Arial,sans-serif;color:#8a9099;margin:6px 0 0">Si el botón no funciona, copia este enlace en el navegador:<br><span style="word-break:break-all;color:#9C0026">${escapar(url)}</span></p>`;

export const lista = (items: string[]) =>
  `<ul style="padding-left:18px;margin:10px 0">${items.map((i) => `<li style="margin:5px 0">${escapar(i)}</li>`).join('')}</ul>`;

// ── Saneado (lo que guarda el editor de Comunicaciones) ─────────────────────

const OPCIONES_SANEADO: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'span', 'div', 'a', 'img',
    'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
  ],
  allowedAttributes: {
    '*': ['style', 'align'],
    a: ['href', 'target', 'title'],
    img: ['src', 'alt', 'width', 'height'],
    td: ['colspan', 'rowspan', 'width'],
    th: ['colspan', 'rowspan', 'width'],
    table: ['role', 'width', 'cellspacing', 'cellpadding', 'border'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // Nada de scripts, iframes, formularios ni manejadores on*.
  disallowedTagsMode: 'discard',
};

export const sanear = (html: string) => sanitizeHtml(html, OPCIONES_SANEADO).trim();

// ── Validación de variables ─────────────────────────────────────────────────

export const variablesUsadas = (...textos: string[]) => [...new Set(textos.flatMap((t) => [...t.matchAll(RE_VAR)].map((m) => m[1]!)))];

/** Variables usadas que el evento no ofrece (errores de escritura del editor). */
export function variablesDesconocidas(ev: EventoDef, ...textos: string[]) {
  const validas = new Set(ev.variables.map((x) => x.nombre));
  return variablesUsadas(...textos).filter((n) => !validas.has(n));
}

// ── Render ──────────────────────────────────────────────────────────────────

export type Vars = Record<string, string | number | null | undefined>;

function sustituir(texto: string, vars: Vars, ev: EventoDef | undefined, modo: 'html' | 'texto') {
  const esHtml = new Set((ev?.variables ?? []).filter((x) => x.html).map((x) => x.nombre));
  return texto.replace(RE_VAR, (_m, nombre: string) => {
    const valor = String(vars[nombre] ?? '');
    if (modo === 'texto') return esHtml.has(nombre) ? htmlATexto(valor) : valor;
    return esHtml.has(nombre) ? valor : escapar(valor);
  });
}

/** Diseño común: logo, tarjeta blanca, pie con los datos del centro. */
export function layout(cuerpo: string, titulo: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapar(titulo)}</title>
<style>h1,h2,h3{font-family:Montserrat,Arial,sans-serif;color:#1a1d24;margin:0 0 14px}h2{font-size:22px;line-height:1.25}p{margin:0 0 12px}a{color:#9C0026}</style></head>
<body style="margin:0;background:#f5f6f8;color:#1a1d24">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f6f8;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e7ec;border-radius:13px">
    <tr><td style="padding:20px 28px;border-bottom:1px solid #e4e7ec"><img src="${CENTRO.logo}" alt="${escapar(CENTRO.nombre)}" height="38" style="display:block;height:38px"></td></tr>
    <tr><td style="padding:28px;font:400 14px/1.65 Arial,sans-serif;color:#3d4450">${cuerpo}</td></tr>
    <tr><td style="padding:16px 28px;border-top:1px solid #e4e7ec;font:400 11.5px/1.5 Arial,sans-serif;color:#8a9099">
      ${escapar(CENTRO.nombre)} · ${escapar(CENTRO.direccion)} · ${escapar(CENTRO.telefono)}
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

/** Versión en texto plano (la leen algunos clientes y mejora la entrega). */
export function htmlATexto(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
      const texto = t.replace(/<[^>]+>/g, '').trim();
      return texto && texto !== href ? `${texto} (${href})` : href;
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/h[1-6]|\/tr|\/ul|\/ol|\/div|\/table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Párrafos que quedaron vacíos porque una variable opcional venía vacía. */
const quitarVacios = (html: string) => html.replace(/<p[^>]*>\s*<\/p>/gi, '');

export function renderizar(o: { evento: string; asunto: string; cuerpoHtml: string; vars: Vars }): Correo {
  const ev = evento(o.evento);
  const asunto = sustituir(o.asunto, o.vars, ev, 'texto').replace(/\s+/g, ' ').trim();
  const cuerpo = quitarVacios(sustituir(o.cuerpoHtml, o.vars, ev, 'html'));
  return {
    asunto,
    html: layout(cuerpo, asunto),
    texto: `${htmlATexto(cuerpo)}\n\n—\n${CENTRO.nombre} · ${CENTRO.direccion} · ${CENTRO.telefono}`,
  };
}

/** Variables con los valores de ejemplo del catálogo (vista previa y "Enviar prueba"). */
export function varsDeEjemplo(ev: EventoDef): Vars {
  const vars: Vars = Object.fromEntries(ev.variables.map((x) => [x.nombre, x.ejemplo]));
  if (vars.boton !== undefined) vars.boton = boton(String(vars.enlace ?? '#'), 'Abrir mi enlace');
  if (vars.fechas_propuestas !== undefined) vars.fechas_propuestas = lista(['Martes 3 de noviembre · 10:00 – 10:45', 'Miércoles 4 de noviembre · 12:30 – 13:15', 'Jueves 5 de noviembre · 17:00 – 17:45']);
  if (vars.campos !== undefined) vars.campos = lista(['Centro de procedencia']);
  if (vars.aviso_notas !== undefined) vars.aviso_notas = '<p><strong>Recuerda subir el boletín de notas del último curso</strong> desde tu enlace antes de la entrevista.</p>';
  return vars;
}
