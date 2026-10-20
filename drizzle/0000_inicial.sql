CREATE TYPE "public"."canal_solicitud" AS ENUM('SOLICITUD_WEB', 'TELEFONO', 'PRESENCIAL', 'PUERTAS_ABIERTAS', 'HERMANA_EN_EL_CENTRO');--> statement-breakpoint
CREATE TYPE "public"."estado_correo" AS ENUM('PENDIENTE', 'ENVIANDO', 'ENVIADO', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."estado_entrevista" AS ENUM('PROGRAMADA', 'REPROGRAMADA', 'REALIZADA', 'NO_PRESENTADA', 'CANCELADA');--> statement-breakpoint
CREATE TYPE "public"."estado_hueco" AS ENUM('LIBRE', 'OCUPADO', 'BLOQUEADO');--> statement-breakpoint
CREATE TYPE "public"."estado_propuesta" AS ENUM('PENDIENTE', 'CONFIRMADA', 'OTRA_FRANJA', 'ANULADA', 'CADUCADA');--> statement-breakpoint
CREATE TYPE "public"."estado_solicitud" AS ENUM('RECIBIDA', 'EN_REVISION', 'PENDIENTE_COMPLETAR', 'CITACION_ENVIADA', 'OTRA_FRANJA_SOLICITADA', 'ENTREVISTA_PROGRAMADA', 'ENTREVISTA_REALIZADA', 'EN_ESPERA', 'ADMITIDA', 'NO_ADMITIDA', 'PLAZA_RESERVADA', 'MATRICULADA', 'DESCARTADA');--> statement-breakpoint
CREATE TYPE "public"."familia_via" AS ENUM('BACHILLERATO', 'CICLOS_CONCERTADOS_GM', 'CICLOS_CONCERTADOS_GS', 'CICLOS_PRIVADOS_GS');--> statement-breakpoint
CREATE TYPE "public"."proposito_token" AS ENUM('ELEGIR_CITA', 'COMPLETAR_SOLICITUD');--> statement-breakpoint
CREATE TYPE "public"."rol" AS ENUM('ADMIN', 'DIRECCION', 'SECRETARIA', 'ADMINISTRACION', 'PROFESORADO');--> statement-breakpoint
CREATE TYPE "public"."tipo_documento" AS ENUM('BOLETIN_NOTAS');--> statement-breakpoint
CREATE TABLE "correos_salientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plantilla" text NOT NULL,
	"para" text NOT NULL,
	"asunto" text NOT NULL,
	"html" text NOT NULL,
	"texto" text NOT NULL,
	"adjuntos" jsonb,
	"estado" "estado_correo" DEFAULT 'PENDIENTE' NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"ultimo_error" text,
	"programado_para" timestamp with time zone DEFAULT now() NOT NULL,
	"reclamado_en" timestamp with time zone,
	"enviado_en" timestamp with time zone,
	"solicitud_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"solicitud_id" uuid NOT NULL,
	"tipo" "tipo_documento" NOT NULL,
	"nombre_original" text NOT NULL,
	"mime" text NOT NULL,
	"tamano" integer NOT NULL,
	"clave" text NOT NULL,
	"sha256" text NOT NULL,
	"subido_por" text DEFAULT 'familia' NOT NULL,
	"eliminado_en" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entrevistas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"solicitud_id" uuid NOT NULL,
	"propuesta_id" uuid,
	"hueco_id" uuid,
	"inicio" timestamp with time zone NOT NULL,
	"fin" timestamp with time zone NOT NULL,
	"lugar" text NOT NULL,
	"modalidad" text DEFAULT 'PRESENCIAL' NOT NULL,
	"estado" "estado_entrevista" DEFAULT 'PROGRAMADA' NOT NULL,
	"notas" text,
	"secuencia_ics" integer DEFAULT 0 NOT NULL,
	"recordatorio_enviado_en" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entrevistas_propuesta_id_unique" UNIQUE("propuesta_id"),
	CONSTRAINT "entrevistas_hueco_id_unique" UNIQUE("hueco_id"),
	CONSTRAINT "entrevistas_presencial_chk" CHECK ("entrevistas"."modalidad" = 'PRESENCIAL')
);
--> statement-breakpoint
CREATE TABLE "familias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"telefono" text,
	"nombre" text NOT NULL,
	"vinculo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "familias_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "huecos_agenda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inicio" timestamp with time zone NOT NULL,
	"fin" timestamp with time zone NOT NULL,
	"lugar" text DEFAULT 'Sala de reuniones de Dirección' NOT NULL,
	"estado" "estado_hueco" DEFAULT 'LIBRE' NOT NULL,
	"creado_por_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "huecos_inicio_lugar_uq" UNIQUE("inicio","lugar"),
	CONSTRAINT "huecos_rango_chk" CHECK ("huecos_agenda"."fin" > "huecos_agenda"."inicio")
);
--> statement-breakpoint
CREATE TABLE "propuesta_huecos" (
	"propuesta_id" uuid NOT NULL,
	"hueco_id" uuid NOT NULL,
	"orden" integer NOT NULL,
	CONSTRAINT "propuesta_huecos_propuesta_id_hueco_id_pk" PRIMARY KEY("propuesta_id","hueco_id")
);
--> statement-breakpoint
CREATE TABLE "propuestas_cita" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"solicitud_id" uuid NOT NULL,
	"estado" "estado_propuesta" DEFAULT 'PENDIENTE' NOT NULL,
	"enviada_por_id" uuid,
	"mensaje" text,
	"franja_solicitada" text,
	"prefiere_llamada" boolean DEFAULT false NOT NULL,
	"respondida_en" timestamp with time zone,
	"recordatorio_enviado_en" timestamp with time zone,
	"expira_en" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"familia" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expira_en" timestamp with time zone NOT NULL,
	"revocado_en" timestamp with time zone,
	"reemplazado_por" uuid,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "secuencias" (
	"clave" text PRIMARY KEY NOT NULL,
	"valor" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solicitud_eventos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"solicitud_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"de_estado" "estado_solicitud",
	"a_estado" "estado_solicitud",
	"usuario_id" uuid,
	"actor" text DEFAULT 'usuario' NOT NULL,
	"detalle" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solicitudes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"estado" "estado_solicitud" DEFAULT 'RECIBIDA' NOT NULL,
	"via_id" uuid NOT NULL,
	"familia_id" uuid,
	"alumna_nombre" text NOT NULL,
	"alumna_apellidos" text NOT NULL,
	"alumna_fecha_nacimiento" date,
	"alumna_dni" text,
	"centro_procedencia" text,
	"curso_anterior" text,
	"modalidad_interes" text,
	"es_alumna_nueva" boolean DEFAULT true NOT NULL,
	"canal" "canal_solicitud" DEFAULT 'SOLICITUD_WEB' NOT NULL,
	"asignada_snec" boolean DEFAULT false NOT NULL,
	"tutor_nombre" text NOT NULL,
	"email" text NOT NULL,
	"telefono" text NOT NULL,
	"datos_extra" jsonb,
	"comentarios_familia" text,
	"consentimiento_privacidad" boolean NOT NULL,
	"consentimiento_en" timestamp with time zone NOT NULL,
	"responsable_id" uuid,
	"observaciones_internas" text,
	"revision" jsonb,
	"revisada_en" timestamp with time zone,
	"campos_pendientes" text[] DEFAULT '{}'::text[] NOT NULL,
	"ip_origen" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solicitudes_codigo_unique" UNIQUE("codigo"),
	CONSTRAINT "solicitudes_consentimiento_chk" CHECK ("solicitudes"."consentimiento_privacidad" = true)
);
--> statement-breakpoint
CREATE TABLE "tokens_publicos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposito" "proposito_token" NOT NULL,
	"token_hash" text NOT NULL,
	"solicitud_id" uuid NOT NULL,
	"propuesta_id" uuid,
	"expira_en" timestamp with time zone NOT NULL,
	"revocado_en" timestamp with time zone,
	"ultimo_uso_en" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_publicos_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"nombre" text NOT NULL,
	"password_hash" text NOT NULL,
	"roles" "rol"[] DEFAULT '{}'::rol[] NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"ultimo_acceso" timestamp with time zone,
	"intentos_fallidos" integer DEFAULT 0 NOT NULL,
	"bloqueado_hasta" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuarios_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"familia" "familia_via" NOT NULL,
	"curso" integer NOT NULL,
	"nombre" text NOT NULL,
	"curso_escolar" text NOT NULL,
	"plazas" integer NOT NULL,
	"plazas_asignadas_por_junta" boolean DEFAULT false NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	CONSTRAINT "vias_familia_curso_escolar_uq" UNIQUE("familia","curso","curso_escolar"),
	CONSTRAINT "vias_curso_chk" CHECK ("vias"."curso" in (1, 2)),
	CONSTRAINT "vias_plazas_chk" CHECK ("vias"."plazas" >= 0)
);
--> statement-breakpoint
ALTER TABLE "correos_salientes" ADD CONSTRAINT "correos_salientes_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentos" ADD CONSTRAINT "documentos_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entrevistas" ADD CONSTRAINT "entrevistas_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entrevistas" ADD CONSTRAINT "entrevistas_propuesta_id_propuestas_cita_id_fk" FOREIGN KEY ("propuesta_id") REFERENCES "public"."propuestas_cita"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entrevistas" ADD CONSTRAINT "entrevistas_hueco_id_huecos_agenda_id_fk" FOREIGN KEY ("hueco_id") REFERENCES "public"."huecos_agenda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "huecos_agenda" ADD CONSTRAINT "huecos_agenda_creado_por_id_usuarios_id_fk" FOREIGN KEY ("creado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propuesta_huecos" ADD CONSTRAINT "propuesta_huecos_propuesta_id_propuestas_cita_id_fk" FOREIGN KEY ("propuesta_id") REFERENCES "public"."propuestas_cita"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propuesta_huecos" ADD CONSTRAINT "propuesta_huecos_hueco_id_huecos_agenda_id_fk" FOREIGN KEY ("hueco_id") REFERENCES "public"."huecos_agenda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propuestas_cita" ADD CONSTRAINT "propuestas_cita_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propuestas_cita" ADD CONSTRAINT "propuestas_cita_enviada_por_id_usuarios_id_fk" FOREIGN KEY ("enviada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solicitud_eventos" ADD CONSTRAINT "solicitud_eventos_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solicitud_eventos" ADD CONSTRAINT "solicitud_eventos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solicitudes" ADD CONSTRAINT "solicitudes_via_id_vias_id_fk" FOREIGN KEY ("via_id") REFERENCES "public"."vias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solicitudes" ADD CONSTRAINT "solicitudes_familia_id_familias_id_fk" FOREIGN KEY ("familia_id") REFERENCES "public"."familias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solicitudes" ADD CONSTRAINT "solicitudes_responsable_id_usuarios_id_fk" FOREIGN KEY ("responsable_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens_publicos" ADD CONSTRAINT "tokens_publicos_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens_publicos" ADD CONSTRAINT "tokens_publicos_propuesta_id_propuestas_cita_id_fk" FOREIGN KEY ("propuesta_id") REFERENCES "public"."propuestas_cita"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "correos_estado_programado_idx" ON "correos_salientes" USING btree ("estado","programado_para");--> statement-breakpoint
CREATE INDEX "documentos_solicitud_idx" ON "documentos" USING btree ("solicitud_id","tipo");--> statement-breakpoint
CREATE INDEX "entrevistas_inicio_idx" ON "entrevistas" USING btree ("inicio");--> statement-breakpoint
CREATE INDEX "entrevistas_estado_inicio_idx" ON "entrevistas" USING btree ("estado","inicio");--> statement-breakpoint
CREATE INDEX "huecos_inicio_estado_idx" ON "huecos_agenda" USING btree ("inicio","estado");--> statement-breakpoint
CREATE INDEX "propuestas_solicitud_idx" ON "propuestas_cita" USING btree ("solicitud_id");--> statement-breakpoint
CREATE INDEX "propuestas_estado_created_idx" ON "propuestas_cita" USING btree ("estado","created_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_usuario_idx" ON "refresh_tokens" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_familia_idx" ON "refresh_tokens" USING btree ("familia");--> statement-breakpoint
CREATE INDEX "solicitud_eventos_solicitud_idx" ON "solicitud_eventos" USING btree ("solicitud_id","created_at");--> statement-breakpoint
CREATE INDEX "solicitudes_estado_idx" ON "solicitudes" USING btree ("estado");--> statement-breakpoint
CREATE INDEX "solicitudes_via_estado_idx" ON "solicitudes" USING btree ("via_id","estado");--> statement-breakpoint
CREATE INDEX "solicitudes_email_idx" ON "solicitudes" USING btree ("email");--> statement-breakpoint
CREATE INDEX "solicitudes_created_idx" ON "solicitudes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tokens_solicitud_proposito_idx" ON "tokens_publicos" USING btree ("solicitud_id","proposito");