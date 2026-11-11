import { timingSafeEqual } from 'node:crypto';

/** Compares a presented secret with the real one in constant time, so the comparison leaks nothing about it. */
export function sameSecret(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
