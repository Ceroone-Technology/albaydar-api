import { describe, expect, it } from 'vitest';
import { generarIcs } from '../src/correo/ics';
import { diaLargo, fechaLocal, franja, horaLocalAUtc } from '../src/lib/fechas';
import { tipoReal } from '../src/lib/storage';
import { columnaDe, puedeTransicionar } from '../src/modules/solicitudes/dominio';
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
});

describe('tipo real de los ficheros subidos', () => {
  it('reconoce PDF y rechaza lo demás', () => {
    expect(tipoReal(Buffer.from('%PDF-1.7\n...'))?.mime).toBe('application/pdf');
    expect(tipoReal(Buffer.from('MZ ejecutable'))).toBeNull();
  });
});
