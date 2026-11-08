CREATE TYPE "public"."alcance_enlace" AS ENUM('FAMILIA', 'PROGENITOR');--> statement-breakpoint
CREATE TYPE "public"."estado_matricula" AS ENUM('BORRADOR', 'ENVIADA', 'EXPORTADA');--> statement-breakpoint
CREATE TABLE "enlaces_matricula" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matricula_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"alcance" "alcance_enlace" NOT NULL,
	"progenitor" text,
	"enviado_a" text,
	"expira_en" timestamp with time zone NOT NULL,
	"revocado_en" timestamp with time zone,
	"ultimo_uso_en" timestamp with time zone,
	"creado_por_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enlaces_matricula_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "enlaces_matricula_progenitor_chk" CHECK (("enlaces_matricula"."alcance" = 'PROGENITOR') = ("enlaces_matricula"."progenitor" in ('padre', 'madre')))
);
--> statement-breakpoint
CREATE TABLE "matricula_eventos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matricula_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"texto" text,
	"detalle" jsonb,
	"actor" text NOT NULL,
	"usuario_id" uuid,
	"enlace_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matriculas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" text NOT NULL,
	"alumna_id" uuid NOT NULL,
	"solicitud_id" uuid,
	"curso_escolar" text NOT NULL,
	"familia" "familia_via" NOT NULL,
	"curso" integer NOT NULL,
	"nueva_alumna" boolean NOT NULL,
	"estado" "estado_matricula" DEFAULT 'BORRADOR' NOT NULL,
	"datos" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"paginas_leidas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"guardado_en" timestamp with time zone,
	"guardado_por" text,
	"guardado_por_id" uuid,
	"enviada_en" timestamp with time zone,
	"exportada_en" timestamp with time zone,
	"devuelta_en" timestamp with time zone,
	"motivo_devolucion" text,
	"creada_por_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matriculas_codigo_unique" UNIQUE("codigo"),
	CONSTRAINT "matriculas_alumna_curso_escolar_uq" UNIQUE("alumna_id","curso_escolar"),
	CONSTRAINT "matriculas_curso_chk" CHECK ("matriculas"."curso" in (1, 2)),
	CONSTRAINT "matriculas_version_chk" CHECK ("matriculas"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "enlaces_matricula" ADD CONSTRAINT "enlaces_matricula_matricula_id_matriculas_id_fk" FOREIGN KEY ("matricula_id") REFERENCES "public"."matriculas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enlaces_matricula" ADD CONSTRAINT "enlaces_matricula_creado_por_id_usuarios_id_fk" FOREIGN KEY ("creado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matricula_eventos" ADD CONSTRAINT "matricula_eventos_matricula_id_matriculas_id_fk" FOREIGN KEY ("matricula_id") REFERENCES "public"."matriculas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matricula_eventos" ADD CONSTRAINT "matricula_eventos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matricula_eventos" ADD CONSTRAINT "matricula_eventos_enlace_id_enlaces_matricula_id_fk" FOREIGN KEY ("enlace_id") REFERENCES "public"."enlaces_matricula"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matriculas" ADD CONSTRAINT "matriculas_alumna_id_alumnas_id_fk" FOREIGN KEY ("alumna_id") REFERENCES "public"."alumnas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matriculas" ADD CONSTRAINT "matriculas_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matriculas" ADD CONSTRAINT "matriculas_guardado_por_id_usuarios_id_fk" FOREIGN KEY ("guardado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matriculas" ADD CONSTRAINT "matriculas_creada_por_id_usuarios_id_fk" FOREIGN KEY ("creada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enlaces_matricula_idx" ON "enlaces_matricula" USING btree ("matricula_id");--> statement-breakpoint
CREATE INDEX "matricula_eventos_idx" ON "matricula_eventos" USING btree ("matricula_id","created_at");--> statement-breakpoint
CREATE INDEX "matriculas_estado_idx" ON "matriculas" USING btree ("estado","curso_escolar");