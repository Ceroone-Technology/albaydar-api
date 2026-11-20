-- Indicadores (reunión del 18/11/2026): módulo aparte, de serie solo para Dirección (ver y editar,
-- como todo) y Administración (ver). Las bases nuevas lo traen de la siembra (ROLES_INICIALES); en las
-- que ya existen se añade si el rol aún no lo tiene. Dirección lo puede cambiar después en la matriz.
UPDATE "roles"
SET "permisos" = "permisos" || ARRAY['indicadores.ver', 'indicadores.editar']::text[]
WHERE "codigo" = 'DIRECCION'
  AND NOT ("permisos" @> ARRAY['indicadores.ver']::text[]);
--> statement-breakpoint
UPDATE "roles"
SET "permisos" = "permisos" || ARRAY['indicadores.ver']::text[]
WHERE "codigo" = 'ADMINISTRACION'
  AND NOT ("permisos" @> ARRAY['indicadores.ver']::text[]);
