import { randomBytes, createHash } from 'crypto';

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyToken(token: string, hash: string): boolean {
  return hashToken(token) === hash;
}