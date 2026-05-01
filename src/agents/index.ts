import { seoStrategistAgent } from './builtin/seo-strategist/index.js';
import { shopifyBlogWriterAgent } from './builtin/shopify-blog-writer/index.js';
import { shopifyOpsAgent } from './builtin/shopify-ops/index.js';
import { agentRegistry } from './registry.js';

export * from './types.js';
export { agentRegistry } from './registry.js';

let bootstrapped = false;

/**
 * Register all builtin agents. Called once at process boot.
 *
 * To add a new pluggable agent:
 *   1. Implement IAgent in src/agents/builtin/<your-agent>/index.ts
 *   2. Register it here.
 *
 * Future: load external agents from a manifests directory or remote registry.
 */
export function bootstrapAgents(): void {
  if (bootstrapped) return;
  agentRegistry.register(seoStrategistAgent);
  agentRegistry.register(shopifyBlogWriterAgent);
  agentRegistry.register(shopifyOpsAgent);
  bootstrapped = true;
}
