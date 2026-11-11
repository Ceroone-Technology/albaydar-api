CREATE TABLE "archivos_matricula" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matricula_id" uuid NOT NULL,
	"destino" text NOT NULL,
	"tipo_conservacion" text NOT NULL,
	"conservar_hasta" date,
	"nombre_original" text NOT NULL,
	"mime" text NOT NULL,
	"tamano" integer NOT NULL,
	"clave" text NOT NULL,
	"sha256" text NOT NULL,
	"enlace_id" uuid,
	"usuario_id" uuid,
	"eliminado_en" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pdfs_matricula" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matricula_id" uuid NOT NULL,
	"documento" text NOT NULL,
	"huella" text NOT NULL,
	"clave" text NOT NULL,
	"sha256" text NOT NULL,
	"tamano" integer NOT NULL,
	"anulado_en" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archivos_matricula" ADD CONSTRAINT "archivos_matricula_matricula_id_matriculas_id_fk" FOREIGN KEY ("matricula_id") REFERENCES "public"."matriculas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archivos_matricula" ADD CONSTRAINT "archivos_matricula_enlace_id_enlaces_matricula_id_fk" FOREIGN KEY ("enlace_id") REFERENCES "public"."enlaces_matricula"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archivos_matricula" ADD CONSTRAINT "archivos_matricula_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdfs_matricula" ADD CONSTRAINT "pdfs_matricula_matricula_id_matriculas_id_fk" FOREIGN KEY ("matricula_id") REFERENCES "public"."matriculas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archivos_matricula_idx" ON "archivos_matricula" USING btree ("matricula_id");--> statement-breakpoint
CREATE UNIQUE INDEX "archivos_matricula_vigente_uq" ON "archivos_matricula" USING btree ("matricula_id","destino") WHERE "archivos_matricula"."eliminado_en" is null;--> statement-breakpoint
CREATE INDEX "pdfs_matricula_idx" ON "pdfs_matricula" USING btree ("matricula_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pdfs_matricula_vigente_uq" ON "pdfs_matricula" USING btree ("matricula_id","documento") WHERE "pdfs_matricula"."anulado_en" is null;