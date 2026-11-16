CREATE TABLE "plazas_ciclo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"via_id" uuid NOT NULL,
	"ciclo_id" uuid NOT NULL,
	"plazas" integer NOT NULL,
	CONSTRAINT "plazas_ciclo_via_ciclo_uq" UNIQUE("via_id","ciclo_id"),
	CONSTRAINT "plazas_ciclo_plazas_chk" CHECK ("plazas_ciclo"."plazas" >= 0)
);
--> statement-breakpoint
ALTER TABLE "plazas_ciclo" ADD CONSTRAINT "plazas_ciclo_via_id_vias_id_fk" FOREIGN KEY ("via_id") REFERENCES "public"."vias"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plazas_ciclo" ADD CONSTRAINT "plazas_ciclo_ciclo_id_ciclos_id_fk" FOREIGN KEY ("ciclo_id") REFERENCES "public"."ciclos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Ajuste A6, entrega 2 (correo del centro, 11/11/2026): 30 plazas por ciclo y curso, 60 en
-- Administración y Finanzas. Las plazas de cada vía de ciclos pasan a ser la suma de sus ciclos,
-- y GS concertado deja de ser «cupo asignado por la Junta» (decisión del 16/11/2026).
INSERT INTO "plazas_ciclo" ("via_id", "ciclo_id", "plazas")
SELECT v."id", c."id", CASE WHEN c."nombre" = 'Administración y Finanzas' THEN 60 ELSE 30 END
FROM "vias" v
JOIN "ciclos" c ON c."familia" = v."familia" AND c."activo"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "vias" v
SET "plazas" = s."total", "plazas_asignadas_por_junta" = false
FROM (SELECT "via_id", sum("plazas")::int AS "total" FROM "plazas_ciclo" GROUP BY "via_id") s
WHERE s."via_id" = v."id";
