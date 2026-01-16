type FetchLike = typeof fetch;

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractOutputText(raw: any): string {
  if (raw && typeof raw.output_text === 'string') return raw.output_text;

  const output = raw?.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        const text = c?.text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join('');
  }

  // Fallback: tolerate Chat Completions-like shape if it ever appears.
  const choiceText = raw?.choices?.[0]?.message?.content;
  if (typeof choiceText === 'string') return choiceText;

  throw new Error('OpenAI response missing output text');
}

export async function callOpenAIResponsesApi(opts: {
  apiKey: string;
  model: string;
  input: unknown;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}): Promise<{ outputText: string; raw: unknown }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = 'https://api.openai.com/v1/responses';

  const attemptOnce = async (): Promise<{
    ok: boolean;
    status?: number;
    raw?: unknown;
    outputText?: string;
    retryable: boolean;
    error?: string;
  }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model,
          input: opts.input,
        }),
        signal: controller.signal,
      });

      const status = res.status;
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;

      if (!res.ok) {
        const retryable = isRetryableStatus(status);
        const msg =
          (parsed as any)?.error?.message ??
          (parsed as any)?.message ??
          `OpenAI request failed (status ${status})`;
        return { ok: false, status, retryable, error: msg };
      }

      const outputText = extractOutputText(parsed);
      return { ok: true, status, raw: parsed, outputText, retryable: false };
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError';
      return {
        ok: false,
        retryable: !isAbort,
        error: isAbort ? 'OpenAI request timed out' : 'OpenAI request failed',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const first = await attemptOnce();
  if (first.ok) {
    return { outputText: first.outputText ?? '', raw: first.raw ?? null };
  }
  if (first.retryable) {
    // One small backoff, then retry once (budgeted).
    await sleep(200);
    const second = await attemptOnce();
    if (second.ok) {
      return { outputText: second.outputText ?? '', raw: second.raw ?? null };
    }
    throw new Error(second.error ?? first.error ?? 'OpenAI request failed');
  }

  throw new Error(first.error ?? 'OpenAI request failed');
}

