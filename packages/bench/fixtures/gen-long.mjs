// Deterministic generator for a long, noisy, realistic agent transcript (OpenAI chat format).
// Story: fix a flaky integration test; the session detours into an unrelated lint upgrade, repeats the
// same failing run three times, and chats. The evidence the final answer needs is stated ONLY early:
//   - the user's constraints (ticket ids OPS-2291 / API-1187, the migration freeze)
//   - the original failure output ("duplicate idempotency key")
// Regenerate with: node fixtures/gen-long.mjs > fixtures/long-noisy-openai.json
// `--scale <n>` repeats act 2 (the noise) n times with deterministic per-round variation, so the
// same story reaches the size a real compaction API needs (Anthropic's trigger floor is 50k
// input tokens): node fixtures/gen-long.mjs --scale 7 > fixtures/long-noisy-openai-55k.json
// With --scale 1 (the default) the output is byte-identical to long-noisy-openai.json.
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { scale: { type: 'string', default: '1' } } });
const scale = Math.max(1, Number.parseInt(values.scale, 10) || 1);
let seed = 20260918;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const id = () => `call_${hex(24)}`;

const msgs = [];
const sys = (c) => msgs.push({ role: 'system', content: c });
const user = (c) => msgs.push({ role: 'user', content: c });
const assistant = (c) => msgs.push({ role: 'assistant', content: c });
const tool = (name, args, output, text = '') => {
  const cid = id();
  msgs.push({ role: 'assistant', content: text, tool_calls: [{ id: cid, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  msgs.push({ role: 'tool', tool_call_id: cid, content: output });
};

const FAIL = `> orders-service@2.14.0 test
> vitest run test/orders.test.ts

 RUN  v3.1.4 /workspace/orders-service

 ❯ test/orders.test.ts (6 tests | 1 failed) 1432ms
   ✓ POST /orders > creates an order 88ms
   ✓ POST /orders > rejects an empty cart 12ms
   × POST /orders > is idempotent across gateway retries 1204ms
     → Expected status 201 but received 409 (Conflict): duplicate idempotency key "ord-7f3a9c" — first attempt was rolled back after a simulated timeout, second attempt must succeed
     ❯ test/orders.test.ts:71:5
     ❯ handler src/api/orders.ts:41:9
   ✓ GET /orders/:id > returns 404 for unknown ids 9ms
   ✓ GET /orders/:id > returns the order 15ms
   ✓ DELETE /orders/:id > soft-deletes 21ms

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
   Start at  09:41:07
   Duration  2.19s`;

const ORDERS_TS = `import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { db } from '../db/client';
import { idempotency } from './idempotency';
import { validateCart } from './validate';

export async function createOrder(req: Request, res: Response) {
  const key = req.header('idempotency-key') ?? randomUUID();
  const cart = validateCart(req.body);
  if (!cart.ok) return res.status(400).json({ error: cart.error });

  if (await idempotency.seen(key)) {
    return res.status(409).json({ error: \`duplicate idempotency key "\${key}"\` });
  }
  await idempotency.remember(key, { ttlSeconds: 86_400 });

  const order = await db.transaction(async (tx) => {
    const [row] = await tx.insert('orders', { id: randomUUID(), items: cart.items, total: cart.total, status: 'pending' });
    await tx.insert('order_events', { orderId: row.id, type: 'created' });
    return row;
  });

  return res.status(201).json(order);
}
`;

const lsOut = () => ['total 184', 'drwxr-xr-x  14 app app  448 Sep 18 09:12 .', 'drwxr-xr-x   6 app app  192 Sep 18 09:12 ..', '-rw-r--r--   1 app app  412 Sep 18 09:12 .env.example', '-rw-r--r--   1 app app  228 Sep 18 09:12 .eslintrc.cjs', 'drwxr-xr-x  12 app app  384 Sep 18 09:12 .git', '-rw-r--r--   1 app app   88 Sep 18 09:12 .gitignore', '-rw-r--r--   1 app app 1024 Sep 18 09:12 Dockerfile', '-rw-r--r--   1 app app 2211 Sep 18 09:12 README.md', 'drwxr-xr-x   4 app app  128 Sep 18 09:12 migrations', 'drwxr-xr-x 412 app app 13184 Sep 18 09:12 node_modules', '-rw-r--r--   1 app app 1893 Sep 18 09:12 package.json', '-rw-r--r--   1 app app 96212 Sep 18 09:12 package-lock.json', 'drwxr-xr-x   8 app app  256 Sep 18 09:12 src', 'drwxr-xr-x   5 app app  160 Sep 18 09:12 test', '-rw-r--r--   1 app app  502 Sep 18 09:12 tsconfig.json', '-rw-r--r--   1 app app  311 Sep 18 09:12 vitest.config.ts'].join('\n');
const gitStatus = () => `On branch fix/orders-idempotency\nYour branch is up to date with 'origin/fix/orders-idempotency'.\n\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n\tmodified:   package-lock.json\n\tmodified:   package.json\n\nno changes added to commit (use "git add" and/or "git commit -a")`;
const npmInstall = () => {
  const lines = ['npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it.', 'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported', 'npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported'];
  for (let i = 0; i < 70; i++) lines.push(`npm http fetch GET 200 https://registry.npmjs.org/${pick(['@eslint/js', 'espree', 'acorn', 'globals', 'ajv', 'chalk', 'debug', 'minimatch', 'levn', 'optionator', 'eslint-scope', 'eslint-visitor-keys', '@humanwhocodes/module-importer', 'ignore', 'imurmurhash', 'is-glob', 'json-stable-stringify-without-jsonify', 'lodash.merge', 'natural-compare'])}/-/${hex(6)}-${Math.floor(rnd() * 9)}.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 9)}.tgz ${Math.floor(rnd() * 400) + 40}ms (cache miss)`);
  lines.push('', 'added 41 packages, removed 12 packages, changed 9 packages, and audited 612 packages in 6s', '', '118 packages are looking for funding', '  run `npm fund` for details', '', 'found 0 vulnerabilities');
  return lines.join('\n');
};
const lintOut = (n) => {
  const files = ['src/db/client.ts', 'src/api/validate.ts', 'src/api/health.ts', 'src/lib/logger.ts', 'src/lib/config.ts', 'test/helpers/db.ts', 'src/workers/reconcile.ts'];
  const rules = ['@typescript-eslint/no-unused-vars', 'no-console', 'prefer-const', '@typescript-eslint/no-explicit-any', 'eqeqeq', 'no-empty'];
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${pick(files)}\n  ${Math.floor(rnd() * 200) + 1}:${Math.floor(rnd() * 40) + 1}  error  ${pick(["'res' is defined but never used", 'Unexpected console statement', "'row' is never reassigned. Use 'const' instead", 'Unexpected any. Specify a different type', "Expected '===' and instead saw '=='", 'Empty block statement'])}  ${pick(rules)}`);
  out.push('', `✖ ${n} problems (${n} errors, 0 warnings)`, `  ${Math.floor(n / 2)} errors and 0 warnings potentially fixable with the \`--fix\` option.`);
  return out.join('\n');
};
const dockerPs = () => `CONTAINER ID   IMAGE                  COMMAND                  CREATED        STATUS        PORTS                    NAMES\n${hex(12)}   postgres:16-alpine     "docker-entrypoint.s…"   2 hours ago    Up 2 hours    0.0.0.0:5432->5432/tcp   orders-db\n${hex(12)}   redis:7-alpine         "docker-entrypoint.s…"   2 hours ago    Up 2 hours    0.0.0.0:6379->6379/tcp   orders-cache`;

// ── act 1: goal + constraints + evidence (early only) ─────────────────────────────
sys('You are a senior backend engineer working in the orders-service repository (TypeScript, Express, Postgres). Use the tools to inspect and change code. Keep answers concise. Never modify database migrations without explicit approval.');
user('Fix the flaky integration test in src/api/orders.ts — `POST /orders > is idempotent across gateway retries` fails with a 409 on the retry. Constraints: do not touch the database schema, the migration freeze is on until Friday (ticket OPS-2291). The retry behaviour itself is correct and owned by the gateway team (ticket API-1187), so fix it on our side.');
tool('bash', { command: 'npm test -- test/orders.test.ts' }, FAIL, 'Reproducing the failure first.');
tool('bash', { command: 'cat src/api/orders.ts' }, ORDERS_TS, 'Reading the handler the stack trace points at.');
assistant('The handler records the idempotency key before the transaction commits. When the first attempt is rolled back after the gateway timeout, the key is already remembered, so the retry is rejected with 409. I will look at the idempotency module next.');
tool('bash', { command: 'cat src/api/idempotency.ts' }, `import { cache } from '../lib/cache';\n\nexport const idempotency = {\n  async seen(key: string) {\n    return (await cache.get(\`idem:\${key}\`)) !== null;\n  },\n  async remember(key: string, opts: { ttlSeconds: number }) {\n    await cache.set(\`idem:\${key}\`, '1', opts.ttlSeconds);\n  },\n  async forget(key: string) {\n    await cache.del(\`idem:\${key}\`);\n  },\n};\n`);

// ── act 2: noise — repo browsing, an unrelated lint detour, chit-chat, repeated runs ──
const DETOURS = [
  ['prettier', 3, 'format'], ['vitest', 3, 'test'], ['typescript', 5, 'typecheck'], ['tsx', 4, 'build'],
  ['supertest', 7, 'e2e'], ['pino', 9, 'logging'], ['zod', 4, 'validate'], ['pg', 8, 'db'],
];
const GRIPES = [
  'my coffee machine died', 'my train was forty minutes late', 'the office AC gave up',
  'the dog ate my headphones', 'my bike got a flat', 'the fire alarm went off twice',
  'my laptop charger finally died', 'the neighbours started drilling at 7',
];
const act2 = (round) => {
  const [pkg, major, job] = DETOURS[(round - 1) % DETOURS.length] ?? DETOURS[0];
  const gripe = GRIPES[(round - 1) % GRIPES.length] ?? GRIPES[0];
  tool('bash', { command: 'ls -la' }, lsOut(), 'Checking the repo layout.');
  tool('bash', { command: 'git status' }, gitStatus());
  tool('bash', { command: 'docker ps' }, dockerPs(), 'Confirming the test database is up.');
  user(round === 0 ? 'oh also, while you are in there, can you bump eslint to the latest 9.x? the lint job has been red for a week' : `oh also, while you are in there, can you bump ${pkg} to the latest ${major}.x? the ${job} job has been red for a week`);
  tool('bash', { command: round === 0 ? 'npm install eslint@latest @eslint/js@latest --save-dev' : `npm install ${pkg}@latest --save-dev` }, npmInstall(), round === 0 ? 'Bumping eslint first, then I will come back to the 409.' : `Bumping ${pkg} first, then I will come back to the 409.`);
  tool('bash', { command: 'npx eslint . --ext .ts' }, lintOut(23));
  assistant('23 lint errors, all in files unrelated to the orders handler. Most are unused variables and console statements. I will fix them file by file.');
  for (const f of ['src/db/client.ts', 'src/api/validate.ts', 'src/lib/logger.ts', 'test/helpers/db.ts']) {
    tool('apply_patch', { patch: `*** Begin Patch\n*** Update File: ${f}\n@@\n-  const res = await pool.query(text, params);\n-  console.log('query', text);\n+  const result = await pool.query(text, params);\n@@\n-  return res.rows;\n+  return result.rows;\n*** End Patch` }, `Done: applied patch to ${f} (2 hunks)`, `Fixing ${f}.`);
  }
  tool('bash', { command: 'npx eslint . --ext .ts' }, lintOut(11));
  for (const f of ['src/api/health.ts', 'src/lib/config.ts', 'src/workers/reconcile.ts']) {
    tool('apply_patch', { patch: `*** Begin Patch\n*** Update File: ${f}\n@@\n-  let interval = 5000;\n+  const interval = 5000;\n@@\n-  if (status == 'ok') {\n+  if (status === 'ok') {\n*** End Patch` }, `Done: applied patch to ${f} (2 hunks)`, `Fixing ${f}.`);
  }
  tool('bash', { command: 'npx eslint . --ext .ts' }, '\n✔ No problems found\n');
  assistant('Lint is clean on eslint 9. Back to the idempotency failure.');
  user(round === 0 ? 'haha nice. unrelated, but my coffee machine died this morning so if I seem grumpy that is why' : `haha nice. unrelated, but ${gripe} this morning so if I seem grumpy that is why`);
  assistant('Sorry to hear that — I will keep this quick so you can go find a replacement. Re-running the failing test to make sure the lint changes did not touch it.');
  tool('bash', { command: 'npm test -- test/orders.test.ts' }, FAIL);
  tool('bash', { command: 'curl -s localhost:3000/health' }, '{"status":"ok","db":"up","cache":"up","uptimeSeconds":7412}', 'Sanity-checking the service is healthy before I change the handler.');
  tool('bash', { command: 'npm test -- test/orders.test.ts' }, FAIL, 'One more run to rule out flakiness in the test itself.');
  tool('bash', { command: 'grep -rn "idempotency" src test | head -40' }, ['src/api/orders.ts:4:import { idempotency } from \'./idempotency\';', 'src/api/orders.ts:12:  if (await idempotency.seen(key)) {', 'src/api/orders.ts:15:  await idempotency.remember(key, { ttlSeconds: 86_400 });', 'src/api/idempotency.ts:3:export const idempotency = {', 'test/orders.test.ts:58:  it(\'is idempotent across gateway retries\', async () => {', 'test/orders.test.ts:63:      headers: { \'idempotency-key\': key },', 'test/helpers/gateway.ts:14:  // simulates the gateway timing out and retrying once with the same idempotency key'].join('\n'));
  tool('bash', { command: 'sed -n 50,80p test/orders.test.ts' }, `  it('is idempotent across gateway retries', async () => {\n    const key = 'ord-7f3a9c';\n    const first = gateway.postWithTimeout('/orders', cart, { headers: { 'idempotency-key': key }, timeoutMs: 50 });\n    await expect(first).rejects.toThrow(/timeout/);\n    const second = await request(app).post('/orders').set('idempotency-key', key).send(cart);\n    expect(second.status).toBe(201);\n    expect(second.body.status).toBe('pending');\n  });`);
  tool('bash', { command: 'npm test -- test/orders.test.ts' }, FAIL, 'Confirming once more with the test body in front of me.');
};
for (let round = 0; round < scale; round++) act2(round);

// ── act 3: the fix, verification, wrap-up (does not restate the early evidence) ──
assistant('Root cause confirmed: the key is remembered before the insert commits, so a rolled-back first attempt poisons the retry. Fix: remember the key inside the transaction after the insert succeeds, and forget it if the transaction throws. No schema change is needed.');
tool('apply_patch', { patch: `*** Begin Patch\n*** Update File: src/api/orders.ts\n@@\n-  await idempotency.remember(key, { ttlSeconds: 86_400 });\n-\n   const order = await db.transaction(async (tx) => {\n     const [row] = await tx.insert('orders', { id: randomUUID(), items: cart.items, total: cart.total, status: 'pending' });\n     await tx.insert('order_events', { orderId: row.id, type: 'created' });\n+    await idempotency.remember(key, { ttlSeconds: 86_400 });\n     return row;\n   });\n*** End Patch` }, 'Done: applied patch to src/api/orders.ts (1 hunk)', 'Moving the remember() call to after the insert, inside the transaction.');
tool('bash', { command: 'npm test -- test/orders.test.ts' }, `> orders-service@2.14.0 test\n> vitest run test/orders.test.ts\n\n RUN  v3.1.4 /workspace/orders-service\n\n ✓ test/orders.test.ts (6 tests) 1211ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n   Start at  09:58:41\n   Duration  1.94s`);
tool('bash', { command: 'npm test' }, `> orders-service@2.14.0 test\n> vitest run\n\n RUN  v3.1.4 /workspace/orders-service\n\n ✓ test/orders.test.ts (6 tests) 1198ms\n ✓ test/health.test.ts (2 tests) 41ms\n ✓ test/validate.test.ts (9 tests) 33ms\n ✓ test/reconcile.test.ts (4 tests) 302ms\n\n Test Files  4 passed (4)\n      Tests  21 passed (21)\n   Start at  09:59:02\n   Duration  2.41s`, 'Running the whole suite.');
tool('bash', { command: 'git diff --stat' }, ' package-lock.json     | 212 ++++++++++++-------\n package.json          |   4 +-\n src/api/health.ts     |   4 +-\n src/api/orders.ts     |   3 +-\n src/api/validate.ts   |   6 +-\n src/db/client.ts      |   5 +-\n src/lib/config.ts     |   4 +-\n src/lib/logger.ts     |   3 +-\n src/workers/reconcile.ts |  4 +-\n test/helpers/db.ts    |   3 +-\n 10 files changed, 152 insertions(+), 96 deletions(-)');
user('great — before you write the summary for the PR, remind me what the two tickets were and whether the schema is untouched');

process.stdout.write(JSON.stringify(msgs, null, 2));
process.stderr.write(`${msgs.length} messages, ${JSON.stringify(msgs).length} chars, ~${Math.ceil(JSON.stringify(msgs).length / 2.5)} tokens at 2.5 chars/token, scale ${scale}\n`);
