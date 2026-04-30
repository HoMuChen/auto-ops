/**
 * Identity primitives. Kept provider-agnostic so the rest of the app never
 * imports from @supabase/* directly.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  /** Provider-issued claims if the caller needs them. */
  claims?: Record<string, unknown>;
}

export interface AuthService {
  /** Verify a bearer token and return the user, or throw UnauthorizedError. */
  verifyToken(token: string): Promise<AuthenticatedUser>;
}
