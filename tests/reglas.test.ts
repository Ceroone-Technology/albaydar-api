import { describe, expect, it } from 'vitest';
import { generarIcs } from '../src/correo/ics';
import { diaLargo, fechaLocal, franja, horaLocalAUtc } from '../src/lib/fechas';
import { tipoReal } from '../src/lib/storage';
import { bicValido, enmascararIban, euros, formatearIban, ibanSepaValido, ibanValido, identificadorAcreedorValido } from '../src/lib/dinero';
import { diasRestantes, fechaTexto } from '../src/modules/reservas/reservas.service';
import { columnaDe, cursoEscolarCorto, puedeTransicionar, siguientesEstados } from '../src/modules/solicitudes/dominio';
import { revisar, type EntradaRevision } from '../src/modules/solicitudes/revision';
import { combinarFicha, erroresFicha, faltanParaRealizada } from '../src/modules/entrevistas/ficha';
import { aCsv, eurosCsv, fechaCsv } from '../src/lib/csv';
import { documentoValido, normalizarDocumento } from '../src/lib/documento-identidad';
import { borradorSchema, borradorVacio } from '../src/modules/matricula/borrador';
import { caducidadEnlace, cursoEscolarSiguiente, formatoCodigoMatricula } from '../src/modules/matricula/dominio';
import { jsonCanonico } from '../src/modules/matricula/matricula.service';
import { MATRICULA_POR_DEFECTO } from '../src/modules/ajustes/ajustes.service';
import { cambiosEntre, contenidoFirmado, generarDocumento } from '../src/modules/matricula/documentos/generar';
import { canSubmit, enrollmentFlow, stepMissing } from '../src/modules/matricula/reglas';

const base: EntradaRevision = {
  alumnaNombre: 'Lucía',
  alumnaApellidos: 'Márquez Peña',
  tutorNombre: 'Elena Peña Ríos',
  email: 'epena@example.com',
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

describe('familia ya vinculada: alumnas del centro', () => {
  it('una alumna con el mismo contacto avisa con su nombre y expediente', () => {
    const r = revisar({ ...base, alumnas: [{ expediente: 'EXP-2026-0001', alumna: 'Clara Márquez Peña' }] });
    const familia = r.checks.find((c) => c.id === 'familia')!;
    expect(familia.resultado).toBe('aviso');
    expect(familia.texto).toBe('Familia ya vinculada al centro · alumna del centro Clara Márquez Peña (EXP-2026-0001)');
  });
});

describe('DNI y NIE', () => {
  it('normaliza y comprueba la letra', () => {
    expect(normalizarDocumento(' 12.345.678-z ')).toBe('12345678Z');
    expect(normalizarDocumento('y-4821533-b')).toBe('Y4821533B');
    expect(documentoValido('12345678Z')).toBe(true);
    expect(documentoValido('12345678A')).toBe(false);
    expect(documentoValido('X1234567L')).toBe(true);
    expect(documentoValido('Y4821533B')).toBe(true);
    expect(documentoValido('Z1234567R')).toBe(true);
    expect(documentoValido('1234567Z')).toBe(false);
    expect(documentoValido('A1234567L')).toBe(false);
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

describe('Ficha de la entrevista', () => {
  const ficha = (d: object) => combinarFicha(null, d as never);
  it('modalidad y optativa: coherentes y solo en Bachillerato', () => {
    expect(erroresFicha(ficha({ modalidad: 'HUMANIDADES_CCSS', optativa: 'LATIN' }), 'BACHILLERATO', '2026-11-05')).toEqual([]);
    expect(erroresFicha(ficha({ optativa: 'LATIN' }), 'BACHILLERATO', '2026-11-05')[0]!.campo).toBe('ficha.optativa');
    expect(erroresFicha(ficha({ modalidad: 'CIENCIAS_TECNOLOGIA' }), 'CICLOS_CONCERTADOS_GM', '2026-11-05')[0]!.campo).toBe('ficha.modalidad');
    expect(erroresFicha(ficha({ fechaEntregaNotas: '2026-11-06' }), 'BACHILLERATO', '2026-11-05')[0]!.campo).toBe('ficha.fechaEntregaNotas');
  });
  it('lo mínimo para darla por realizada', () => {
    expect(faltanParaRealizada(null)).toEqual(['valoracion', 'entrevistados']);
    expect(faltanParaRealizada(ficha({ valoracion: 'FAVORABLE', entrevistados: ['PADRE'] }))).toEqual([]);
  });
});

describe('CSV para Excel', () => {
  const cols = [
    { titulo: 'Texto', valor: (f: { t: string }) => f.t },
    { titulo: 'Número', valor: () => 8.5 },
    { titulo: 'Sí/No', valor: () => true },
    { titulo: 'Vacío', valor: () => null },
  ];
  it('separador ;, comillas, BOM y coma decimal', () => {
    const s = aCsv(cols, [{ t: 'Sevilla; "centro"\nnorte' }]);
    expect(s.startsWith('\uFEFF')).toBe(true);
    expect(s).toBe('\uFEFFTexto;Número;Sí/No;Vacío\r\n"Sevilla; ""centro""\nnorte";8,5;Sí;\r\n');
  });
  it('neutraliza fórmulas y deja los teléfonos como texto', () => {
    const fila = (t: string) => aCsv([cols[0]!], [{ t }]).split('\r\n')[1];
    expect(fila('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(fila('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(fila('-2+3')).toBe("'-2+3");
    expect(fila('+34 600 000 001')).toBe(' +34 600 000 001');
  });
  it('fechas y euros', () => {
    expect(fechaCsv('2026-11-05')).toBe('05/11/2026');
    expect(eurosCsv(30000)).toBe('300,00');
    expect(eurosCsv(null)).toBeNull();
  });
});

describe('Matrícula: borrador y reglas', () => {
  const exp = () => ({ ...borradorVacio(), photo: null, documents: {}, signatures: {} });

  it('el borrador vacío cumple el esquema estricto y uno con un campo de más no', () => {
    expect(borradorSchema.safeParse(borradorVacio()).success).toBe(true);
    expect(borradorSchema.safeParse({ ...borradorVacio(), otro: 1 }).success).toBe(false);
  });

  it('las reglas copiadas del front: flujo por vía y alumna nueva, y lo que falta por paso', () => {
    const d = { ...exp(), via: 'gs' as const, course: '2' as const };
    expect(enrollmentFlow(d, false)).toEqual(['student', 'family', 'annex', 'economic', 'documents', 'review']);
    expect(enrollmentFlow({ ...d, newStudent: true }, true)).toContain('ideario');
    expect(stepMissing(exp(), 'via')).toEqual(['via', 'course']);
    expect(stepMissing(d, 'student')).toContain('student.nuss'); // ciclos: NUSS
    expect(canSubmit(d)).toBe(false);
  });

  it('código, curso siguiente y caducidad del enlace', () => {
    expect(formatoCodigoMatricula('2027-2028', 7)).toBe('M-2027-0007');
    expect(cursoEscolarSiguiente('2026-2027')).toBe('2027-2028');
    const ahora = new Date('2027-06-10T10:00:00Z');
    expect(caducidadEnlace('2027-2028', ahora).toISOString()).toBe('2027-09-30T21:59:00.000Z');
    // Matrícula tardía: al menos 30 días.
    expect(caducidadEnlace('2027-2028', new Date('2027-09-20T10:00:00Z')).toISOString()).toBe('2027-10-20T10:00:00.000Z');
  });

  it('jsonCanonico no depende del orden de las claves (jsonb las reordena)', () => {
    expect(jsonCanonico({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(jsonCanonico({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(jsonCanonico({ a: 1 })).not.toBe(jsonCanonico({ a: 2 }));
  });
});

describe('Matrícula: documentos con huella y datos bancarios', () => {
  const exp = () => ({ ...borradorVacio(), via: 'bach' as const, course: '1' as const, photo: null, documents: {}, signatures: {} });
  const ctx = { familia: 'BACHILLERATO' as const, cursoEscolar: '2027-2028', config: MATRICULA_POR_DEFECTO };

  it('la huella no depende de la fecha (es la de la firma) pero sí de cualquier dato que se ve', () => {
    const e = exp();
    const a = generarDocumento('sepa', e, { ...ctx, fecha: new Date('2027-06-10T10:00:00Z') });
    const b = generarDocumento('sepa', e, { ...ctx, fecha: new Date('2027-07-01T10:00:00Z') });
    expect(a.huella).toBe(b.huella);
    expect(JSON.stringify(a)).toContain('10 de junio de 2027');
    const c = generarDocumento('sepa', { ...e, economic: { ...e.economic, sepa: { ...e.economic.sepa, iban: 'ES9121000418450200051332' } } }, ctx);
    expect(c.huella).not.toBe(a.huella);
    expect(cambiosEntre(contenidoFirmado(a), c)).toEqual(['Número de cuenta · IBAN']);
    // Un dato que no sale en el documento no cambia la huella.
    expect(generarDocumento('sepa', { ...e, pasen: { enabled: true, holder: 'X', phone: '1' } }, ctx).huella).toBe(a.huella);
  });

  it('GS concertado: acreedor propio y cargo único sin elección', () => {
    const e = { ...exp(), via: 'gs' as const };
    const d = generarDocumento('sepa', e, { ...ctx, familia: 'CICLOS_CONCERTADOS_GS' });
    expect(JSON.stringify(d)).toContain('ES09605G41829037');
    const opcion = d.paginas[0]!.bloques.find((b) => b.tipo === 'opcion');
    expect(opcion).toMatchObject({ aviso: null, opciones: [{ etiqueta: 'Pago único', marcada: true }] });
    expect(d.nota).toBe('Cargo único anual de 180,30 € en septiembre');
  });

  it('IBAN de la zona SEPA, BIC, identificador de acreedor (AT-02) y enmascarado', () => {
    expect(ibanSepaValido('es91 2100 0418 4502 0005 1332')).toBe(true);
    expect(ibanSepaValido('ES9121000418450200051333')).toBe(false); // control
    expect(ibanSepaValido('BR1800360305000010009795493C1')).toBe(false); // fuera de SEPA
    expect(bicValido('CAIXESBBXXX')).toBe(true);
    expect(bicValido('CAIXESB')).toBe(false);
    expect(identificadorAcreedorValido('ES09000G41829037')).toBe(true);
    expect(identificadorAcreedorValido('ES09605G41829037')).toBe(true); // el sufijo no cuenta en el control
    expect(identificadorAcreedorValido('G-41829037/605')).toBe(false);
    expect(enmascararIban('ES9121000418450200051332')).toBe('ES91 **** **** **** **** 1332');
  });
});
