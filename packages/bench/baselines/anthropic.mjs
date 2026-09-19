// "Vanilla" LLM compaction: one Claude call that writes a continuation summary of the transcript —
// what most agent frameworks do when the context fills up.
// Needs ANTHROPIC_API_KEY (honors ANTHROPIC_BASE_URL). Prices are USD per million tokens; edit if they change.
const MODEL = process.env.BENCH_BASELINE_MODEL ?? 'claude-sonnet-5';
const PRICE = { input: 2, output: 10 };

export default {
  name: `summarize:${MODEL}`,
  async run(_messages, { goal, text }) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set (baseline needs it)');
    const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const t0 = performance.now();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system:
          "You compact an AI coding agent's conversation so the agent can continue. Write a dense summary of what was asked, what was learned, what was tried, and what remains. Preserve exact file paths, commands, and error messages.",
        messages: [
          { role: 'user', content: `Goal: ${goal}\n\nTranscript:\n${text.slice(0, 400_000)}` },
        ],
      }),
    });
    const latencyMs = performance.now() - t0;
    if (!res.ok) throw new Error(`baseline HTTP ${res.status}`);
    const body = await res.json();
    const summary = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    return {
      output: summary,
      inputTokens,
      outputTokens,
      latencyMs,
      costUsd: (inputTokens * PRICE.input + outputTokens * PRICE.output) / 1e6,
    };
  },
};
