import type { AuthService } from './auth.types.js';
import { SupabaseAuthService } from './supabase-auth.js';

export * from './auth.types.js';
export { SupabaseAuthService };

let instance: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!instance) instance = new SupabaseAuthService();
  return instance;
}

export function setAuthService(service: AuthService): void {
  instance = service;
}
