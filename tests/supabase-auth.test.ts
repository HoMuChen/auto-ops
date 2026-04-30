import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { SupabaseAuthService } from '../src/auth/supabase-auth.js';
import { UnauthorizedError } from '../src/lib/errors.js';

const SECRET = 'unit-test-secret-must-be-long-enough-for-hs256-aaaaaaaa';
const key = new TextEncoder().encode(SECRET);

async function signWith(
  payload: Record<string, unknown>,
  opts: { secret?: Uint8Array; expSeconds?: number } = {},
): Promise<string> {
  const sigKey = opts.secret ?? key;
  const exp = opts.expSeconds ?? Math.floor(Date.now() / 1000) + 3600;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(exp)
    .sign(sigKey);
}

describe('SupabaseAuthService', () => {
  const auth = new SupabaseAuthService(SECRET);

  it('verifies a valid token and returns the user', async () => {
    const token = await signWith({ sub: 'user-1', email: 'foo@bar.com' });
    const user = await auth.verifyToken(token);
    expect(user.id).toBe('user-1');
    expect(user.email).toBe('foo@bar.com');
    expect(user.claims).toBeDefined();
  });

  it('rejects a token signed with a different secret', async () => {
    const otherKey = new TextEncoder().encode(`${SECRET}-other`);
    const token = await signWith({ sub: 'user-1', email: 'foo@bar.com' }, { secret: otherKey });
    await expect(auth.verifyToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a malformed token', async () => {
    await expect(auth.verifyToken('not.a.jwt')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token missing sub', async () => {
    const token = await signWith({ email: 'foo@bar.com' });
    await expect(auth.verifyToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token missing email', async () => {
    const token = await signWith({ sub: 'user-1' });
    await expect(auth.verifyToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an expired token', async () => {
    const token = await signWith(
      { sub: 'user-1', email: 'foo@bar.com' },
      { expSeconds: Math.floor(Date.now() / 1000) - 60 },
    );
    await expect(auth.verifyToken(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
