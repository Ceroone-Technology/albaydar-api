-- Notificaciones masivas (Comunicaciones › Notificaciones, 20/11/2026): avisos por correo al alumnado
-- de unos cursos o a sus familias. Cada correo de la cola apunta a su notificación.

CREATE TYPE "public"."destinatarios_notificacion" AS ENUM('FAMILIAS', 'ALUMNADO', 'AMBOS');--> statement-breakpoint
ALTER TYPE "public"."tipo_evento_alumna" ADD VALUE 'NOTIFICACION';--> statement-breakpoint
CREATE TABLE "notificaciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asunto" text NOT NULL,
	"mensaje" text NOT NULL,
	"destinatarios" "destinatarios_notificacion" NOT NULL,
	"curso_escolar" text NOT NULL,
	"grupos" jsonb NOT NULL,
	"alumnas" integer NOT NULL,
	"correos" integer NOT NULL,
	"enviada_por_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "correos_salientes" ADD COLUMN "notificacion_id" uuid;--> statement-breakpoint
ALTER TABLE "notificaciones" ADD CONSTRAINT "notificaciones_enviada_por_id_usuarios_id_fk" FOREIGN KEY ("enviada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correos_salientes" ADD CONSTRAINT "correos_salientes_notificacion_id_notificaciones_id_fk" FOREIGN KEY ("notificacion_id") REFERENCES "public"."notificaciones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "correos_notificacion_idx" ON "correos_salientes" USING btree ("notificacion_id");