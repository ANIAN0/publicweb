import { randomBytes, createHash, timingSafeEqual } from 'crypto';

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * LIB-028：用 timingSafeEqual 比较 hash，避免理论 timing 泄漏。
 * 长度不一致时直接 false（不走 equal，避免抛错）。
 */
export function verifyToken(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}