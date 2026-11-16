CREATE TYPE "public"."estado_mandato" AS ENUM('VIGENTE', 'ANULADO');--> statement-breakpoint
CREATE TYPE "public"."secuencia_mandato" AS ENUM('RCUR', 'OOFF');--> statement-breakpoint
CREATE TYPE "public"."tipo_mandato" AS ENUM('SEPA', 'PLUS');--> statement-breakpoint
CREATE TABLE "documentos_matricula" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matricula_id" uuid NOT NULL,
	"documento" text NOT NULL,
	"version" text NOT NULL,
	"huella" text NOT NULL,
	"contenido" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documentos_matricula_huella_uq" UNIQUE("matricula_id","huella")
);
--> statement-breakpoint
CREATE TABLE "firmas_matricula" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matricula_id" uuid NOT NULL,
	"hueco" text NOT NULL,
	"documento" text NOT NULL,
	"version" text NOT NULL,
	"huella" text NOT NULL,
	"imagen" "bytea" NOT NULL,
	"imagen_sha256" text NOT NULL,
	"firmada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"enlace_id" uuid,
	"usuario_id" uuid,
	"anulada_en" timestamp with time zone,
	"motivo_anulacion" text
);
--> statement-breakpoint
CREATE TABLE "mandatos_sepa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matricula_id" uuid NOT NULL,
	"firma_id" uuid NOT NULL,
	"referencia" text NOT NULL,
	"tipo" "tipo_mandato" NOT NULL,
	"secuencia" "secuencia_mandato" NOT NULL,
	"esquema" text DEFAULT 'CORE' NOT NULL,
	"acreedor_identificador" text NOT NULL,
	"acreedor_nombre" text NOT NULL,
	"iban" text NOT NULL,
	"bic" text,
	"titular" text NOT NULL,
	"titular_documento" text NOT NULL,
	"fecha_firma" date NOT NULL,
	"estado" "estado_mandato" DEFAULT 'VIGENTE' NOT NULL,
	"anulado_en" timestamp with time zone,
	"motivo_anulacion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandatos_sepa_firma_id_unique" UNIQUE("firma_id"),
	CONSTRAINT "mandatos_sepa_referencia_unique" UNIQUE("referencia"),
	CONSTRAINT "mandatos_sepa_referencia_chk" CHECK (length("mandatos_sepa"."referencia") <= 35)
);
--> statement-breakpoint
ALTER TABLE "documentos_matricula" ADD CONSTRAINT "documentos_matricula_matricula_id_matriculas_id_fk" FOREIGN KEY ("matricula_id") REFERENCES "public"."matriculas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmas_matricula" ADD CONSTRAINT "firmas_matricula_matricula_id_matriculas_id_fk" FOREIGN KEY ("matricula_id") REFERENCES "public"."matriculas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmas_matricula" ADD CONSTRAINT "firmas_matricula_enlace_id_enlaces_matricula_id_fk" FOREIGN KEY ("enlace_id") REFERENCES "public"."enlaces_matricula"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmas_matricula" ADD CONSTRAINT "firmas_matricula_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandatos_sepa" ADD CONSTRAINT "mandatos_sepa_matricula_id_matriculas_id_fk" FOREIGN KEY ("matricula_id") REFERENCES "public"."matriculas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandatos_sepa" ADD CONSTRAINT "mandatos_sepa_firma_id_firmas_matricula_id_fk" FOREIGN KEY ("firma_id") REFERENCES "public"."firmas_matricula"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firmas_matricula_idx" ON "firmas_matricula" USING btree ("matricula_id");--> statement-breakpoint
CREATE UNIQUE INDEX "firmas_matricula_vigente_uq" ON "firmas_matricula" USING btree ("matricula_id","hueco") WHERE "firmas_matricula"."anulada_en" is null;--> statement-breakpoint
CREATE INDEX "mandatos_sepa_matricula_idx" ON "mandatos_sepa" USING btree ("matricula_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mandatos_sepa_vigente_uq" ON "mandatos_sepa" USING btree ("matricula_id","tipo") WHERE "mandatos_sepa"."estado" = 'VIGENTE';