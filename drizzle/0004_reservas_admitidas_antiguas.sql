-- Solicitudes admitidas antes de existir la reserva de plaza (con el cambio de estado antiguo):
-- se les crea su reserva con el importe y el plazo configurados, contando el plazo desde hoy,
-- porque a esas familias nunca se les comunicaron los datos de pago.
-- No se envía ningún correo: secretaría o administración pueden usar «Recordar» para mandarlos.
WITH cfg AS (
  SELECT valor FROM ajustes WHERE clave = 'reserva'
), nuevas AS (
  INSERT INTO reservas (solicitud_id, importe, fecha_limite)
  SELECT s.id,
         COALESCE((cfg.valor -> 'importesPorVia' ->> v.familia::text)::int, (cfg.valor ->> 'importe')::int, 30000),
         (now() AT TIME ZONE 'Europe/Madrid')::date + COALESCE((cfg.valor ->> 'plazoDias')::int, 15)
  FROM solicitudes s
  JOIN vias v ON v.id = s.via_id
  LEFT JOIN cfg ON true
  WHERE s.estado = 'ADMITIDA'
    AND NOT EXISTS (SELECT 1 FROM reservas r WHERE r.solicitud_id = s.id AND r.estado <> 'ANULADA')
  RETURNING id, solicitud_id, fecha_limite
)
INSERT INTO solicitud_eventos (solicitud_id, tipo, actor, detalle)
SELECT solicitud_id, 'RESERVA_CREADA', 'sistema',
       jsonb_build_object('reservaId', id, 'fechaLimite', fecha_limite, 'motivo', 'Admitida antes de existir la reserva de plaza')
FROM nuevas;
