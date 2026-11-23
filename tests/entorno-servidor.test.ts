import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { contrasenaSemilla } from '../src/db/semilla-contrasenas';

/** Carga src/config/env.ts en un proceso aparte con estas variables (sale con 1 si no valen). */
function arrancar(vars: Record<string, string>) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/config/env')"], {
    cwd: process.cwd(),
    // Solo estas variables: que no se cuele el .env local (dotenv no pisa las ya definidas).
    env: { PATH: process.env.PATH ?? '', DOTENV_CONFIG_PATH: '/nonexistent', ...vars },
    encoding: 'utf8',
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
}

const SERVIDOR_OK = {
  ENTORNO: 'beta',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://albaydar:Qx8vN2kL5pR9tW3zY7mB@db:5432/albaydar',
  JWT_ACCESS_SECRET: 'b3K9xQ2mV7nR4tY8wZ1cF6hJ0lP5sD3gA9eU2iO7',
  COOKIE_SECURE: 'true',
  TRUST_PROXY: 'true',
  SMTP_HOST: 'email-smtp.eu-west-1.amazonaws.com',
  MAIL_DESVIO: 'pruebas@example.com',
  STORAGE: 's3',
  S3_BUCKET: 'albaydar-beta-uploads',
  PUBLIC_APP_URL: 'https://dxxxx.cloudfront.net',
};

describe('Arranque en un servidor (ENTORNO=beta|produccion, 22/11/2026)', () => {
  it('con todo bien configurado arranca', () => {
    expect(arrancar(SERVIDOR_OK)).toMatchObject({ codigo: 0 });
  });

  it('no arranca con secretos de ejemplo, cookies sin Secure, Mailpit, disco, http ni sin desvío en beta', () => {
    const r = arrancar({
      ...SERVIDOR_OK,
      JWT_ACCESS_SECRET: 'solo-para-desarrollo-local-cambiar-en-servidor-0123456789',
      DATABASE_URL: 'postgresql://albaydar:albaydar@db:5432/albaydar',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
      SMTP_HOST: 'mailpit',
      MAIL_DESVIO: '',
      STORAGE: 'disco',
      PUBLIC_APP_URL: 'http://dxxxx.cloudfront.net',
    });
    expect(r.codigo).toBe(1);
    for (const campo of ['JWT_ACCESS_SECRET', 'DATABASE_URL', 'COOKIE_SECURE', 'TRUST_PROXY', 'SMTP_HOST', 'MAIL_DESVIO', 'STORAGE', 'PUBLIC_APP_URL']) {
      expect(r.salida).toContain(campo);
    }
  });

  it('en producción no exige desvío; en local no comprueba nada de esto', () => {
    expect(arrancar({ ...SERVIDOR_OK, ENTORNO: 'produccion', MAIL_DESVIO: '' }).codigo).toBe(0);
    expect(
      arrancar({ DATABASE_URL: 'postgresql://albaydar:albaydar@localhost:5432/albaydar', JWT_ACCESS_SECRET: 'solo-para-desarrollo-local-cambiar-en-servidor-0123456789', SMTP_HOST: 'mailpit' }).codigo,
    ).toBe(0);
  });

  it('la semilla no usa contraseñas conocidas en un servidor', () => {
    expect(contrasenaSemilla('SEED_ADMIN_PASSWORD', undefined, 'CambiaEsto-2026!', 'local')).toBe('CambiaEsto-2026!');
    expect(() => contrasenaSemilla('SEED_ADMIN_PASSWORD', undefined, 'CambiaEsto-2026!', 'beta')).toThrow('obligatoria');
    expect(() => contrasenaSemilla('SEED_DEMO_PASSWORD', 'Albaydar-2026', 'Albaydar-2026', 'beta')).toThrow('12 caracteres');
    expect(() => contrasenaSemilla('SEED_ADMIN_PASSWORD', 'corta', 'x', 'produccion')).toThrow('12 caracteres');
    expect(contrasenaSemilla('SEED_ADMIN_PASSWORD', 'Una-Contraseña-Larga-9', 'x', 'produccion')).toBe('Una-Contraseña-Larga-9');
  });
});
