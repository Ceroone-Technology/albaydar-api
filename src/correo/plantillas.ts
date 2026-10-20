import { CENTRO } from '../config/env';

/**
 * Plantillas de correo de la fase de admisión.
 * Los textos son una primera versión: el módulo Comunicaciones del mockup
 * permite editar plantillas, así que más adelante saldrán de BD.
 */

export interface Correo {
  asunto: string;
  html: string;
  texto: string;
}

const e = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ROJO = '#C2002F';
/** "10:00 – 10:45" → "10:00" */
const horaInicio = (franja: string) => franja.split(' – ')[0] ?? franja;

function layout(o: { antetitulo: string; titulo: string; cuerpo: string; boton?: { texto: string; url: string }; pie?: string }) {
  const boton = o.boton
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 8px"><tr><td style="border-radius:10px;background:${ROJO}">
        <a href="${e(o.boton.url)}" style="display:inline-block;padding:13px 22px;font:700 14px/1 Montserrat,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:10px">${e(o.boton.texto)}</a>
       </td></tr></table>
       <p style="font:400 12px/1.5 Arial,sans-serif;color:#8a9099;margin:6px 0 0">Si el botón no funciona, copia este enlace en el navegador:<br><span style="word-break:break-all;color:#9C0026">${e(o.boton.url)}</span></p>`
    : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(o.titulo)}</title></head>
<body style="margin:0;background:#f5f6f8;color:#1a1d24">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f6f8;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e7ec;border-radius:13px">
    <tr><td style="padding:20px 28px;border-bottom:1px solid #e4e7ec"><img src="${CENTRO.logo}" alt="${e(CENTRO.nombre)}" height="38" style="display:block;height:38px"></td></tr>
    <tr><td style="padding:28px">
      <div style="font:700 11px/1.2 Montserrat,Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:${ROJO}">${e(o.antetitulo)}</div>
      <h1 style="font:700 22px/1.25 Montserrat,Arial,sans-serif;margin:8px 0 14px;color:#1a1d24">${e(o.titulo)}</h1>
      <div style="font:400 14px/1.65 Arial,sans-serif;color:#3d4450">${o.cuerpo}</div>
      ${boton}
    </td></tr>
    <tr><td style="padding:16px 28px;border-top:1px solid #e4e7ec;font:400 11.5px/1.5 Arial,sans-serif;color:#8a9099">
      ${o.pie ? e(o.pie) + '<br>' : ''}${e(CENTRO.nombre)} · ${e(CENTRO.direccion)} · ${e(CENTRO.telefono)}
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

const pieTexto = `\n\n—\n${CENTRO.nombre} · ${CENTRO.direccion} · ${CENTRO.telefono}`;

const listaHtml = (items: string[]) =>
  `<ul style="padding-left:18px;margin:10px 0">${items.map((i) => `<li style="margin:4px 0">${e(i)}</li>`).join('')}</ul>`;

export interface DatosBase {
  codigo: string;
  tutor: string; // nombre de pila
  alumna: string; // nombre completo
  curso: string; // "Bachillerato 1º"
}

// 1 ── Solicitud recibida ─────────────────────────────────────────────────────
export function solicitudRecibida(d: DatosBase): Correo {
  return {
    asunto: `Hemos recibido la solicitud de ${d.alumna} · ${d.codigo}`,
    html: layout({
      antetitulo: `Solicitud de admisión · ${d.codigo}`,
      titulo: 'Solicitud recibida',
      cuerpo: `<p>Hola, ${e(d.tutor)}:</p><p>Hemos recibido la solicitud de admisión de <strong>${e(d.alumna)}</strong> para <strong>${e(d.curso)}</strong>. Secretaría la revisará y te escribiremos a este correo con los siguientes pasos.</p><p>Guarda este código por si necesitas contactar con nosotros: <strong>${e(d.codigo)}</strong>.</p>`,
    }),
    texto: `Hola, ${d.tutor}:\n\nHemos recibido la solicitud de admisión de ${d.alumna} para ${d.curso}. Secretaría la revisará y te escribiremos con los siguientes pasos.\n\nCódigo de la solicitud: ${d.codigo}${pieTexto}`,
  };
}

// 2 ── Pedir que complete ──────────────────────────────────────────────────────
export function completarSolicitud(d: DatosBase & { campos: string[]; mensaje?: string | null; enlace: string; reenvio: boolean }): Correo {
  const nota = d.mensaje ? `<p style="background:#fafbfc;border:1px solid #e4e7ec;border-radius:9px;padding:12px 14px">${e(d.mensaje)}</p>` : '';
  return {
    asunto: `${d.reenvio ? 'Recordatorio: f' : 'F'}altan datos en la solicitud de ${d.alumna} · ${d.codigo}`,
    html: layout({
      antetitulo: `Solicitud de admisión · ${d.codigo}`,
      titulo: 'Necesitamos que completes la solicitud',
      cuerpo: `<p>Hola, ${e(d.tutor)}:</p><p>Para continuar con la solicitud de <strong>${e(d.alumna)}</strong> nos falta:</p>${listaHtml(d.campos)}${nota}<p>Puedes completarla desde tu enlace personal, sin crear una cuenta.</p>`,
      boton: { texto: 'Completar la solicitud', url: d.enlace },
    }),
    texto: `Hola, ${d.tutor}:\n\nPara continuar con la solicitud de ${d.alumna} nos falta:\n${d.campos.map((c) => `- ${c}`).join('\n')}\n${d.mensaje ? `\n${d.mensaje}\n` : ''}\nCompleta la solicitud aquí: ${d.enlace}${pieTexto}`,
  };
}

export interface HuecoTexto {
  dia: string; // "Martes 1 de septiembre"
  franja: string; // "10:00 – 10:45"
}

// 3 ── Propuesta de fechas ─────────────────────────────────────────────────────
export function propuestaCita(d: DatosBase & { huecos: HuecoTexto[]; enlace: string; mensaje?: string | null; recordatorio?: boolean }): Correo {
  const filas = d.huecos
    .map(
      (h) =>
        `<tr><td style="padding:10px 14px;border:1px solid #e4e7ec;border-radius:9px"><strong>${e(h.dia)}</strong><br><span style="color:#6b7280">${e(h.franja)}</span></td></tr><tr><td style="height:8px"></td></tr>`,
    )
    .join('');
  const intro = d.recordatorio
    ? `<p>Hola, ${e(d.tutor)}:</p><p>Hace unos días te propusimos fechas para la entrevista de admisión de <strong>${e(d.alumna)}</strong> y todavía no hemos recibido tu respuesta. Siguen disponibles:</p>`
    : `<p>Hola, ${e(d.tutor)}:</p><p>Hemos revisado la solicitud de <strong>${e(d.alumna)}</strong> para ${e(d.curso)}. Te proponemos estas fechas para la entrevista; elige la que mejor te venga.</p>`;
  return {
    asunto: d.recordatorio
      ? `Recordatorio: elige la fecha de la entrevista de ${d.alumna}`
      : `Elige la fecha de la entrevista de ${d.alumna} · ${d.codigo}`,
    html: layout({
      antetitulo: `Entrevista de admisión · ${d.codigo}`,
      titulo: 'Elige la fecha de la entrevista',
      cuerpo: `${intro}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:12px 0">${filas}</table>
        <p style="margin:0">${e(CENTRO.entrevista.tipo)} · con el ${e(CENTRO.entrevista.con.toLowerCase())} · ${e(CENTRO.entrevista.lugar)}, ${e(CENTRO.direccion)}.</p>
        ${d.mensaje ? `<p style="background:#fafbfc;border:1px solid #e4e7ec;border-radius:9px;padding:12px 14px">${e(d.mensaje)}</p>` : ''}
        <p>Si ninguna te encaja, desde el mismo enlace puedes indicarnos otra franja. Allí también puedes subir el boletín de notas del último curso.</p>`,
      boton: { texto: 'Elegir la fecha', url: d.enlace },
    }),
    texto: `Hola, ${d.tutor}:\n\nTe proponemos estas fechas para la entrevista de admisión de ${d.alumna}:\n${d.huecos.map((h) => `- ${h.dia}, ${h.franja}`).join('\n')}\n\n${CENTRO.entrevista.tipo} · con el ${CENTRO.entrevista.con.toLowerCase()} · ${CENTRO.entrevista.lugar}, ${CENTRO.direccion}.\n${d.mensaje ? `\n${d.mensaje}\n` : ''}\nElige la fecha (o indícanos otra franja) aquí: ${d.enlace}${pieTexto}`,
  };
}

// 4 ── Cita confirmada (con .ics) ──────────────────────────────────────────────
export function citaConfirmada(d: DatosBase & { dia: string; franja: string; enlace: string; faltanNotas: boolean; cambio: boolean }): Correo {
  const notas = d.faltanNotas
    ? '<p>Recuerda subir el <strong>boletín de notas del último curso</strong> antes de la entrevista, desde el mismo enlace.</p>'
    : '';
  return {
    asunto: `${d.cambio ? 'Cita actualizada' : 'Cita confirmada'}: ${d.dia}, ${horaInicio(d.franja)} · ${d.alumna}`,
    html: layout({
      antetitulo: `Entrevista de admisión · ${d.codigo}`,
      titulo: `${d.dia}, ${horaInicio(d.franja)}`,
      cuerpo: `<p>Hola, ${e(d.tutor)}:</p><p>${d.cambio ? 'Hemos actualizado' : 'Queda confirmada'} la entrevista de admisión de <strong>${e(d.alumna)}</strong>:</p>
        <p style="background:#fafbfc;border:1px solid #e4e7ec;border-radius:9px;padding:12px 14px;margin:12px 0">
          <strong>${e(d.dia)}</strong> · ${e(d.franja)}<br>${e(CENTRO.entrevista.tipo)} con el ${e(CENTRO.entrevista.con.toLowerCase())}<br>${e(CENTRO.entrevista.lugar)} · ${e(CENTRO.direccion)}</p>
        <p>Adjuntamos la invitación para añadirla a tu calendario. Te enviaremos un recordatorio el día antes.</p>${notas}
        <p>Si necesitas cambiar la fecha, puedes hacerlo desde el mismo enlace.</p>`,
      boton: { texto: 'Ver o cambiar la cita', url: d.enlace },
    }),
    texto: `Hola, ${d.tutor}:\n\n${d.cambio ? 'Hemos actualizado' : 'Queda confirmada'} la entrevista de admisión de ${d.alumna}:\n${d.dia} · ${d.franja}\n${CENTRO.entrevista.tipo} con el ${CENTRO.entrevista.con.toLowerCase()} · ${CENTRO.entrevista.lugar}, ${CENTRO.direccion}\n\nTe enviaremos un recordatorio el día antes.${d.faltanNotas ? '\nRecuerda subir el boletín de notas antes de la entrevista.' : ''}\n\nVer o cambiar la cita: ${d.enlace}${pieTexto}`,
  };
}

// 5 ── Recordatorio el día antes ───────────────────────────────────────────────
export function recordatorioEntrevista(d: DatosBase & { dia: string; franja: string; enlace: string; faltanNotas: boolean }): Correo {
  return {
    asunto: `Mañana: entrevista de admisión de ${d.alumna} a las ${horaInicio(d.franja)}`,
    html: layout({
      antetitulo: `Entrevista de admisión · ${d.codigo}`,
      titulo: 'Te esperamos mañana',
      cuerpo: `<p>Hola, ${e(d.tutor)}:</p><p>Te recordamos la entrevista de admisión de <strong>${e(d.alumna)}</strong>: <strong>${e(d.dia)}, ${e(d.franja)}</strong>, en la ${e(CENTRO.entrevista.lugar.toLowerCase())} (${e(CENTRO.direccion)}).</p>${
        d.faltanNotas ? '<p>Aún no hemos recibido el <strong>boletín de notas</strong>. Puedes subirlo hoy desde tu enlace.</p>' : ''
      }`,
      boton: { texto: 'Ver la cita', url: d.enlace },
    }),
    texto: `Hola, ${d.tutor}:\n\nTe recordamos la entrevista de admisión de ${d.alumna}: ${d.dia}, ${d.franja}, en la ${CENTRO.entrevista.lugar.toLowerCase()} (${CENTRO.direccion}).${d.faltanNotas ? '\nAún no hemos recibido el boletín de notas; puedes subirlo desde tu enlace.' : ''}\n\n${d.enlace}${pieTexto}`,
  };
}

// 6 ── Entrevista cancelada por el centro ─────────────────────────────────────
export function citaCancelada(d: DatosBase & { dia: string; franja: string; motivo?: string | null }): Correo {
  return {
    asunto: `Entrevista anulada: ${d.dia}, ${horaInicio(d.franja)} · ${d.alumna}`,
    html: layout({
      antetitulo: `Entrevista de admisión · ${d.codigo}`,
      titulo: 'Hemos anulado la entrevista',
      cuerpo: `<p>Hola, ${e(d.tutor)}:</p><p>Hemos tenido que anular la entrevista de <strong>${e(d.alumna)}</strong> prevista para el ${e(d.dia.toLowerCase())} a las ${e(horaInicio(d.franja))}.${d.motivo ? ` ${e(d.motivo)}` : ''}</p><p>Secretaría se pondrá en contacto contigo para proponerte una nueva fecha.</p>`,
    }),
    texto: `Hola, ${d.tutor}:\n\nHemos anulado la entrevista de ${d.alumna} prevista para el ${d.dia.toLowerCase()} a las ${horaInicio(d.franja)}.${d.motivo ? ` ${d.motivo}` : ''}\nSecretaría se pondrá en contacto contigo para proponerte una nueva fecha.${pieTexto}`,
  };
}

// 7 ── Aviso interno: la familia pide otra franja ─────────────────────────────
export function avisoOtraFranja(d: DatosBase & { franja?: string | null; prefiereLlamada: boolean; telefono: string; urlBandeja: string }): Correo {
  const detalle = [d.franja ? `Franja indicada: “${d.franja}”` : 'Sin franja indicada', d.prefiereLlamada ? `Prefiere que la llamen (${d.telefono})` : null]
    .filter(Boolean) as string[];
  return {
    asunto: `La familia de ${d.alumna} pide otra franja · ${d.codigo}`,
    html: layout({
      antetitulo: `Aviso interno · ${d.codigo}`,
      titulo: 'Ninguna fecha le encaja',
      cuerpo: `<p>${e(d.tutor)} ha respondido a la propuesta de entrevista de <strong>${e(d.alumna)}</strong> (${e(d.curso)}):</p>${listaHtml(detalle)}<p>Propón nuevas fechas desde la bandeja de admisión.</p>`,
      boton: { texto: 'Abrir la bandeja', url: d.urlBandeja },
    }),
    texto: `${d.tutor} ha respondido a la propuesta de entrevista de ${d.alumna} (${d.curso}):\n${detalle.map((x) => `- ${x}`).join('\n')}\n\nBandeja: ${d.urlBandeja}`,
  };
}
