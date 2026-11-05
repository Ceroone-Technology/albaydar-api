import { eurosCsv, fechaCsv, fechaHoraCsv, type Columna } from '../../lib/csv';
import { hora } from '../../lib/fechas';
import type * as cobros from '../cobros/cobros.service';
import type * as entrevistas from '../entrevistas/entrevistas.service';
import { ETIQUETA_ENTREVISTADO, ETIQUETA_MODALIDAD, ETIQUETA_VALORACION, etiquetaOptativa, type Ficha } from '../entrevistas/ficha';
import type * as reservas from '../reservas/reservas.service';
import type * as solicitudes from '../solicitudes/solicitudes.service';

/**
 * Columnas de cada exportación CSV. Cada una parte de las filas del listado de su
 * pantalla (mismos filtros), con los textos que ya se ven en la plataforma.
 */

type ItemSolicitud = Awaited<ReturnType<typeof solicitudes.listar>>['items'][number];
type ItemReserva = Awaited<ReturnType<typeof reservas.listar>>['items'][number];
type ItemCobro = Awaited<ReturnType<typeof cobros.listar>>['items'][number];
type ItemEntrevista = Awaited<ReturnType<typeof entrevistas.listar>>['items'][number];

/** Columnas de la ficha de la entrevista, compartidas por solicitudes y entrevistas. */
function columnasFicha<T>(ficha: (f: T) => Ficha | null | undefined, curso: (f: T) => number): Columna<T>[] {
  const si = (v: boolean | null | undefined, detalle?: string | null) => (v === null || v === undefined ? null : v ? (detalle ? `Sí · ${detalle}` : 'Sí') : 'No');
  return [
    { titulo: 'Valoración', valor: (f) => { const v = ficha(f)?.valoracion; return v ? ETIQUETA_VALORACION[v] : null; } },
    { titulo: 'Comentario de la valoración', valor: (f) => ficha(f)?.valoracionComentario },
    { titulo: 'Entrevistados', valor: (f) => ficha(f)?.entrevistados.map((e) => ETIQUETA_ENTREVISTADO[e]).join(', ') || null },
    { titulo: 'Entrevista realizada por', valor: (f) => ficha(f)?.realizadaPor },
    { titulo: 'Nota media', valor: (f) => ficha(f)?.notaMedia },
    { titulo: 'Modalidad', valor: (f) => { const m = ficha(f)?.modalidad; return m ? ETIQUETA_MODALIDAD[m] : null; } },
    { titulo: 'Optativa', valor: (f) => { const o = ficha(f)?.optativa; return o ? etiquetaOptativa(o, curso(f)) : null; } },
    { titulo: '¿Otro centro?', valor: (f) => si(ficha(f)?.otroCentro, ficha(f)?.otroCentroNombre) },
    { titulo: '¿Ha repetido?', valor: (f) => si(ficha(f)?.haRepetido, ficha(f)?.repeticionDetalle) },
    { titulo: '¿Por qué Albaydar?', valor: (f) => ficha(f)?.motivoEleccion },
    { titulo: 'Boletín entregado en mano', valor: (f) => (ficha(f)?.boletinEntregado ? (fechaCsv(ficha(f)?.fechaEntregaNotas) ?? 'Sí') : null) },
  ];
}

export const COLUMNAS_SOLICITUDES: Columna<ItemSolicitud>[] = [
  { titulo: 'Código', valor: (s) => s.codigo },
  { titulo: 'Fecha de solicitud', valor: (s) => fechaHoraCsv(s.creadaEn) },
  { titulo: 'Estado', valor: (s) => s.estadoEtiqueta },
  { titulo: 'Alumna', valor: (s) => s.alumna },
  { titulo: 'Etapa', valor: (s) => s.via.etiqueta },
  { titulo: 'Curso', valor: (s) => `${s.via.curso}º` },
  { titulo: 'Centro de procedencia', valor: (s) => s.centroProcedencia },
  { titulo: 'Modalidad de interés', valor: (s) => s.modalidadInteres },
  { titulo: 'Tutor/a', valor: (s) => s.tutor },
  { titulo: 'Correo', valor: (s) => s.email },
  { titulo: 'Teléfono', valor: (s) => s.telefono },
  { titulo: 'Origen', valor: (s) => s.origen },
  { titulo: 'Responsable', valor: (s) => s.responsable?.nombre },
  { titulo: 'Datos que faltan', valor: (s) => s.revision.faltan.join(', ') || null },
  { titulo: 'Boletín subido', valor: (s) => s.notasSubidas },
  { titulo: 'Entrevista', valor: (s) => (s.entrevista ? fechaHoraCsv(s.entrevista.inicio) : null) },
  { titulo: 'Estado de la entrevista', valor: (s) => s.entrevista?.estadoEtiqueta },
  ...columnasFicha<ItemSolicitud>((s) => s.entrevista?.ficha, (s) => s.via.curso),
  { titulo: 'Observaciones de la entrevista', valor: (s) => s.entrevista?.notas },
  { titulo: 'Posición en lista de espera', valor: (s) => s.posicionEspera },
  { titulo: 'Reserva', valor: (s) => s.reserva?.estadoEtiqueta },
  { titulo: 'Reserva: pendiente (€)', valor: (s) => eurosCsv(s.reserva?.pendiente) },
  { titulo: 'Reserva: fecha límite', valor: (s) => fechaCsv(s.reserva?.fechaLimite) },
];

export const COLUMNAS_RESERVAS: Columna<ItemReserva>[] = [
  { titulo: 'Código', valor: (r) => r.solicitud.codigo },
  { titulo: 'Alumna', valor: (r) => r.solicitud.alumna },
  { titulo: 'Etapa', valor: (r) => r.solicitud.via.nombre },
  { titulo: 'Tutor/a', valor: (r) => r.solicitud.tutor },
  { titulo: 'Correo', valor: (r) => r.solicitud.email },
  { titulo: 'Teléfono', valor: (r) => r.solicitud.telefono },
  { titulo: 'Estado', valor: (r) => r.estadoEtiqueta },
  { titulo: 'Admitida el', valor: (r) => fechaHoraCsv(r.creadaEn) },
  { titulo: 'Fecha límite', valor: (r) => fechaCsv(r.fechaLimite) },
  { titulo: 'Días restantes', valor: (r) => r.diasRestantes },
  { titulo: 'Importe (€)', valor: (r) => eurosCsv(r.importe) },
  { titulo: 'Pagado (€)', valor: (r) => eurosCsv(r.pagado) },
  { titulo: 'Pendiente (€)', valor: (r) => eurosCsv(r.pendiente) },
  { titulo: 'Pagada el', valor: (r) => fechaHoraCsv(r.pagadaEn) },
  { titulo: 'Recordatorio enviado', valor: (r) => fechaHoraCsv(r.recordatorioEnviadoEn) },
];

export const COLUMNAS_COBROS: Columna<ItemCobro>[] = [
  { titulo: 'Recibo', valor: (c) => c.reciboNumero },
  { titulo: 'Fecha', valor: (c) => fechaCsv(c.fecha) },
  { titulo: 'Código', valor: (c) => c.solicitud.codigo },
  { titulo: 'Alumna', valor: (c) => c.solicitud.alumna },
  { titulo: 'Etapa', valor: (c) => c.solicitud.via.nombre },
  { titulo: 'Concepto', valor: (c) => c.conceptoEtiqueta },
  { titulo: 'Forma de pago', valor: (c) => c.metodoEtiqueta },
  // Los anulados no suman: su importe va aparte para que la columna se pueda sumar.
  { titulo: 'Importe (€)', valor: (c) => (c.anulado ? null : eurosCsv(c.importe)) },
  { titulo: 'Importe anulado (€)', valor: (c) => (c.anulado ? eurosCsv(c.importe) : null) },
  { titulo: 'Estado', valor: (c) => (c.anulado ? 'Anulado' : 'Vigente') },
  { titulo: 'Motivo de anulación', valor: (c) => c.anulado?.motivo },
  { titulo: 'Anulado por', valor: (c) => c.anulado?.por },
  { titulo: 'Observaciones', valor: (c) => c.observaciones },
  { titulo: 'Registrado por', valor: (c) => c.registradoPor?.nombre },
  { titulo: 'Registrado el', valor: (c) => fechaHoraCsv(c.registradoEn) },
];

export const COLUMNAS_ENTREVISTAS: Columna<ItemEntrevista>[] = [
  { titulo: 'Fecha', valor: (e) => fechaHoraCsv(e.inicio).slice(0, 10) },
  { titulo: 'Hora', valor: (e) => `${hora(e.inicio)} – ${hora(e.fin)}` },
  { titulo: 'Estado', valor: (e) => e.estadoEtiqueta },
  { titulo: 'Código', valor: (e) => e.solicitud.codigo },
  { titulo: 'Alumna', valor: (e) => e.alumna },
  { titulo: 'Familia', valor: (e) => e.familia },
  { titulo: 'Teléfono', valor: (e) => e.telefono },
  { titulo: 'Etapa', valor: (e) => e.via },
  { titulo: 'Curso', valor: (e) => e.curso },
  { titulo: 'Entrevista con', valor: (e) => e.con },
  { titulo: 'Lugar', valor: (e) => e.lugar },
  { titulo: 'Boletín subido', valor: (e) => e.notasRecibidas },
  ...columnasFicha<ItemEntrevista>((e) => e.ficha, (e) => e.cursoNumero),
  { titulo: 'Observaciones', valor: (e) => e.notas },
];
