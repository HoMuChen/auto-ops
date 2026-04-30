import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tenantCredentials } from '../../db/schema/index.js';
import { ExternalServiceError, NotFoundError } from '../../lib/errors.js';

export interface ShopifyCredentials {
  storeUrl: string;
  accessToken: string;
}

/**
 * Resolve Shopify credentials for a tenant from the credential vault.
 *
 * MVP: secrets are stored as opaque strings in the DB. Production should encrypt
 * `secret` at the application layer (libsodium / KMS) before persisting.
 */
export async function getShopifyCredentials(tenantId: string): Promise<ShopifyCredentials> {
  const [row] = await db
    .select()
    .from(tenantCredentials)
    .where(and(eq(tenantCredentials.tenantId, tenantId), eq(tenantCredentials.provider, 'shopify')))
    .limit(1);

  if (!row) throw new NotFoundError(`Shopify credentials for tenant ${tenantId}`);

  const meta = row.metadata as { storeUrl?: string };
  if (!meta.storeUrl) {
    throw new ExternalServiceError('shopify', 'Shopify credential is missing storeUrl in metadata');
  }
  return { storeUrl: meta.storeUrl, accessToken: row.secret };
}

export class ShopifyAdminClient {
  constructor(private readonly creds: ShopifyCredentials) {}

  static async forTenant(tenantId: string): Promise<ShopifyAdminClient> {
    const creds = await getShopifyCredentials(tenantId);
    return new ShopifyAdminClient(creds);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, `https://${this.creds.storeUrl}/admin/api/2024-10/`);
    const res = await fetch(url, {
      ...init,
      headers: {
        'X-Shopify-Access-Token': this.creds.accessToken,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ExternalServiceError('shopify', `Shopify API ${res.status}: ${body.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  createProduct(input: {
    title: string;
    body_html?: string;
    vendor?: string;
    tags?: string[];
    product_type?: string;
  }): Promise<{ product: { id: number; handle: string } }> {
    return this.request('products.json', {
      method: 'POST',
      body: JSON.stringify({ product: input }),
    });
  }

  updateProduct(
    productId: number,
    patch: Record<string, unknown>,
  ): Promise<{ product: { id: number; handle: string } }> {
    return this.request(`products/${productId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ product: patch }),
    });
  }
}
