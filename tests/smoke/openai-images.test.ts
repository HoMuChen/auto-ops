/**
 * Smoke test — requires real credentials in .env.
 * Run manually: pnpm test -- tests/smoke/openai-images.test.ts
 *
 * What it checks:
 *   1. Generate a small image via OpenAI gpt-image-1
 *   2. Assert the returned Buffer is a non-empty PNG
 */
import { describe, expect, it } from 'vitest';
import { OpenAIImagesClient } from '../../src/integrations/openai-images/client.js';
import { env } from '../../src/config/env.js';

describe.skipIf(!env.OPENAI_API_KEY)('OpenAI Images smoke test', () => {
  it('generates a 1024x1024 image and returns a Buffer', async () => {
    const client = new OpenAIImagesClient({ apiKey: env.OPENAI_API_KEY! });

    const buffer = await client.generate({
      prompt: 'A plain white product photography background, studio lighting, minimal',
      size: '1024x1024',
      quality: 'medium',
    });

    console.log('Generated image size:', buffer.byteLength, 'bytes');
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.byteLength).toBeGreaterThan(1000);

    // PNG magic bytes: 89 50 4E 47
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
  }, 60_000);
});
