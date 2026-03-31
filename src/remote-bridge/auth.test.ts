import { describe, expect, it } from 'vitest';
import { extractBearerToken, isAuthorizedToken } from './auth.js';

describe('remote-bridge auth', () => {
  it('extracts bearer token', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('Basic xxx')).toBeUndefined();
  });

  it('compares token safely', () => {
    expect(isAuthorizedToken('abc', 'abc')).toBe(true);
    expect(isAuthorizedToken('abc', 'abcd')).toBe(false);
    expect(isAuthorizedToken(undefined, 'abc')).toBe(false);
  });
});
