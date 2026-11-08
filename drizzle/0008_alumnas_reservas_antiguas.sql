-- Solo datos (escrita a mano). Expediente para las solicitudes que ya tenían la plaza reservada
-- (o estaban matriculadas) antes del módulo de Alumnado: lo mismo que hace ahora el cobro que
-- completa la reserva (altaDesdeReserva). Numeración EXP-<año actual>-NNNN siguiendo la secuencia.
WITH anio AS (
  SELECT to_char(now() AT TIME ZONE 'Europe/Madrid', 'YYYY') AS y
),
previo AS (
  SELECT coalesce((SELECT s.valor FROM secuencias s, anio WHERE s.clave = 'expediente-' || anio.y), 0) AS v
),
base AS (
  SELECT
    s.id AS solicitud_id, s.codigo, s.alumna_nombre, s.alumna_apellidos, s.modalidad_interes,
    s.tutor_nombre, s.telefono,
    CASE WHEN trim(s.email) ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' THEN lower(trim(s.email)) END AS email,
    v.familia, v.curso, v.curso_escolar,
    (CASE WHEN s.estado = 'MATRICULADA' THEN 'MATRICULADA' ELSE 'RESERVA' END)::estado_alumna AS estado,
    coalesce((SELECT max(r.pagada_en) FROM reservas r WHERE r.solicitud_id = s.id AND r.estado = 'PAGADA'), s.updated_at) AS alta_en,
    row_number() OVER (ORDER BY s.created_at, s.id) AS n
  FROM solicitudes s
  JOIN vias v ON v.id = s.via_id
  WHERE s.estado IN ('PLAZA_RESERVADA', 'MATRICULADA')
    AND NOT EXISTS (SELECT 1 FROM alumnas a WHERE a.solicitud_id = s.id)
),
nuevas AS (
  INSERT INTO alumnas (expediente, nombre, apellidos, familia, curso, curso_escolar, estudios, estado, origen, solicitud_id, fecha_alta)
  SELECT 'EXP-' || anio.y || '-' || lpad((previo.v + b.n)::text, 4, '0'),
         b.alumna_nombre, b.alumna_apellidos, b.familia, b.curso, b.curso_escolar, b.modalidad_interes,
         b.estado, 'ADMISION', b.solicitud_id, (b.alta_en AT TIME ZONE 'Europe/Madrid')::date
  FROM base b, anio, previo
  RETURNING id, solicitud_id
),
contactos AS (
  INSERT INTO alumna_contactos (alumna_id, parentesco, nombre, telefono, email, principal)
  SELECT n.id, 'Madre, padre o tutor', b.tutor_nombre, b.telefono, b.email, true
  FROM nuevas n JOIN base b ON b.solicitud_id = n.solicitud_id
),
eventos AS (
  INSERT INTO alumna_eventos (alumna_id, tipo, texto)
  SELECT n.id, 'ALTA', 'Plaza reservada · solicitud ' || b.codigo || ' (expediente creado al instalar el módulo de Alumnado)'
  FROM nuevas n JOIN base b ON b.solicitud_id = n.solicitud_id
)
INSERT INTO secuencias (clave, valor)
SELECT 'expediente-' || anio.y, previo.v + (SELECT count(*) FROM base)
FROM anio, previo
WHERE EXISTS (SELECT 1 FROM base)
ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor;
