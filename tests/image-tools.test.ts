import { describe, expect, it, vi } from 'vitest';
import { buildImageTools } from '../src/integrations/openai-images/tools.js';

describe('buildImageTools', () => {
  const fakeBuffer = Buffer.from('generated');

  it('images.generate: calls openai.generate, uploads to CF, inserts image row, returns id+url', async () => {
    const openai = { generate: vi.fn(async () => fakeBuffer) };
    const cf = { upload: vi.fn(async () => ({ cfImageId: 'cf1', url: 'https://img/cf1/public' })) };
    const insertImage = vi.fn(async (input: unknown) => ({ ...input as object, id: 'img-uuid-1', createdAt: new Date() }));

    const tools = buildImageTools('tenant1', {
      openaiClient: openai as never,
      cfClient: cf as never,
      insertImage: insertImage as never,
      taskId: 'task-1',
    });

    const genTool = tools.find((t) => t.id === 'images.generate');
    expect(genTool).toBeDefined();
    const result = await genTool!.tool.invoke({ prompt: 'product shot' });

    expect(openai.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'product shot' }));
    expect(cf.upload).toHaveBeenCalledWith(fakeBuffer, expect.objectContaining({ mimeType: 'image/png' }));
    expect(insertImage).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant1',
      cfImageId: 'cf1',
      sourceType: 'generated',
      taskId: 'task-1',
    }));
    expect(result).toMatchObject({ id: 'img-uuid-1', url: 'https://img/cf1/public' });
  });

  it('images.edit: downloads source image, edits, uploads, inserts with sourceImageId', async () => {
    const sourceBuffer = Buffer.from('source');
    const openai = { edit: vi.fn(async () => fakeBuffer) };
    const cf = {
      upload: vi.fn(async () => ({ cfImageId: 'cf2', url: 'https://img/cf2/public' })),
    };
    const fetchImage = vi.fn(async () => sourceBuffer);
    const getImageById = vi.fn(async () => ({ id: 'src-id', url: 'https://img/src/public', cfImageId: 'src' }));
    const insertImage = vi.fn(async (input: unknown) => ({ ...input as object, id: 'img-uuid-2', createdAt: new Date() }));

    const tools = buildImageTools('tenant1', {
      openaiClient: openai as never,
      cfClient: cf as never,
      insertImage: insertImage as never,
      getImageById: getImageById as never,
      fetchImageBuffer: fetchImage as never,
    });

    const editTool = tools.find((t) => t.id === 'images.edit');
    await editTool!.tool.invoke({ sourceImageId: 'src-id', prompt: 'white background' });

    expect(getImageById).toHaveBeenCalledWith('tenant1', 'src-id');
    expect(fetchImage).toHaveBeenCalledWith('https://img/src/public');
    expect(openai.edit).toHaveBeenCalledWith(expect.objectContaining({ imageBuffer: sourceBuffer }));
    expect(insertImage).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'edited',
      sourceImageId: 'src-id',
    }));
  });
});
