CREATE TABLE "entrevistadores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"email" text,
	"activo" boolean DEFAULT true NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solicitud_responsables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"solicitud_id" uuid NOT NULL,
	"usuario_id" uuid,
	"entrevistador_id" uuid,
	"orden" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "solicitud_responsables_usuario_uq" UNIQUE("solicitud_id","usuario_id"),
	CONSTRAINT "solicitud_responsables_entrevistador_uq" UNIQUE("solicitud_id","entrevistador_id"),
	CONSTRAINT "solicitud_responsables_uno_chk" CHECK (("solicitud_responsables"."usuario_id" is null) <> ("solicitud_responsables"."entrevistador_id" is null))
);
--> statement-breakpoint
ALTER TABLE "solicitudes" DROP CONSTRAINT "solicitudes_responsable_id_usuarios_id_fk";
--> statement-breakpoint
ALTER TABLE "solicitud_responsables" ADD CONSTRAINT "solicitud_responsables_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solicitud_responsables" ADD CONSTRAINT "solicitud_responsables_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solicitud_responsables" ADD CONSTRAINT "solicitud_responsables_entrevistador_id_entrevistadores_id_fk" FOREIGN KEY ("entrevistador_id") REFERENCES "public"."entrevistadores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "solicitud_responsables_solicitud_idx" ON "solicitud_responsables" USING btree ("solicitud_id");--> statement-breakpoint
-- Los responsables que ya había pasan a la tabla nueva antes de retirar la columna.
INSERT INTO "solicitud_responsables" ("solicitud_id", "usuario_id", "orden")
SELECT "id", "responsable_id", 0 FROM "solicitudes" WHERE "responsable_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "solicitudes" DROP COLUMN "responsable_id";