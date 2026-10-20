import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  // Nunca registrar credenciales, tokens ni datos personales sensibles.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
    ],
    censor: '[oculto]',
  },
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
});
