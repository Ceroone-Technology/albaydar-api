CREATE TABLE "ciclos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"familia" "familia_via" NOT NULL,
	"nombre" text NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "ciclos_familia_nombre_uq" UNIQUE("familia","nombre"),
	CONSTRAINT "ciclos_familia_chk" CHECK ("ciclos"."familia" <> 'BACHILLERATO')
);
--> statement-breakpoint
ALTER TABLE "solicitudes" ADD COLUMN "ciclo_id" uuid;--> statement-breakpoint
ALTER TABLE "solicitudes" ADD CONSTRAINT "solicitudes_ciclo_id_ciclos_id_fk" FOREIGN KEY ("ciclo_id") REFERENCES "public"."ciclos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Ajuste A6 (correo del centro, 11/11/2026): los 8 ciclos que imparte Albaydar.
INSERT INTO "ciclos" ("familia", "nombre", "orden") VALUES
	('CICLOS_CONCERTADOS_GM', 'Actividades Comerciales', 1),
	('CICLOS_CONCERTADOS_GM', 'Gestión Administrativa', 2),
	('CICLOS_CONCERTADOS_GS', 'Administración y Finanzas', 1),
	('CICLOS_CONCERTADOS_GS', 'Asistencia a la Dirección', 2),
	('CICLOS_CONCERTADOS_GS', 'Comercio Internacional', 3),
	('CICLOS_CONCERTADOS_GS', 'Educación Infantil', 4),
	('CICLOS_PRIVADOS_GS', 'Integración Social', 1),
	('CICLOS_PRIVADOS_GS', 'Marketing y Publicidad', 2)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Solicitudes ya creadas: el ciclo sale de «Modalidad que le interesa» si coincide con uno de su familia.
UPDATE "solicitudes" s
SET "ciclo_id" = c."id"
FROM "vias" v, "ciclos" c
WHERE v."id" = s."via_id"
	AND c."familia" = v."familia"
	AND s."ciclo_id" IS NULL
	AND lower(trim(s."modalidad_interes")) = lower(c."nombre");
