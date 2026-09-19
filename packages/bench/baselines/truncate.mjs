// "Vanilla" structural compaction with no model at all: keep the first message (usually the system
// prompt or task) and drop the oldest messages after it until the estimate fits under maxTokens.
// Tool results are kept with their calls only by luck of position — exactly the failure mode this
// baseline exists to show. Zero cost, ~0 ms, deterministic, and blind to relevance.
import { messagesTokens } from 'jev-compactor';

export default {
  name: 'truncate-oldest',
  async run(messages, { maxTokens }) {
    const t0 = performance.now();
    const head = messages.slice(0, 1);
    let tail = messages.slice(1);
    while (tail.length > 0 && messagesTokens([...head, ...tail]) > maxTokens) tail = tail.slice(1);
    return {
      output: [...head, ...tail],
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: performance.now() - t0,
      costUsd: 0,
    };
  },
};
