CREATE TYPE "public"."concepto_cobro" AS ENUM('RESERVA_PLAZA');--> statement-breakpoint
CREATE TYPE "public"."estado_reserva" AS ENUM('PENDIENTE', 'PAGADA', 'VENCIDA', 'ANULADA');--> statement-breakpoint
CREATE TYPE "public"."metodo_pago" AS ENUM('TRANSFERENCIA', 'EFECTIVO');--> statement-breakpoint
CREATE TABLE "cobros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"solicitud_id" uuid NOT NULL,
	"reserva_id" uuid,
	"concepto" "concepto_cobro" NOT NULL,
	"importe" integer NOT NULL,
	"metodo" "metodo_pago" NOT NULL,
	"fecha" date NOT NULL,
	"recibo_numero" text NOT NULL,
	"registrado_por_id" uuid NOT NULL,
	"observaciones" text,
	"anulado_en" timestamp with time zone,
	"anulado_por_id" uuid,
	"motivo_anulacion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cobros_recibo_numero_unique" UNIQUE("recibo_numero"),
	CONSTRAINT "cobros_importe_chk" CHECK ("cobros"."importe" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"solicitud_id" uuid NOT NULL,
	"importe" integer NOT NULL,
	"fecha_limite" date NOT NULL,
	"estado" "estado_reserva" DEFAULT 'PENDIENTE' NOT NULL,
	"creada_por_id" uuid,
	"pagada_en" timestamp with time zone,
	"vencida_en" timestamp with time zone,
	"anulada_en" timestamp with time zone,
	"motivo_anulacion" text,
	"recordatorio_enviado_en" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservas_importe_chk" CHECK ("reservas"."importe" >= 0)
);
--> statement-breakpoint
ALTER TABLE "solicitudes" ADD COLUMN "en_espera_desde" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cobros" ADD CONSTRAINT "cobros_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobros" ADD CONSTRAINT "cobros_reserva_id_reservas_id_fk" FOREIGN KEY ("reserva_id") REFERENCES "public"."reservas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobros" ADD CONSTRAINT "cobros_registrado_por_id_usuarios_id_fk" FOREIGN KEY ("registrado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobros" ADD CONSTRAINT "cobros_anulado_por_id_usuarios_id_fk" FOREIGN KEY ("anulado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservas" ADD CONSTRAINT "reservas_solicitud_id_solicitudes_id_fk" FOREIGN KEY ("solicitud_id") REFERENCES "public"."solicitudes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservas" ADD CONSTRAINT "reservas_creada_por_id_usuarios_id_fk" FOREIGN KEY ("creada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cobros_solicitud_idx" ON "cobros" USING btree ("solicitud_id");--> statement-breakpoint
CREATE INDEX "cobros_reserva_idx" ON "cobros" USING btree ("reserva_id");--> statement-breakpoint
CREATE INDEX "cobros_fecha_idx" ON "cobros" USING btree ("fecha");--> statement-breakpoint
CREATE UNIQUE INDEX "reservas_vigente_uq" ON "reservas" USING btree ("solicitud_id") WHERE "reservas"."estado" <> 'ANULADA';--> statement-breakpoint
CREATE INDEX "reservas_estado_idx" ON "reservas" USING btree ("estado","fecha_limite");