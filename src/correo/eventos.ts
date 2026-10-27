/**
 * Catálogo de eventos que envían correo y sus variables.
 *
 * Cada evento tiene una plantilla HTML editable en Comunicaciones (tabla
 * `plantillas_correo`). Aquí está la versión predeterminada con la que se
 * siembra la base de datos y que se usa si la plantilla de un evento
 * obligatorio no está activada.
 *
 * Sintaxis en asunto y cuerpo: {{variable}}. Las variables de tipo "html"
 * (listas, botón) se insertan tal cual; el resto se escapa.
 */

export interface VariableDef {
  nombre: string;
  descripcion: string;
  ejemplo: string;
  /** Bloque HTML generado por el sistema (lista, botón): se inserta sin escapar. */
  html?: boolean;
}

export interface EventoDef {
  clave: string;
  nombre: string;
  /** Cuándo se envía (texto que muestra la columna "Evento" del mockup). */
  cuando: string;
  destinatario: 'familia' | 'secretaria';
  /**
   * Lleva el enlace personal de la familia: si no hay plantilla activada,
   * se envía igualmente con la predeterminada para no romper el flujo.
   */
  obligatorio: boolean;
  /** false = el módulo que lo dispara aún no está construido (fases siguientes). */
  disponible: boolean;
  variables: VariableDef[];
  predeterminada: { nombre: string; asunto: string; cuerpoHtml: string };
}

const v = (nombre: string, descripcion: string, ejemplo: string, html = false): VariableDef => ({ nombre, descripcion, ejemplo, html });

// Variables comunes a todos los correos.
const BASE: VariableDef[] = [
  v('alumna', 'Nombre completo de la alumna', 'Lucía Márquez Peña'),
  v('tutor', 'Nombre de pila de la madre, padre o tutor', 'Elena'),
  v('codigo', 'Código de la solicitud', 'B-2026-0001'),
  v('curso', 'Etapa y curso solicitados', 'Bachillerato 1º'),
  v('centro_nombre', 'Nombre del centro', 'Centro Educativo Albaydar'),
  v('centro_direccion', 'Dirección del centro', 'Avda. de la Palmera, 36 · 41012 Sevilla'),
  v('centro_telefono', 'Teléfono del centro', '954 61 02 54'),
];
const ENLACE = [
  v('enlace', 'Enlace personal de la familia (URL)', 'https://app.albaydar.org/cita/abc123'),
  v('boton', 'Botón rojo con el enlace personal', '<a href="#">Botón</a>', true),
];
const ENTREVISTA = [
  v('fecha_entrevista', 'Día de la entrevista', 'Martes 3 de noviembre'),
  v('hora', 'Hora de inicio', '10:00'),
  v('hora_fin', 'Hora de fin', '10:45'),
  v('sala', 'Lugar de la entrevista', 'Sala de reuniones de Dirección'),
  v('con', 'Quién hace la entrevista', 'Equipo directivo'),
];
const DECISION = [
  v('etapa', 'Vía y curso de la plaza', '1º Bachillerato'),
  v('curso_escolar', 'Curso escolar', '2027/28'),
];
const PAGO = [
  v('importe', 'Importe pendiente de la reserva', '300,00 €'),
  v('fecha_limite', 'Último día para pagar', 'jueves 5 de noviembre'),
  v('iban', 'IBAN del centro', 'ES91 2100 0418 4502 0005 1332'),
  v('titular', 'Titular de la cuenta', 'Centro Educativo Albaydar'),
  v('formas_pago', 'Formas de pago admitidas', 'transferencia o en efectivo en administración'),
];
const AVISO_NOTAS = v('aviso_notas', 'Recordatorio de subir el boletín de notas (vacío si ya lo subió)', '<p>Recuerda subir el boletín de notas.</p>', true);

const p = (t: string) => `<p>${t}</p>`;
const caja = (t: string) =>
  `<p style="background:#fafbfc;border:1px solid #e4e7ec;border-radius:9px;padding:12px 14px">${t}</p>`;
const saludo = p('Hola, {{tutor}}:');

export const EVENTOS: EventoDef[] = [
  {
    clave: 'SOLICITUD_RECIBIDA',
    nombre: 'Solicitud recibida',
    cuando: 'La familia envía el formulario web',
    destinatario: 'familia',
    obligatorio: false,
    disponible: true,
    variables: BASE,
    predeterminada: {
      nombre: 'Acuse de solicitud',
      asunto: 'Hemos recibido la solicitud de {{alumna}} · {{codigo}}',
      cuerpoHtml: [
        '<h2>Solicitud recibida</h2>',
        saludo,
        p('Hemos recibido la solicitud de admisión de <strong>{{alumna}}</strong> para <strong>{{curso}}</strong>. Secretaría la revisará y te escribiremos a este correo con los siguientes pasos.'),
        p('Guarda este código por si necesitas contactar con nosotros: <strong>{{codigo}}</strong>.'),
      ].join('\n'),
    },
  },
  {
    clave: 'COMPLETAR_SOLICITUD',
    nombre: 'Pedir que complete',
    cuando: 'Secretaría pide completar la solicitud',
    destinatario: 'familia',
    obligatorio: true,
    disponible: true,
    variables: [...BASE, v('campos', 'Lista de datos que faltan', '<ul><li>Centro de procedencia</li></ul>', true), v('mensaje', 'Nota opcional de secretaría', 'Indícanos el centro actual.'), ...ENLACE],
    predeterminada: {
      nombre: 'Solicitud incompleta',
      asunto: 'Faltan datos en la solicitud de {{alumna}} · {{codigo}}',
      cuerpoHtml: [
        '<h2>Necesitamos que completes la solicitud</h2>',
        saludo,
        p('Para continuar con la solicitud de <strong>{{alumna}}</strong> nos falta:'),
        '{{campos}}',
        p('{{mensaje}}'),
        p('Puedes completarla desde tu enlace personal, sin crear una cuenta.'),
        '{{boton}}',
      ].join('\n'),
    },
  },
  {
    clave: 'CITACION_PROPUESTA',
    nombre: 'Propuesta de fechas de entrevista',
    cuando: 'Secretaría cita a entrevista (1 a 3 fechas)',
    destinatario: 'familia',
    obligatorio: true,
    disponible: true,
    variables: [
      ...BASE,
      v('fechas_propuestas', 'Lista de fechas y horas propuestas', '<ul><li>Martes 3 de noviembre · 10:00 – 10:45</li></ul>', true),
      v('duracion', 'Duración de la entrevista en minutos', '45'),
      v('sala', 'Lugar de la entrevista', 'Sala de reuniones de Dirección'),
      v('con', 'Quién hace la entrevista', 'Equipo directivo'),
      v('mensaje', 'Nota opcional de secretaría', ''),
      ...ENLACE,
    ],
    predeterminada: {
      nombre: 'Elige la fecha de la entrevista',
      asunto: 'Elige la fecha de la entrevista de {{alumna}} · {{codigo}}',
      cuerpoHtml: [
        '<h2>Elige la fecha de la entrevista</h2>',
        saludo,
        p('Hemos revisado la solicitud de <strong>{{alumna}}</strong> para {{curso}}. Te proponemos estas fechas para la entrevista de admisión; elige la que mejor te venga:'),
        '{{fechas_propuestas}}',
        p('La entrevista es presencial, con el {{con}}, en la {{sala}} ({{centro_direccion}}). Dura unos {{duracion}} minutos.'),
        p('{{mensaje}}'),
        p('Si ninguna te encaja, desde el mismo enlace puedes indicarnos otra franja. Allí también puedes subir el boletín de notas del último curso.'),
        '{{boton}}',
      ].join('\n'),
    },
  },
  {
    clave: 'CITACION_RECORDATORIO',
    nombre: 'Recordatorio: elegir fecha',
    cuando: 'La familia no ha elegido fecha 3 días después de recibir la propuesta',
    destinatario: 'familia',
    obligatorio: false,
    disponible: true,
    variables: [
      ...BASE,
      v('fechas_propuestas', 'Fechas que siguen disponibles', '<ul><li>Martes 3 de noviembre · 10:00 – 10:45</li></ul>', true),
      v('sala', 'Lugar de la entrevista', 'Sala de reuniones de Dirección'),
      ...ENLACE,
    ],
    predeterminada: {
      nombre: 'Recordatorio de elección de fecha',
      asunto: 'Recordatorio: elige la fecha de la entrevista de {{alumna}}',
      cuerpoHtml: [
        '<h2>Te estamos esperando</h2>',
        saludo,
        p('Hace unos días te propusimos fechas para la entrevista de admisión de <strong>{{alumna}}</strong> y todavía no hemos recibido tu respuesta. Te las tenemos reservadas:'),
        '{{fechas_propuestas}}',
        p('Elige la que mejor te venga o indícanos otra franja desde tu enlace personal.'),
        '{{boton}}',
      ].join('\n'),
    },
  },
  {
    clave: 'CITA_CONFIRMADA',
    nombre: 'Confirmación de entrevista',
    cuando: 'Solicitud pasa a "Entrevista programada" (la familia elige fecha)',
    destinatario: 'familia',
    obligatorio: true,
    disponible: true,
    variables: [...BASE, ...ENTREVISTA, v('cambio_hasta', 'Hasta cuándo puede cambiar la fecha la familia', 'miércoles 28 de octubre a las 10:15'), AVISO_NOTAS, ...ENLACE],
    predeterminada: {
      nombre: 'Confirmación de entrevista',
      asunto: 'Entrevista de admisión · {{alumna}} · {{fecha_entrevista}}',
      cuerpoHtml: [
        '<h2>{{fecha_entrevista}}, {{hora}}</h2>',
        p('Estimada familia:'),
        p('Confirmamos la entrevista de admisión de <strong>{{alumna}}</strong>:'),
        caja('<strong>{{fecha_entrevista}}</strong> · {{hora}} – {{hora_fin}}<br>Presencial, con el {{con}}<br>{{sala}} · {{centro_direccion}}'),
        p('Rogamos traigan el DNI de los tutores legales y el último boletín de notas. Adjuntamos la invitación para añadirla a su calendario; el día antes les enviaremos un recordatorio.'),
        '{{aviso_notas}}',
        p('Si necesitan cambiar la fecha, pueden hacerlo desde el mismo enlace hasta el {{cambio_hasta}}. Después, llamen a secretaría ({{centro_telefono}}).'),
        '{{boton}}',
      ].join('\n'),
    },
  },
  {
    clave: 'CITA_CAMBIADA',
    nombre: 'Cambio de fecha de entrevista',
    cuando: 'La familia cambia la fecha elegida (dentro de las 24 h siguientes a confirmarla)',
    destinatario: 'familia',
    obligatorio: true,
    disponible: true,
    variables: [...BASE, ...ENTREVISTA, AVISO_NOTAS, ...ENLACE],
    predeterminada: {
      nombre: 'Entrevista actualizada',
      asunto: 'Nueva fecha de entrevista: {{fecha_entrevista}}, {{hora}} · {{alumna}}',
      cuerpoHtml: [
        '<h2>Hemos actualizado la entrevista</h2>',
        saludo,
        p('La entrevista de admisión de <strong>{{alumna}}</strong> queda así:'),
        caja('<strong>{{fecha_entrevista}}</strong> · {{hora}} – {{hora_fin}}<br>Presencial, con el {{con}}<br>{{sala}} · {{centro_direccion}}'),
        p('Adjuntamos la invitación actualizada para tu calendario.'),
        '{{aviso_notas}}',
        '{{boton}}',
      ].join('\n'),
    },
  },
  {
    clave: 'ENTREVISTA_RECORDATORIO',
    nombre: 'Recordatorio de entrevista',
    cuando: 'El día antes de la entrevista',
    destinatario: 'familia',
    obligatorio: false,
    disponible: true,
    variables: [...BASE, ...ENTREVISTA, AVISO_NOTAS, ...ENLACE],
    predeterminada: {
      nombre: 'Recordatorio del día antes',
      asunto: 'Mañana: entrevista de admisión de {{alumna}} a las {{hora}}',
      cuerpoHtml: [
        '<h2>Te esperamos mañana</h2>',
        saludo,
        p('Te recordamos la entrevista de admisión de <strong>{{alumna}}</strong>:'),
        caja('<strong>{{fecha_entrevista}}</strong> · {{hora}} – {{hora_fin}}<br>{{sala}} · {{centro_direccion}}'),
        p('No olvides traer el DNI de los tutores legales.'),
        '{{aviso_notas}}',
        '{{boton}}',
      ].join('\n'),
    },
  },
  {
    clave: 'CITA_CANCELADA',
    nombre: 'Entrevista anulada',
    cuando: 'Se anula una entrevista confirmada',
    destinatario: 'familia',
    obligatorio: false,
    disponible: true,
    variables: [...BASE, v('fecha_entrevista', 'Día de la entrevista anulada', 'Martes 3 de noviembre'), v('hora', 'Hora de la entrevista anulada', '10:00'), v('motivo', 'Motivo (opcional)', '')],
    predeterminada: {
      nombre: 'Entrevista anulada',
      asunto: 'Entrevista anulada: {{fecha_entrevista}}, {{hora}} · {{alumna}}',
      cuerpoHtml: [
        '<h2>Entrevista anulada</h2>',
        saludo,
        p('La entrevista de <strong>{{alumna}}</strong> prevista para el {{fecha_entrevista}} a las {{hora}} queda anulada. {{motivo}}'),
        p('Secretaría se pondrá en contacto contigo para proponerte una nueva fecha.'),
      ].join('\n'),
    },
  },
  {
    clave: 'AVISO_OTRA_FRANJA',
    nombre: 'Aviso interno: la familia pide otra franja',
    cuando: 'La familia responde "Ninguna me encaja"',
    destinatario: 'secretaria',
    obligatorio: false,
    disponible: true,
    variables: [
      v('alumna', 'Nombre completo de la alumna', 'Lucía Márquez Peña'),
      v('tutor', 'Nombre completo del tutor', 'Elena Peña Ríos'),
      v('codigo', 'Código de la solicitud', 'B-2026-0001'),
      v('curso', 'Etapa y curso', 'Bachillerato 1º'),
      v('telefono', 'Teléfono de la familia', '+34 622 418 903'),
      v('franja_solicitada', 'Disponibilidad que indica la familia', 'Martes o jueves a partir de las 17:00'),
      v('prefiere_llamada', '"Sí" si quiere que la llamen', 'Sí'),
      v('enlace', 'Enlace a la solicitud en la plataforma', 'https://app.albaydar.org/admision?ref=B-2026-0001'),
      v('boton', 'Botón con el enlace', '<a href="#">Botón</a>', true),
    ],
    predeterminada: {
      nombre: 'Aviso: ninguna fecha encaja',
      asunto: 'La familia de {{alumna}} pide otra franja · {{codigo}}',
      cuerpoHtml: [
        '<h2>Ninguna fecha le encaja</h2>',
        p('{{tutor}} ha respondido a la propuesta de entrevista de <strong>{{alumna}}</strong> ({{curso}}):'),
        caja('Disponibilidad: <strong>{{franja_solicitada}}</strong><br>¿Prefiere que la llamen? {{prefiere_llamada}} · {{telefono}}'),
        p('Las fechas que le propusimos ya se han liberado en la agenda. Propón nuevas fechas desde la solicitud.'),
        '{{boton}}',
      ].join('\n'),
    },
  },
  // ── Fase 03: decisión de admisión y reserva de plaza ──
  {
    clave: 'ADMITIDA',
    nombre: 'Admisión y reserva de plaza',
    cuando: 'Dirección registra la decisión "Admitida"',
    destinatario: 'familia',
    obligatorio: false,
    disponible: true,
    variables: [...BASE, ...DECISION, ...PAGO, v('plazo_dias', 'Días para pagar', '15')],
    predeterminada: {
      nombre: 'Admisión y reserva de plaza',
      asunto: 'Plaza admitida para {{alumna}} · reserva antes del {{fecha_limite}}',
      cuerpoHtml: [
        p('Estimada familia:'),
        p('Nos complace comunicarles que <strong>{{alumna}}</strong> ha sido admitida en {{etapa}} para el curso {{curso_escolar}}.'),
        p('Para confirmar la plaza, realicen el pago de <strong>{{importe}}</strong> antes del <strong>{{fecha_limite}}</strong> ({{plazo_dias}} días naturales). Pueden pagar por {{formas_pago}}.'),
        caja('Transferencia a {{titular}}<br>IBAN <strong>{{iban}}</strong><br>Concepto: {{codigo}} · {{alumna}}'),
        p('Secretaría · {{centro_nombre}}'),
      ].join('\n'),
    },
  },
  {
    clave: 'EN_ESPERA',
    nombre: 'Lista de espera',
    cuando: 'Dirección registra la decisión "En espera"',
    destinatario: 'familia',
    obligatorio: false,
    disponible: true,
    variables: [...BASE, ...DECISION, v('posicion', 'Posición en la lista de espera de su vía', '3'), v('motivo', 'Observación opcional de Dirección', '')],
    predeterminada: {
      nombre: 'Lista de espera',
      asunto: 'Solicitud de {{alumna}}: lista de espera · {{codigo}}',
      cuerpoHtml: [
        p('Estimada familia:'),
        p('Tras la entrevista, la solicitud de <strong>{{alumna}}</strong> para {{etapa}} (curso {{curso_escolar}}) queda en lista de espera, en la posición <strong>{{posicion}}</strong>.'),
        p('{{motivo}}'),
        p('Si se libera una plaza, nos pondremos en contacto con ustedes por este mismo correo.'),
        p('Secretaría · {{centro_nombre}}'),
      ].join('\n'),
    },
  },
  {
    clave: 'NO_ADMITIDA',
    nombre: 'Solicitud no admitida',
    cuando: 'Dirección registra la decisión "No admitida"',
    destinatario: 'familia',
    obligatorio: false,
    disponible: true,
    variables: [...BASE, ...DECISION, v('motivo', 'Motivo (opcional)', 'No quedan plazas en la vía solicitada.')],
    predeterminada: {
      nombre: 'Solicitud no admitida',
      asunto: 'Resolución de la solicitud de {{alumna}} · {{codigo}}',
      cuerpoHtml: [
        p('Estimada familia:'),
        p('Lamentamos comunicarles que la solicitud de <strong>{{alumna}}</strong> para {{etapa}} (curso {{curso_escolar}}) no ha sido admitida.'),
        p('{{motivo}}'),
        p('Agradecemos su interés en el centro. Para cualquier aclaración pueden llamar a secretaría ({{centro_telefono}}).'),
        p('Secretaría · {{centro_nombre}}'),
      ].join('\n'),
    },
  },
  {
    clave: 'RECORDATORIO_PAGO',
    nombre: 'Recordatorio de pago',
    cuando: 'Reserva sin pagar a 3 días del vencimiento',
    destinatario: 'familia',
    obligatorio: false,
    disponible: true,
    variables: [...BASE, v('concepto', 'Concepto', 'la reserva de plaza'), ...PAGO],
    predeterminada: {
      nombre: 'Recordatorio de pago',
      asunto: 'Recordatorio: {{concepto}} de {{alumna}}',
      cuerpoHtml: [
        p('Estimada familia:'),
        p('Les recordamos que el pago de {{concepto}} ({{importe}}) vence el {{fecha_limite}}.'),
        p('Pueden abonarlo por {{formas_pago}}.'),
        caja('Transferencia a {{titular}}<br>IBAN <strong>{{iban}}</strong><br>Concepto: {{codigo}} · {{alumna}}'),
        p('Administración · {{centro_nombre}}'),
      ].join('\n'),
    },
  },
  {
    clave: 'RESERVA_VENCIDA',
    nombre: 'Aviso interno: reserva vencida',
    cuando: 'Pasa el plazo de la reserva sin pagarla (a secretaría y administración)',
    destinatario: 'secretaria',
    obligatorio: false,
    disponible: true,
    variables: [
      v('alumna', 'Nombre completo de la alumna', 'Lucía Márquez Peña'),
      v('tutor', 'Nombre completo del tutor', 'Elena Peña Ríos'),
      v('codigo', 'Código de la solicitud', 'B-2026-0001'),
      v('curso', 'Etapa y curso', 'Bachillerato 1º'),
      v('telefono', 'Teléfono de la familia', '+34 622 418 903'),
      v('importe', 'Importe pendiente', '300,00 €'),
      v('fecha_limite', 'Día en que venció', 'jueves 5 de noviembre'),
      v('enlace', 'Enlace a la solicitud en la plataforma', 'https://app.albaydar.org/admision?ref=B-2026-0001'),
      v('boton', 'Botón con el enlace', '<a href="#">Botón</a>', true),
    ],
    predeterminada: {
      nombre: 'Aviso: reserva vencida',
      asunto: 'Reserva vencida sin pagar · {{alumna}} · {{codigo}}',
      cuerpoHtml: [
        '<h2>Reserva vencida sin pagar</h2>',
        p('La reserva de plaza de <strong>{{alumna}}</strong> ({{curso}}) venció el {{fecha_limite}} con <strong>{{importe}}</strong> pendiente.'),
        caja('Familia: {{tutor}} · {{telefono}}'),
        p('La plaza sigue ocupada hasta que decidáis: registrar el pago si llega o cambiar la decisión desde la solicitud.'),
        '{{boton}}',
      ].join('\n'),
    },
  },
  // ── Fases siguientes: se guardan como borrador para editarlas desde ya ──
  {
    clave: 'MATRICULA_CONFIRMADA',
    nombre: 'Confirmación de matrícula',
    cuando: 'Matrícula exportada a Séneca',
    destinatario: 'familia',
    obligatorio: false,
    disponible: false,
    variables: [...BASE, v('etapa', 'Etapa', 'Bachillerato'), v('curso_escolar', 'Curso escolar', '2027/28')],
    predeterminada: {
      nombre: 'Confirmación de matrícula',
      asunto: 'Matrícula confirmada · {{alumna}} · curso {{curso_escolar}}',
      cuerpoHtml: [
        p('Estimada familia:'),
        p('La matrícula de <strong>{{alumna}}</strong> en {{etapa}} ha quedado registrada. Adjuntamos el listado de libros y el calendario de acogida.'),
        p('Secretaría · {{centro_nombre}}'),
      ].join('\n'),
    },
  },
];

export type ClaveEvento = (typeof EVENTOS)[number]['clave'];
export const evento = (clave: string) => EVENTOS.find((e) => e.clave === clave);
