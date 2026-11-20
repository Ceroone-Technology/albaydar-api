CREATE TYPE "public"."estado_interesado" AS ENUM('NUEVO', 'CONTACTADO', 'NUTRICION', 'SOLICITUD', 'PERDIDO');--> statement-breakpoint
CREATE TYPE "public"."motivo_perdida" AS ENUM('PRECIO', 'ELIGIO_PUBLICO', 'OTRO_PRIVADO', 'SIN_REQUISITOS', 'NO_CONTESTA', 'NO_INTERESA');--> statement-breakpoint
CREATE TYPE "public"."origen_interesado" AS ENUM('REDES', 'WEB', 'TELEFONO', 'EMAIL', 'FERIA', 'PORTAL', 'RECOMENDACION');--> statement-breakpoint
CREATE TYPE "public"."tipo_evento_interesado" AS ENUM('ALTA', 'EDICION', 'LLAMADA', 'NOTA', 'ESTADO', 'CORREO', 'SOLICITUD');--> statement-breakpoint
CREATE TABLE "interesado_eventos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interesado_id" uuid NOT NULL,
	"tipo" "tipo_evento_interesado" NOT NULL,
	"texto" text,
	"detalle" jsonb,
	"usuario_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interesados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estado" "estado_interesado" DEFAULT 'NUEVO' NOT NULL,
	"nombre" text NOT NULL,
	"telefono" text,
	"email" text,
	"familia" "familia_via",
	"ciclo_id" uuid,
	"origen" "origen_interesado" NOT NULL,
	"campana" text,
	"consentimiento_comunicaciones" boolean DEFAULT false NOT NULL,
	"es_menor" boolean,
	"tutor_nombre" text,
	"tutor_telefono" text,
	"estudios_actuales" text,
	"localidad" text,
	"motivacion" text,
	"otros_centros" text,
	"puntuacion" text,
	"asesor_id" uuid,
	"proxima_accion" text,
	"proxima_accion_el" date,
	"intentos" integer DEFAULT 0 NOT NULL,
	"ultimo_contacto_en" timestamp with time zone,
	"motivo_perdida" "motivo_perdida",
	"solicitud_id" uuid,
	"notas" text,
	"creado_por_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interesados_puntuacion_chk" CHECK ("interesados"."puntuacion" is null or "interesados"."puntuacion" in ('A', 'B', 'C')),
	CONSTRAINT "interesados_perdido_chk" CHECK (("interesados"."estado" = 'PERDIDO') = ("interesados"."motivo_perdida" is not null))
);
--> statement-breakpoint
ALTER TABLE "interesado_eventos" ADD CONSTRAINT "interesado_eventos_interesado_id_interesados_id_fk" FOREIGN KEY ("interesado_id") REFERENCES "public"."interesados"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interesado_eventos" ADD CONSTRAINT "interesado_eventos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interesados" ADD CONSTRAINT "interesados_ciclo_id_ciclos_id_fk" FOREIGN KEY ("ciclo_id") REFERENCES "public"."ciclos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interesados" ADD CONSTRAINT "interesados_asesor_id_usuarios_id_fk" FOREIGN KEY ("asesor_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interesados" ADD CONSTRAINT "interesados_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interesados" ADD CONSTRAINT "interesados_creado_por_id_usuarios_id_fk" FOREIGN KEY ("creado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interesado_eventos_interesado_idx" ON "interesado_eventos" USING btree ("interesado_id","created_at");--> statement-breakpoint
CREATE INDEX "interesados_estado_idx" ON "interesados" USING btree ("estado");--> statement-breakpoint
CREATE INDEX "interesados_email_idx" ON "interesados" USING btree ("email");--> statement-breakpoint
CREATE INDEX "interesados_telefono_idx" ON "interesados" USING btree ("telefono");--> statement-breakpoint
CREATE INDEX "interesados_proxima_idx" ON "interesados" USING btree ("proxima_accion_el");--> statement-breakpoint
-- CRM básico (18/11/2026): permisos de partida del módulo nuevo en las bases ya creadas (las nuevas
-- los traen de ROLES_INICIALES). Dirección (todo), Secretaría y Comercial / Promoción (ver y editar);
-- Administración, sin acceso. Dirección los puede cambiar en la matriz.
UPDATE "roles"
SET "permisos" = "permisos" || ARRAY['crm.ver', 'crm.editar']::text[]
WHERE "codigo" IN ('DIRECCION', 'SECRETARIA', 'COMERCIAL')
  AND NOT ("permisos" @> ARRAY['crm.ver']::text[]);
