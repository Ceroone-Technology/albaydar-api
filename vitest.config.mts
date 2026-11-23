import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Los tests de integración comparten una BD: se ejecutan en serie.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://albaydar:albaydar@localhost:5432/albaydar_test',
      JWT_ACCESS_SECRET: 'secreto-de-test-con-mas-de-treinta-y-dos-caracteres',
      CORS_ORIGINS: 'http://localhost:4200',
      PUBLIC_APP_URL: 'http://localhost:4200',
      WORKERS_ENABLED: 'false',
      UPLOADS_DIR: './storage/test-uploads',
      // Disco por defecto. Para pasar la suite contra un S3 compatible (MinIO):
      // TEST_STORAGE=s3 TEST_S3_BUCKET=… TEST_S3_ENDPOINT=http://localhost:9000 (y AWS_ACCESS_KEY_ID/SECRET).
      STORAGE: process.env.TEST_STORAGE ?? 'disco',
      S3_BUCKET: process.env.TEST_S3_BUCKET ?? '',
      S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? '',
      MAIL_SECRETARIA: 'secretaria@albaydar.org',
      MAIL_ADMINISTRACION: 'administracion@albaydar.org',
      // Vacío: el Reply-To es MAIL_SECRETARIA (trampa 9: que no se cuele el .env local).
      MAIL_REPLY_TO: '',
    },
  },
});
