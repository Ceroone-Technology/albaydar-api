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
      MAIL_SECRETARIA: 'secretaria@albaydar.org',
    },
  },
});
