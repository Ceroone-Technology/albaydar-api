import express from 'express';
import type { Transporter } from 'nodemailer';
import request from 'supertest';
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encolarCorreo, procesarOutbox, setTransporter } from '../src/correo/outbox';
import { correosSalientes } from '../src/db/schema';
import { db } from '../src/lib/db';
import { CABECERA_ORIGEN, soloDesdeCloudFront } from '../src/middleware/origen';

describe('Cabecera secreta de CloudFront (despliegue en AWS, 23/11/2026)', () => {
  const SECRETO = 'Kd8Jq2LmV9pX4tR7wZ1bN6cF3hY0sG5e';
  const app = express();
  app.use(soloDesdeCloudFront(SECRETO));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/algo', (_req, res) => res.json({ ok: true }));

  it('solo pasa lo que trae el secreto; /health, siempre', async () => {
    expect((await request(app).get('/api/algo')).status).toBe(403);
    const mal = await request(app).get('/api/algo').set(CABECERA_ORIGEN, 'otro-valor');
    expect(mal.status).toBe(403);
    expect(mal.body.error.code).toBe('ORIGEN_NO_PERMITIDO');
    expect((await request(app).get('/api/algo').set(CABECERA_ORIGEN, SECRETO)).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
  });
});

describe('Ritmo de la cola de correo (SES, 23/11/2026)', () => {
  const enviados: { para: string; en: number }[] = [];
  const PARA = (n: string) => `${n}@ritmo.example.com`;
  const correo = (asunto: string) => ({ asunto, html: `<p>${asunto}</p>`, texto: asunto });
  const encolar = (para: string, plantilla = 'PRUEBA') => db.transaction((tx) => encolarCorreo(tx, { plantilla, para, correo: correo(para) }));
  const enviados24h = async () =>
    (await db.select({ n: count() }).from(correosSalientes).where(gte(correosSalientes.enviadoEn, new Date(Date.now() - 86_400_000))))[0]!.n;
  const pendientes = async () =>
    (await db.select({ para: correosSalientes.para }).from(correosSalientes).where(eq(correosSalientes.estado, 'PENDIENTE'))).map((c) => c.para).sort();

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: './drizzle' });
    setTransporter({
      sendMail: async (m: Record<string, unknown>) => {
        enviados.push({ para: String(m.to), en: Date.now() });
        return { messageId: String(enviados.length) };
      },
      verify: async () => true,
    } as unknown as Transporter);
  });

  // Cada prueba empieza con la cola vacía (lo que dejaron otros tests no cuenta).
  beforeEach(async () => {
    enviados.length = 0;
    await db.update(correosSalientes).set({ estado: 'ERROR' }).where(inArray(correosSalientes.estado, ['PENDIENTE', 'ENVIANDO']));
  });

  afterAll(() => setTransporter(null));

  it('con límite por segundo deja el intervalo entre envíos', async () => {
    for (const n of ['a1', 'a2', 'a3']) await encolar(PARA(n));
    const r = await procesarOutbox(20, { porSegundo: 5, porDia: 0 });
    expect(r).toEqual({ enviados: 3, fallidos: 0 });
    // 5 por segundo → al menos ~200 ms entre envíos.
    expect(enviados[1]!.en - enviados[0]!.en).toBeGreaterThanOrEqual(190);
    expect(enviados[2]!.en - enviados[1]!.en).toBeGreaterThanOrEqual(190);
  });

  it('no pasa del cupo de 24 h: el resto espera en la cola', async () => {
    for (const n of ['b1', 'b2', 'b3', 'b4']) await encolar(PARA(n));
    const base = await enviados24h();
    expect(await procesarOutbox(20, { porSegundo: 0, porDia: base + 2 })).toEqual({ enviados: 2, fallidos: 0 });
    expect(await procesarOutbox(20, { porSegundo: 0, porDia: base + 2 })).toEqual({ enviados: 0, fallidos: 0 });
    expect(await pendientes()).toHaveLength(2);
    // Sin límite (local) salen los que quedaban.
    expect(await procesarOutbox(20, { porSegundo: 0, porDia: 0 })).toEqual({ enviados: 2, fallidos: 0 });
  });

  it('los correos del flujo salen antes que las notificaciones, que no gastan el último 20 % del cupo', async () => {
    // La notificación entra primero, pero sale después.
    await encolar(PARA('noti1'), 'NOTIFICACION');
    await encolar(PARA('flujo1'), 'CITACION');
    await procesarOutbox(1, { porSegundo: 0, porDia: 0 });
    expect(enviados.map((e) => e.para)).toEqual([PARA('flujo1')]);
    await procesarOutbox(20, { porSegundo: 0, porDia: 0 });
    expect(enviados.map((e) => e.para)).toEqual([PARA('flujo1'), PARA('noti1')]);

    // Con el cupo casi gastado (queda 1, por encima del 80 %), solo sale el del flujo.
    enviados.length = 0;
    await encolar(PARA('noti2'), 'NOTIFICACION');
    await encolar(PARA('flujo2'), 'CITACION');
    const base = await enviados24h();
    expect(await procesarOutbox(20, { porSegundo: 0, porDia: base + 1 })).toEqual({ enviados: 1, fallidos: 0 });
    expect(enviados.map((e) => e.para)).toEqual([PARA('flujo2')]);
    expect(await pendientes()).toEqual([PARA('noti2')]);
    const [noti] = await db.select().from(correosSalientes).where(and(eq(correosSalientes.para, PARA('noti2')), eq(correosSalientes.estado, 'PENDIENTE')));
    expect(noti!.plantilla).toBe('NOTIFICACION');
  });
});
