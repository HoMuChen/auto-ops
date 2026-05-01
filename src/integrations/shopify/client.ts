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
 * `label` selects between multiple bound stores when the tenant has more than
 * one Shopify connection. Falls back to any row when label is omitted.
 *
 * MVP: secrets are stored as opaque strings in the DB. Production should encrypt
 * `secret` at the application layer (libsodium / KMS) before persisting.
 */
export async function getShopifyCredentials(
  tenantId: string,
  label?: string,
): Promise<ShopifyCredentials> {
  const conditions = [
    eq(tenantCredentials.tenantId, tenantId),
    eq(tenantCredentials.provider, 'shopify'),
  ];
  if (label) conditions.push(eq(tenantCredentials.label, label));

  const [row] = await db
    .select()
    .from(tenantCredentials)
    .where(and(...conditions))
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

  static async forTenant(tenantId: string, label?: string): Promise<ShopifyAdminClient> {
    const creds = await getShopifyCredentials(tenantId, label);
    return new ShopifyAdminClient(creds);
  }

  /** The myshopify.com domain — useful for building admin/storefront URLs. */
  get storeDomain(): string {
    return this.creds.storeUrl;
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
    status?: 'active' | 'draft' | 'archived';
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

  /**
   * List blogs on the store. Used by the publish tool to resolve a blog by
   * handle, or to fall back to the first blog when the agent config doesn't
   * pin one.
   */
  listBlogs(): Promise<{ blogs: { id: number; handle: string; title: string }[] }> {
    return this.request('blogs.json');
  }

  /**
   * Create a new article inside a blog. Maps to Shopify Admin REST
   * `POST /blogs/:blog_id/articles.json`. Pass `published: false` to create
   * a draft article that is not visible on the storefront yet.
   */
  createArticle(
    blogId: number,
    article: {
      title: string;
      body_html: string;
      summary_html?: string;
      tags?: string[] | string;
      author?: string;
      published?: boolean;
      published_at?: string;
    },
  ): Promise<{
    article: { id: number; handle: string; blog_id: number; published_at: string | null };
  }> {
    return this.request(`blogs/${blogId}/articles.json`, {
      method: 'POST',
      body: JSON.stringify({
        article: {
          ...article,
          // Shopify accepts either an array or a comma-separated string; send
          // the canonical form so the receiving end is unambiguous.
          tags: Array.isArray(article.tags) ? article.tags.join(', ') : article.tags,
        },
      }),
    });
  }
}
