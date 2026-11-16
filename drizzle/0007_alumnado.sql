CREATE TYPE "public"."estado_alumna" AS ENUM('RESERVA', 'EN_PROCESO', 'MATRICULADA', 'BAJA');--> statement-breakpoint
CREATE TYPE "public"."origen_alumna" AS ENUM('ADMISION', 'MANUAL', 'SENECA');--> statement-breakpoint
CREATE TYPE "public"."tipo_evento_alumna" AS ENUM('ALTA', 'EDICION', 'ESTADO', 'BAJA', 'REACTIVADA', 'NOTA');--> statement-breakpoint
CREATE TABLE "alumna_contactos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alumna_id" uuid NOT NULL,
	"parentesco" text NOT NULL,
	"nombre" text NOT NULL,
	"telefono" text NOT NULL,
	"email" text,
	"principal" boolean DEFAULT false NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alumna_eventos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alumna_id" uuid NOT NULL,
	"tipo" "tipo_evento_alumna" NOT NULL,
	"texto" text,
	"detalle" jsonb,
	"usuario_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alumnas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expediente" text NOT NULL,
	"nombre" text NOT NULL,
	"apellidos" text NOT NULL,
	"documento" text,
	"email" text,
	"telefono" text,
	"fecha_nacimiento" date,
	"domicilio" text,
	"familia" "familia_via" NOT NULL,
	"curso" integer NOT NULL,
	"curso_escolar" text NOT NULL,
	"estudios" text,
	"estado" "estado_alumna" NOT NULL,
	"origen" "origen_alumna" NOT NULL,
	"solicitud_id" uuid,
	"promociona" boolean,
	"fecha_alta" date NOT NULL,
	"fecha_baja" date,
	"motivo_baja" text,
	"creada_por_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumnas_expediente_unique" UNIQUE("expediente"),
	CONSTRAINT "alumnas_solicitud_id_unique" UNIQUE("solicitud_id"),
	CONSTRAINT "alumnas_curso_chk" CHECK ("alumnas"."curso" in (1, 2)),
	CONSTRAINT "alumnas_baja_chk" CHECK (("alumnas"."estado" = 'BAJA') = ("alumnas"."fecha_baja" is not null))
);
--> statement-breakpoint
ALTER TABLE "alumna_contactos" ADD CONSTRAINT "alumna_contactos_alumna_id_alumnas_id_fk" FOREIGN KEY ("alumna_id") REFERENCES "public"."alumnas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumna_eventos" ADD CONSTRAINT "alumna_eventos_alumna_id_alumnas_id_fk" FOREIGN KEY ("alumna_id") REFERENCES "public"."alumnas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumna_eventos" ADD CONSTRAINT "alumna_eventos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumnas" ADD CONSTRAINT "alumnas_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumnas" ADD CONSTRAINT "alumnas_creada_por_id_usuarios_id_fk" FOREIGN KEY ("creada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alumna_contactos_alumna_idx" ON "alumna_contactos" USING btree ("alumna_id");--> statement-breakpoint
CREATE INDEX "alumna_contactos_email_idx" ON "alumna_contactos" USING btree ("email");--> statement-breakpoint
CREATE INDEX "alumna_contactos_telefono_idx" ON "alumna_contactos" USING btree ("telefono");--> statement-breakpoint
CREATE UNIQUE INDEX "alumna_contactos_principal_uq" ON "alumna_contactos" USING btree ("alumna_id") WHERE "alumna_contactos"."principal";--> statement-breakpoint
CREATE INDEX "alumna_eventos_alumna_idx" ON "alumna_eventos" USING btree ("alumna_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alumnas_documento_uq" ON "alumnas" USING btree ("documento") WHERE "alumnas"."documento" is not null;--> statement-breakpoint
CREATE INDEX "alumnas_estado_idx" ON "alumnas" USING btree ("estado");--> statement-breakpoint
CREATE INDEX "alumnas_apellidos_idx" ON "alumnas" USING btree ("apellidos","nombre");