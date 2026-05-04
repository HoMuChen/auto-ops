import { marketResearcherAgent } from './builtin/market-researcher/index.js';
import { productDesignerAgent } from './builtin/product-designer/index.js';
import { productPlannerAgent } from './builtin/product-planner/index.js';
import { seoStrategistAgent } from './builtin/seo-strategist/index.js';
import { shopifyBlogWriterAgent } from './builtin/shopify-blog-writer/index.js';
import { shopifyPublisherAgent } from './builtin/shopify-publisher/index.js';
import { agentRegistry } from './registry.js';

export * from './types.js';
export { agentRegistry } from './registry.js';

let bootstrapped = false;

export function bootstrapAgents(): void {
  if (bootstrapped) return;
  agentRegistry.register(seoStrategistAgent);
  agentRegistry.register(shopifyBlogWriterAgent);
  agentRegistry.register(productPlannerAgent);
  agentRegistry.register(productDesignerAgent);
  agentRegistry.register(shopifyPublisherAgent);
  agentRegistry.register(marketResearcherAgent);
  bootstrapped = true;
}
