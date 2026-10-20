import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';

export interface AccessPayload {
  sub: string;
  email: string;
  nombre: string;
  roles: string[];
}

const ISSUER = 'albaydar-api';
const AUDIENCE = 'albaydar-app';

export function firmarAccess(p: AccessPayload): string {
  return jwt.sign(p, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function verificarAccess(token: string): AccessPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as AccessPayload;
}
