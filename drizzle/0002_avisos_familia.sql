CREATE TABLE "eventos_vistos" (
	"usuario_id" uuid NOT NULL,
	"evento_id" uuid NOT NULL,
	"visto_en" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eventos_vistos_usuario_id_evento_id_pk" PRIMARY KEY("usuario_id","evento_id")
);
--> statement-breakpoint
ALTER TABLE "eventos_vistos" ADD CONSTRAINT "eventos_vistos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos_vistos" ADD CONSTRAINT "eventos_vistos_evento_id_solicitud_eventos_id_fk" FOREIGN KEY ("evento_id") REFERENCES "public"."solicitud_eventos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "solicitud_eventos_tipo_idx" ON "solicitud_eventos" USING btree ("tipo","created_at");