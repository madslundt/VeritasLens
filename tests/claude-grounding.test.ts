// Verifies the Claude provider appends extra tools (web_search_20250305) to
// the request body alongside the emit_lens_result tool when a grounded lens
// runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLens } from '../src/llm/claude';

interface ToolDef { name?: string; type?: string; max_uses?: number }

interface CapturedBody {
  tools: ToolDef[];
  tool_choice: { type: string; name: string };
}

describe('Claude callLens — extra tools plumbing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            { type: 'tool_use', name: 'emit_lens_result', input: { ok: true } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('forwards opts.tools alongside the lens output tool', async () => {
    await callLens({
      apiKey: 'test-key',
      transcript: 'hello',
      prompt: 'system',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as CapturedBody;
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]?.name).toBe('emit_lens_result');
    expect(body.tools[1]?.type).toBe('web_search_20250305');
    expect(body.tools[1]?.max_uses).toBe(3);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit_lens_result' });
  });

  it('does not append extra tools when opts.tools is omitted', async () => {
    await callLens({
      apiKey: 'test-key',
      transcript: 'hello',
      prompt: 'system',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as CapturedBody;
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]?.name).toBe('emit_lens_result');
  });
});
