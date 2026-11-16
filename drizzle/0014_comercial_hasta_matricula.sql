-- Ajuste A2 (respuesta del centro, 11/11/2026): el perfil Comercial / Promoción ve todo el proceso de
-- admisión hasta la matrícula, cobros incluidos (solo edita solicitudes). Las bases nuevas lo traen de
-- la siembra (ROLES_INICIALES). En las que ya existen se actualiza solo si el rol conserva los permisos
-- de partida: si Dirección ya los cambió en la matriz, no se toca.
UPDATE "roles"
SET "permisos" = ARRAY['solicitudes.ver', 'solicitudes.editar', 'dashboard.ver', 'alumnado.ver', 'entrevistas.ver', 'evaluacion.ver', 'matricula.ver', 'cobros.ver']::text[]
WHERE "codigo" = 'COMERCIAL'
  AND "permisos" @> ARRAY['solicitudes.ver', 'solicitudes.editar', 'dashboard.ver', 'alumnado.ver', 'entrevistas.ver']::text[]
  AND "permisos" <@ ARRAY['solicitudes.ver', 'solicitudes.editar', 'dashboard.ver', 'alumnado.ver', 'entrevistas.ver']::text[];
