import { describe, expect, it, vi } from 'vitest';
import { isAgentGateError, trustTier } from '@agentgate/shared';
import type { ServiceRecord } from '@agentgate/shared';
import { AnthropicLlm } from '@agentgate/buyer-agent';
import type { CatalogEntry } from '@agentgate/buyer-agent';

function catalog(): CatalogEntry[] {
  const service: ServiceRecord = {
    id: 7,
    name: 'Gold Spot Feed',
    description: 'XAU/USD spot',
    endpointUrl: 'http://gateway/svc/7',
    priceMotes: '500000000',
    paymentTarget: `account-hash-${'a'.repeat(64)}`,
    owner: '01aa',
    attestor: '01bb',
    active: true,
    createdAt: 0,
  };
  const score = { totalCalls: 10, successCalls: 10 };
  return [{ service, score, tier: trustTier(score) }];
}

function anthropicReply(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function queuedFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error('queuedFetch: out of responses');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('AnthropicLlm (raw /v1/messages via injected fetch)', () => {
  it('sends the documented request shape and parses a clean JSON choice', async () => {
    const { impl, calls } = queuedFetch([
      anthropicReply('{"serviceId": 7, "reason": "matches the task and is cheap"}'),
    ]);
    const llm = new AnthropicLlm({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', fetchImpl: impl });

    const choice = await llm.chooseService('gold price', catalog());
    expect(choice).toEqual({ serviceId: 7, reason: 'matches the task and is cheap' });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('x-api-key')).toBe('sk-test');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(call?.init?.body)) as {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages[0]?.role).toBe('user');
    expect(body.messages[0]?.content).toContain('Gold Spot Feed');
  });

  it('extracts JSON wrapped in prose/fences', async () => {
    const { impl } = queuedFetch([
      anthropicReply('Sure! Here is my pick:\n```json\n{"serviceId": 7, "reason": "best fit"}\n```'),
    ]);
    const llm = new AnthropicLlm({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', fetchImpl: impl });
    const choice = await llm.chooseService('gold', catalog());
    expect(choice.serviceId).toBe(7);
  });

  it('retries once on malformed output, then succeeds', async () => {
    const { impl, calls } = queuedFetch([
      anthropicReply('I would pick the gold feed because it is great.'),
      anthropicReply('{"serviceId": 7, "reason": "second try"}'),
    ]);
    const llm = new AnthropicLlm({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', fetchImpl: impl });
    const choice = await llm.chooseService('gold', catalog());
    expect(choice).toEqual({ serviceId: 7, reason: 'second try' });
    expect(calls).toHaveLength(2);
  });

  it('fails with LLM_BAD_RESPONSE after two malformed replies', async () => {
    const { impl, calls } = queuedFetch([anthropicReply('nope'), anthropicReply('still nope')]);
    const llm = new AnthropicLlm({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', fetchImpl: impl });
    const err = await llm.chooseService('gold', catalog()).catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('LLM_BAD_RESPONSE');
    expect(calls).toHaveLength(2);
  });

  it('rejects a choice naming a serviceId outside the catalog (retry then fail)', async () => {
    const { impl } = queuedFetch([
      anthropicReply('{"serviceId": 999, "reason": "hallucinated"}'),
      anthropicReply('{"serviceId": 999, "reason": "hallucinated again"}'),
    ]);
    const llm = new AnthropicLlm({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', fetchImpl: impl });
    const err = await llm.chooseService('gold', catalog()).catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('LLM_BAD_RESPONSE');
  });

  it('surfaces HTTP errors as LLM_HTTP', async () => {
    const { impl } = queuedFetch([
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }), {
        status: 401,
      }),
    ]);
    const llm = new AnthropicLlm({ apiKey: 'sk-bad', model: 'claude-sonnet-4-6', fetchImpl: impl });
    const err = await llm.chooseService('gold', catalog()).catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('LLM_HTTP');
  });

  it('summarize returns the text reply', async () => {
    const { impl } = queuedFetch([anthropicReply('Gold trades at 3310.25 USD/oz today.')]);
    const llm = new AnthropicLlm({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', fetchImpl: impl });
    const summary = await llm.summarize('gold report', { xau_usd: 3310.25 });
    expect(summary).toBe('Gold trades at 3310.25 USD/oz today.');
  });

  it('requires apiKey and model at construction', () => {
    expect(() => new AnthropicLlm({ apiKey: '', model: 'claude-sonnet-4-6' })).toThrowError(
      /apiKey/,
    );
    expect(() => new AnthropicLlm({ apiKey: 'sk', model: '  ' })).toThrowError(/model/);
  });
});
