import { describe, expect, it } from 'vitest';
import { generarIcs } from '../src/correo/ics';
import { diaLargo, fechaLocal, franja, horaLocalAUtc } from '../src/lib/fechas';
import { tipoReal } from '../src/lib/storage';
import { euros, formatearIban, ibanValido } from '../src/lib/dinero';
import { diasRestantes, fechaTexto } from '../src/modules/reservas/reservas.service';
import { columnaDe, cursoEscolarCorto, puedeTransicionar, siguientesEstados } from '../src/modules/solicitudes/dominio';
import { revisar, type EntradaRevision } from '../src/modules/solicitudes/revision';

const base: EntradaRevision = {
  alumnaNombre: 'Lucía',
  alumnaApellidos: 'Márquez Peña',
  tutorNombre: 'Elena Peña Ríos',
  email: 'epena@correo.es',
  telefono: '+34 622 418 903',
  centroProcedencia: 'IES Martínez Montañés',
  asignadaSnec: false,
  via: { nombre: '1º Bachillerato', plazas: 10, plazasAsignadasPorJunta: false, ocupadas: 4 },
  familia: null,
  otrasSolicitudes: [],
};

describe('revisión: cinco comprobaciones', () => {
  it('solicitud completa por vía propia: todo en verde y se puede citar', () => {
    const r = revisar(base);
    expect(r.checks.map((c) => c.id)).toEqual(['datos', 'correo', 'plazas', 'familia', 'snec']);
    expect(r.checks.every((c) => c.resultado === 'ok')).toBe(true);
    expect(r.checks[2]!.texto).toBe('1º Bachillerato: 6 plazas libres');
    expect(r.puedeCitar).toBe(true);
  });

  it('sin centro de procedencia: incompleta y no se puede citar', () => {
    const r = revisar({ ...base, centroProcedencia: null });
    expect(r.completa).toBe(false);
    expect(r.puedeCitar).toBe(false);
    expect(r.faltan).toContain('Centro de procedencia');
    expect(r.checks[0]).toMatchObject({ id: 'datos', resultado: 'error' });
  });

  it('correo incompleto (como "aortiz@correo" del mockup)', () => {
    const r = revisar({ ...base, email: 'aortiz@correo' });
    expect(r.checks[1]).toMatchObject({ resultado: 'error', texto: 'El correo de contacto parece incompleto' });
    expect(r.puedeCitar).toBe(false);
  });

  it('GS concertado: cupo asignado por la Junta', () => {
    const r = revisar({ ...base, via: { nombre: 'GS concertado', plazas: 0, plazasAsignadasPorJunta: true, ocupadas: 0 } });
    expect(r.checks[2]!.texto).toBe('GS concertado: cupo asignado por la Junta');
  });

  it('sin plazas libres es un aviso, no bloquea', () => {
    const r = revisar({ ...base, via: { ...base.via, plazas: 4, ocupadas: 4 } });
    expect(r.checks[2]!.resultado).toBe('aviso');
    expect(r.puedeCitar).toBe(true);
  });

  it('familia vinculada y SNEC son informativos', () => {
    const r = revisar({ ...base, asignadaSnec: true, familia: { vinculo: 'Hermana en 2º Bachillerato · Clara Márquez Peña' } });
    expect(r.checks[3]).toMatchObject({ resultado: 'aviso', texto: 'Familia ya vinculada al centro · Hermana en 2º Bachillerato · Clara Márquez Peña' });
    expect(r.checks[4]).toMatchObject({ resultado: 'aviso', texto: 'Solicitud asignada por la Junta (SNEC) · comprobar el cupo de la resolución' });
    expect(r.puedeCitar).toBe(true);
  });
});

describe('fechas en hora de Madrid', () => {
  it('convierte hora local a UTC en verano (UTC+2) y en invierno (UTC+1)', () => {
    expect(horaLocalAUtc('2026-09-01', '10:00').toISOString()).toBe('2026-09-01T08:00:00.000Z');
    expect(horaLocalAUtc('2026-12-01', '10:00').toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });
  it('acierta el día del cambio de hora (25 oct 2026)', () => {
    expect(horaLocalAUtc('2026-10-25', '17:00').toISOString()).toBe('2026-10-25T16:00:00.000Z');
  });
  it('formatea como en la página de cita', () => {
    const i = horaLocalAUtc('2026-09-01', '10:00');
    const f = horaLocalAUtc('2026-09-01', '10:45');
    expect(diaLargo(i)).toBe('Martes 1 de septiembre');
    expect(franja(i, f)).toBe('10:00 – 10:45');
    expect(fechaLocal(horaLocalAUtc('2026-09-01', '00:30'))).toBe('2026-09-01');
  });
});

describe('invitación .ics', () => {
  it('genera un evento válido en UTC con alarma el día antes', () => {
    const ics = generarIcs({ uid: 'x', inicio: new Date('2026-09-01T08:00:00Z'), fin: new Date('2026-09-01T08:45:00Z'), titulo: 'Entrevista, admisión; prueba', descripcion: 'a', lugar: 'Sala' });
    expect(ics).toContain('DTSTART:20260901T080000Z');
    expect(ics).toContain('SUMMARY:Entrevista\\, admisión\\; prueba');
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
  it('la cancelación usa METHOD:CANCEL', () => {
    const ics = generarIcs({ uid: 'x', inicio: new Date(), fin: new Date(), titulo: 't', descripcion: 'd', lugar: 'l', cancelar: true, secuencia: 2 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('SEQUENCE:2');
  });
});

describe('pipeline y transiciones', () => {
  it('agrupa estados en las columnas del kanban', () => {
    expect(columnaDe('RECIBIDA')).toBe('nueva');
    expect(columnaDe('OTRA_FRANJA_SOLICITADA')).toBe('entrevista');
    expect(columnaDe('EN_ESPERA')).toBe('evaluada');
    expect(columnaDe('DESCARTADA')).toBeNull();
  });
  it('no permite saltarse acciones con efectos', () => {
    expect(puedeTransicionar('EN_REVISION', 'CITACION_ENVIADA')).toBe(false);
    expect(puedeTransicionar('ENTREVISTA_REALIZADA', 'ADMITIDA')).toBe(true);
  });
  it('cada tarjeta dice a dónde se puede mover y con qué acción', () => {
    const todo = { editar: true, evaluar: true, cobrar: true, puedeCitar: true, reservaPendiente: true };
    expect(siguientesEstados('EN_REVISION', todo)).toEqual([
      { estado: 'RECIBIDA', columna: 'nueva' },
      { estado: 'DESCARTADA', columna: null },
      { estado: 'PENDIENTE_COMPLETAR', columna: 'nueva', accion: 'PEDIR_QUE_COMPLETE' },
      { estado: 'CITACION_ENVIADA', columna: 'entrevista', accion: 'CITAR_A_ENTREVISTA' },
      { estado: 'ENTREVISTA_REALIZADA', columna: 'evaluada', accion: 'REGISTRAR_ENTREVISTA_PREVIA' },
    ]);
    // Incompleta: no se ofrece citar ni registrar una entrevista previa.
    expect(siguientesEstados('EN_REVISION', { ...todo, puedeCitar: false }).map((s) => s.estado)).not.toContain('CITACION_ENVIADA');
    expect(siguientesEstados('EN_REVISION', { ...todo, puedeCitar: false }).map((s) => s.estado)).not.toContain('ENTREVISTA_REALIZADA');
    // Con la entrevista ya programada, el resultado se registra en ella, no como entrevista previa.
    expect(siguientesEstados('ENTREVISTA_PROGRAMADA', todo).map((s) => s.accion)).not.toContain('REGISTRAR_ENTREVISTA_PREVIA');
    // Sin evaluacion.editar no se ofrecen las decisiones de admisión.
    expect(siguientesEstados('ENTREVISTA_REALIZADA', { ...todo, evaluar: false })).toEqual([]);
    // Las decisiones van por "Registrar decisión" (notifica y crea la reserva).
    expect(siguientesEstados('ENTREVISTA_REALIZADA', todo)).toEqual([
      { estado: 'ADMITIDA', columna: 'evaluada', accion: 'DECIDIR' },
      { estado: 'EN_ESPERA', columna: 'evaluada', accion: 'DECIDIR' },
      { estado: 'NO_ADMITIDA', columna: null, accion: 'DECIDIR' },
    ]);
    // Admitida: "Registrar cobro" solo con cobros.editar.
    expect(siguientesEstados('ADMITIDA', todo)).toContainEqual({ estado: 'PLAZA_RESERVADA', columna: 'reserva', accion: 'REGISTRAR_COBRO' });
    expect(siguientesEstados('ADMITIDA', { ...todo, cobrar: false }).map((s) => s.estado)).not.toContain('PLAZA_RESERVADA');
    // Admitida sin reserva pendiente (p. ej. ya pagada o anulada): no hay nada que cobrar.
    expect(siguientesEstados('ADMITIDA', { ...todo, reservaPendiente: false }).map((s) => s.estado)).not.toContain('PLAZA_RESERVADA');
    // Solo lectura: nada.
    expect(siguientesEstados('RECIBIDA', { ...todo, editar: false })).toEqual([]);
  });
});

describe('reserva de plaza: importes, IBAN y plazos', () => {
  it('importes en céntimos con formato español (espacio de no separación antes de €)', () => {
    expect(euros(30000)).toBe('300,00 €');
    expect(euros(18030)).toBe('180,30 €');
    expect(euros(123456)).toBe('1.234,56 €');
  });
  it('valida el IBAN por sus dígitos de control', () => {
    expect(ibanValido('ES91 2100 0418 4502 0005 1332')).toBe(true);
    expect(ibanValido('es9121000418450200051332')).toBe(true);
    expect(ibanValido('ES92 2100 0418 4502 0005 1332')).toBe(false); // un dígito mal
    expect(ibanValido('ES91 2100 0418')).toBe(false);
    expect(formatearIban('ES9121000418450200051332')).toBe('ES91 2100 0418 4502 0005 1332');
  });
  it('días que quedan y fechas como en los correos', () => {
    expect(diasRestantes('2026-11-05', '2026-10-21')).toBe(15);
    expect(diasRestantes('2026-10-20', '2026-10-21')).toBe(-1);
    expect(diasRestantes('2026-10-25', '2026-10-24')).toBe(1); // cruza el cambio de hora
    expect(fechaTexto('2026-11-05')).toBe('jueves 5 de noviembre');
    expect(cursoEscolarCorto('2027-2028')).toBe('2027/28');
  });
});

describe('tipo real de los ficheros subidos', () => {
  it('reconoce PDF y rechaza lo demás', () => {
    expect(tipoReal(Buffer.from('%PDF-1.7\n...'))?.mime).toBe('application/pdf');
    expect(tipoReal(Buffer.from('MZ ejecutable'))).toBeNull();
  });
});

describe('motor de plantillas de correo', async () => {
  const { renderizar, sanear, variablesDesconocidas, htmlATexto, lista } = await import('../src/correo/plantillas');
  const { evento, EVENTOS } = await import('../src/correo/eventos');

  it('escapa las variables de texto y respeta las de tipo HTML', () => {
    const c = renderizar({
      evento: 'COMPLETAR_SOLICITUD',
      asunto: 'Hola {{tutor}}',
      cuerpoHtml: '<p>{{alumna}}</p>{{campos}}',
      vars: { tutor: 'Ana', alumna: '<b>Lucía</b>', campos: lista(['Centro']) },
    });
    expect(c.asunto).toBe('Hola Ana');
    expect(c.html).toContain('&lt;b&gt;Lucía&lt;/b&gt;');
    expect(c.html).toContain('<li style="margin:5px 0">Centro</li>');
    expect(c.texto).toContain('- Centro');
  });

  it('quita párrafos de variables opcionales vacías', () => {
    const c = renderizar({ evento: 'COMPLETAR_SOLICITUD', asunto: 'x', cuerpoHtml: '<p>a</p><p>{{mensaje}}</p>', vars: { mensaje: '' } });
    expect(c.html).not.toMatch(/<p[^>]*>\s*<\/p>/);
  });

  it('detecta variables mal escritas', () => {
    expect(variablesDesconocidas(evento('CITA_CONFIRMADA')!, 'Hola {{alumna}} {{alumno}}')).toEqual(['alumno']);
  });

  it('las plantillas predeterminadas solo usan variables de su evento', () => {
    for (const e of EVENTOS) expect(variablesDesconocidas(e, e.predeterminada.asunto, e.predeterminada.cuerpoHtml), e.clave).toEqual([]);
  });

  it('el saneado quita scripts y manejadores pero conserva {{enlace}} en href', () => {
    const h = sanear('<p onclick="x()" style="color:red">a</p><script>alert(1)</script><a href="{{enlace}}">b</a><a href="javascript:alert(1)">c</a>');
    expect(h).toBe('<p style="color:red">a</p><a href="{{enlace}}">b</a><a>c</a>');
  });

  it('texto plano con los enlaces visibles', () => {
    expect(htmlATexto('<p>Hola</p><a href="https://x.es/a">Elegir</a>')).toBe('Hola\nElegir (https://x.es/a)');
  });
});

describe('agenda: jornada laboral', async () => {
  const { dentroDeJornada } = await import('../src/modules/agenda/agenda.service');
  const { AGENDA_POR_DEFECTO: cfg } = await import('../src/modules/ajustes/ajustes.service');
  const f = (d: string, h: string, min: number) => {
    const i = horaLocalAUtc(d, h);
    return [i, new Date(i.getTime() + min * 60_000)] as const;
  };
  it('lunes a viernes de 8:00 a 18:00', () => {
    expect(dentroDeJornada(...f('2026-11-02', '08:00', 60), cfg)).toBeNull();
    expect(dentroDeJornada(...f('2026-11-02', '17:00', 60), cfg)).toBeNull();
    expect(dentroDeJornada(...f('2026-11-02', '17:30', 60), cfg)).toMatch(/Fuera del horario/);
    expect(dentroDeJornada(...f('2026-11-02', '07:30', 45), cfg)).toMatch(/Fuera del horario/);
    expect(dentroDeJornada(...f('2026-11-07', '10:00', 45), cfg)).toMatch(/no hay entrevistas/); // sábado
  });
  it('respeta los días no lectivos', () => {
    expect(dentroDeJornada(...f('2026-12-08', '10:00', 45), { ...cfg, diasNoLectivos: ['2026-12-08'] })).toMatch(/no lectivo/);
  });
});

describe('agenda: nunca el mismo día', async () => {
  const { primerInicioPermitido } = await import('../src/modules/agenda/agenda.service');
  const { AGENDA_POR_DEFECTO: cfg } = await import('../src/modules/ajustes/ajustes.service');
  const { diaSiguiente } = await import('../src/lib/fechas');

  it('por defecto no se permite el mismo día: lo primero es mañana a las 00:00 del centro', () => {
    expect(cfg.permitirMismoDia).toBe(false);
    const ahora = horaLocalAUtc('2026-11-02', '09:00');
    const r = primerInicioPermitido(cfg, ahora);
    expect(r.manana).toEqual(horaLocalAUtc('2026-11-03', '00:00'));
    expect(r.desde).toEqual(r.manana);
    expect(r.antelacion).toEqual(horaLocalAUtc('2026-11-02', '11:00'));
  });

  it('a última hora manda la antelación si cae ya en el día siguiente', () => {
    const r = primerInicioPermitido({ ...cfg, antelacionMinHoras: 4 }, horaLocalAUtc('2026-11-02', '22:30'));
    expect(r.desde).toEqual(horaLocalAUtc('2026-11-03', '02:30'));
  });

  it('con permitirMismoDia sólo cuenta la antelación', () => {
    const ahora = horaLocalAUtc('2026-11-02', '09:00');
    const r = primerInicioPermitido({ ...cfg, permitirMismoDia: true }, ahora);
    expect(r.manana).toBeNull();
    expect(r.desde).toEqual(horaLocalAUtc('2026-11-02', '11:00'));
  });

  it('día siguiente sin depender del cambio de hora ni del fin de mes', () => {
    expect(diaSiguiente('2026-10-24')).toBe('2026-10-25');
    expect(diaSiguiente('2026-10-25')).toBe('2026-10-26'); // cambio de hora en España
    expect(diaSiguiente('2026-12-31')).toBe('2027-01-01');
  });
});
