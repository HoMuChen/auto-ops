import { productStrategistAgent } from './builtin/product-strategist/index.js';
import { shopifyBlogWriterAgent } from './builtin/shopify-blog-writer/index.js';
import { shopifyPublisherAgent } from './builtin/shopify-publisher/index.js';
import { seoStrategistAgent } from './builtin/seo-strategist/index.js';
import { agentRegistry } from './registry.js';

export * from './types.js';
export { agentRegistry } from './registry.js';

let bootstrapped = false;

export function bootstrapAgents(): void {
  if (bootstrapped) return;
  agentRegistry.register(seoStrategistAgent);
  agentRegistry.register(shopifyBlogWriterAgent);
  agentRegistry.register(productStrategistAgent);
  agentRegistry.register(shopifyPublisherAgent);
  bootstrapped = true;
}
