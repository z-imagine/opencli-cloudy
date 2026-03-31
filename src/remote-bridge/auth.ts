import crypto from 'node:crypto';

function toComparableBuffer(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

export function isAuthorizedToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = toComparableBuffer(actual);
  const b = toComparableBuffer(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
