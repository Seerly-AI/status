// Harness for the Cloudflare Worker: stubs the CF-only globals, records what the
// Worker would send upstream, and asserts the allowlist actually holds.
const calls = [];
globalThis.caches = {
  default: { match: async () => undefined, put: async () => {} },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), headers: init?.headers ?? {} });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// In-memory stand-in for the KV namespace, with the TTL recorded so we can assert keys
// are set to expire rather than accumulating forever.
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    puts: [],
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      store.set(key, value);
      this.puts.push({ key, value, opts });
    },
  };
}

const worker = (await import('../src/worker.js')).default;
const ctx = { waitUntil: () => {} };
const ORIGIN = 'https://status.seerly.app';
let kv = makeKv();
let env = { GITHUB_TOKEN: 'TESTTOKEN', STATUS_BEAT_SECRET: 'BEATSECRET', STATUS_BEATS: kv };

async function call(path, method = 'GET') {
  calls.length = 0;
  const res = await worker.fetch(
    new Request('https://status-api.seerly.app' + path, { method, headers: { Origin: ORIGIN } }),
    env,
    ctx
  );
  return { res, sent: calls[0] };
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}

console.log('--- allowed traffic ---');
{
  const { res, sent } = await call('/api/repos/Seerly-AI/status/issues?state=open');
  check('API path proxied', res.status === 200, `status=${res.status}`);
  check('forwards to api.github.com with path + query',
    sent?.url === 'https://api.github.com/repos/Seerly-AI/status/issues?state=open', sent?.url);
  check('token attached to API request', sent?.headers?.Authorization === 'Bearer TESTTOKEN');
  check('CORS allows the status page',
    res.headers.get('Access-Control-Allow-Origin') === ORIGIN);
}
{
  const { res, sent } = await call('/raw/Seerly-AI/status/master/history/summary.json');
  check('raw path proxied', res.status === 200, `status=${res.status}`);
  check('forwards to raw.githubusercontent.com',
    sent?.url === 'https://raw.githubusercontent.com/Seerly-AI/status/master/history/summary.json', sent?.url);
  check('token NOT sent to raw host', !('Authorization' in (sent?.headers ?? {})));
}

console.log('\n--- traffic that must be refused ---');
for (const [name, path] of [
  ['another repo via /api', '/api/repos/someone/private-repo/issues'],
  ['another repo via /raw', '/raw/someone/private-repo/master/x.json'],
  ['prefix-confusion repo name', '/api/repos/Seerly-AI/status-evil/issues'],
  ['user endpoint', '/api/user'],
  ['org endpoint', '/api/orgs/Seerly-AI/repos'],
  ['bare /api', '/api'],
  ['unknown prefix', '/apifoo/repos/Seerly-AI/status/issues'],
  ['root', '/'],
]) {
  const { res, sent } = await call(path);
  check(`refuses ${name}`, res.status === 403 && !sent, `status=${res.status} sent=${!!sent}`);
}

console.log('\n--- method restrictions ---');
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const { res, sent } = await call('/api/repos/Seerly-AI/status/issues', m);
  check(`refuses ${m}`, res.status === 405 && !sent, `status=${res.status}`);
}
{
  const { res } = await call('/api/repos/Seerly-AI/status/issues', 'OPTIONS');
  check('OPTIONS preflight answered', res.status === 204);
  check('preflight carries CORS', !!res.headers.get('Access-Control-Allow-Methods'));
}

console.log('\n--- preflight header negotiation (the Safari bug) ---');
{
  // Octokit sets a `user-agent` header. Chrome strips it (forbidden header name) so the
  // request stays simple; Safari sends it, forcing a preflight. A hardcoded
  // Access-Control-Allow-Headers that omitted user-agent made that preflight fail, the
  // fetch throw, and the page render "An error occurred" — in Safari only.
  const res = await worker.fetch(
    new Request('https://status-api.seerly.app/api/repos/Seerly-AI/status/issues', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Headers': 'user-agent, accept' },
    }),
    env,
    ctx
  );
  const allowed = (res.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
  check('echoes the headers the browser asked for', allowed.includes('user-agent') && allowed.includes('accept'), allowed);
  check('preflight is cacheable', res.headers.get('Access-Control-Max-Age') === '86400');
  check('varies on requested headers', (res.headers.get('Vary') || '').includes('Access-Control-Request-Headers'));
}
{
  // No Access-Control-Request-Headers → fall back to a list at least as permissive as
  // GitHub's own, so we never allow fewer headers than the origin we front.
  const { res } = await call('/api/repos/Seerly-AI/status/issues', 'OPTIONS');
  const allowed = (res.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
  for (const h of ['user-agent', 'accept', 'if-none-match', 'x-github-api-version']) {
    check(`default allow-list includes ${h}`, allowed.includes(h), allowed);
  }
}

console.log('\n--- path traversal ---');
{
  const { res, sent } = await call('/api/repos/Seerly-AI/status/../../../user');
  check('traversal cannot escape the allowlist', !sent || sent.url.startsWith('https://api.github.com/repos/Seerly-AI/status/'),
    `sent=${sent?.url} status=${res.status}`);
}

console.log('\n--- heartbeat: recording a beat ---');
async function hit(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await worker.fetch(
    new Request('https://status-api.seerly.app' + path, { method, headers, body }),
    env,
    ctx
  );
  let json = null;
  try { json = await res.clone().json(); } catch { /* not json */ }
  return { res, json };
}

{
  kv = makeKv();
  env = { ...env, STATUS_BEATS: kv };
  const { res, json } = await hit('/beat/agents', { method: 'POST', headers: { 'X-Beat-Secret': 'BEATSECRET' } });
  check('valid beat accepted', res.status === 202 && json.status === 'ok', `status=${res.status}`);
  check('beat stored under a namespaced key', kv.store.has('beat:agents'), [...kv.store.keys()].join());
  check('stored value is a timestamp', Number.isFinite(Number(kv.store.get('beat:agents'))));
  check('key is given a TTL so it self-cleans', kv.puts[0]?.opts?.expirationTtl === 86400, JSON.stringify(kv.puts[0]?.opts));
  check('beat response is never cached', res.headers.get('Cache-Control') === 'no-store');
}
{
  kv = makeKv(); env = { ...env, STATUS_BEATS: kv };
  const { res } = await hit('/beat/agents', { method: 'POST', headers: { Authorization: 'Bearer BEATSECRET' } });
  check('Bearer form of the secret also works', res.status === 202, `status=${res.status}`);
}

console.log('\n--- heartbeat: forgery and abuse ---');
for (const [name, headers] of [
  ['wrong secret', { 'X-Beat-Secret': 'WRONG' }],
  ['no secret', {}],
  ['empty secret', { 'X-Beat-Secret': '' }],
  ['secret of different length', { 'X-Beat-Secret': 'BEATSECRETLONGER' }],
]) {
  kv = makeKv(); env = { ...env, STATUS_BEATS: kv };
  const { res } = await hit('/beat/agents', { method: 'POST', headers });
  check(`rejects ${name}`, res.status === 401 && kv.store.size === 0, `status=${res.status} stored=${kv.store.size}`);
}
// Mutation-driven: a `startsWith`, `toLowerCase()` or plain-prefix comparison would let
// these through, and each is a plausible "simplification" of secretsMatch.
for (const [name, secret] of [
  ['a proper prefix of the secret', 'BEAT'],
  ['a single character', 'B'],
  ['a superstring of the secret', 'BEATSECRETX'],
  ['a case variant', 'beatsecret'],
  // NB: not testing trailing whitespace — HTTP header values are trimmed by the runtime
  // before our comparator ever sees them, so `"BEATSECRET "` legitimately equals the
  // secret. Inner whitespace is preserved and is the meaningful case.
  ['the secret with inner whitespace', 'BEAT SECRET'],
]) {
  kv = makeKv(); env = { ...env, STATUS_BEATS: kv };
  const { res } = await hit('/beat/agents', { method: 'POST', headers: { 'X-Beat-Secret': secret } });
  check(`rejects ${name}`, res.status === 401 && kv.store.size === 0, `status=${res.status} stored=${kv.store.size}`);
}
{
  // A 401 that echoed the expected value would hand the secret to anyone who guessed wrong.
  kv = makeKv(); env = { ...env, STATUS_BEATS: kv };
  const res = await worker.fetch(
    new Request('https://status-api.seerly.app/beat/agents', { method: 'POST', headers: { 'X-Beat-Secret': 'WRONG' } }),
    env, ctx
  );
  const text = await res.text();
  check('rejection body never contains the secret', !text.includes('BEATSECRET'), text.slice(0, 80));
}
{
  kv = makeKv(); env = { ...env, STATUS_BEATS: kv };
  const { res } = await hit('/beat/not-a-component', { method: 'POST', headers: { 'X-Beat-Secret': 'BEATSECRET' } });
  check('refuses unknown components (no free storage)', res.status === 404 && kv.store.size === 0, `status=${res.status}`);
}
{
  // KV failures must not surface as an opaque 5xx from the runtime, and must never read
  // as success — the free tier's daily write cap makes this a realistic path.
  const failing = { ...makeKv(), put: async () => { throw new Error('KV write limit exceeded'); } };
  const { res } = await hit('/beat/agents', { method: 'POST', headers: { 'X-Beat-Secret': 'BEATSECRET' } });
  void res;
  const res2 = await worker.fetch(
    new Request('https://status-api.seerly.app/beat/agents', { method: 'POST', headers: { 'X-Beat-Secret': 'BEATSECRET' } }),
    { ...env, STATUS_BEATS: failing }, ctx
  );
  check('KV write failure answers 503, does not throw', res2.status === 503, `status=${res2.status}`);
}
{
  const failing = { async get() { throw new Error('KV read failed'); } };
  const res = await worker.fetch(
    new Request('https://status-api.seerly.app/health/agents'),
    { ...env, STATUS_BEATS: failing }, ctx
  );
  check('KV read failure reports unavailable, not green', res.status === 503, `status=${res.status}`);
}
{
  kv = makeKv();
  const noSecret = { GITHUB_TOKEN: 'T', STATUS_BEATS: kv };
  const res = await worker.fetch(
    new Request('https://status-api.seerly.app/beat/agents', { method: 'POST', headers: { 'X-Beat-Secret': 'anything' } }),
    noSecret, ctx
  );
  check('fails closed when STATUS_BEAT_SECRET is unset', res.status === 503 && kv.store.size === 0, `status=${res.status}`);
}
{
  kv = makeKv(); env = { ...env, STATUS_BEATS: kv };
  const { res } = await hit('/beat/agents', { method: 'GET' });
  check('GET cannot record a beat', res.status === 405 && kv.store.size === 0, `status=${res.status}`);
}

console.log('\n--- heartbeat: freshness reporting ---');
{
  const now = Date.now();
  const cases = [
    ['fresh beat (1 min old)', now - 60_000, 200],
    ['just inside the window (9 min)', now - 9 * 60_000, 200],
    ['just outside the window (11 min)', now - 11 * 60_000, 503],
    ['ancient beat (2 h)', now - 2 * 60 * 60_000, 503],
  ];
  for (const [name, ts, expected] of cases) {
    env = { ...env, STATUS_BEATS: makeKv({ 'beat:agents': String(ts) }) };
    const { res, json } = await hit('/health/agents');
    check(`${name} -> ${expected}`, res.status === expected, `got ${res.status}`);
    check(`  body matches status`, json.status === (expected === 200 ? 'ok' : 'unavailable'), JSON.stringify(json));
  }
}
{
  // No beat ever recorded is NOT "up" — we have no evidence of life, and claiming
  // otherwise is exactly the false-green this whole endpoint exists to avoid.
  env = { ...env, STATUS_BEATS: makeKv() };
  const { res } = await hit('/health/agents');
  check('never-seen component reports unavailable, not ok', res.status === 503, `status=${res.status}`);
}
{
  env = { ...env, STATUS_BEATS: makeKv({ 'beat:agents': 'not-a-number' }) };
  const { res } = await hit('/health/agents');
  check('corrupt stored value reports unavailable', res.status === 503, `status=${res.status}`);
}
{
  // A clock skew that puts the beat in the future must not read as fresh forever.
  env = { ...env, STATUS_BEATS: makeKv({ 'beat:agents': String(Date.now() + 60 * 60_000) }) };
  const { res } = await hit('/health/agents');
  check('future-dated beat is not treated as fresh', res.status === 503, `status=${res.status}`);
}
{
  env = { ...env, STATUS_BEATS: makeKv({ 'beat:agents': String(Date.now()) }) };
  const { res } = await hit('/health/agents');
  check('health check is never cached', res.headers.get('Cache-Control') === 'no-store');
  const { res: unknown } = await hit('/health/nope');
  check('unknown component health -> 404', unknown.status === 404, `status=${unknown.status}`);
}
{
  // KV binding missing (deployed without the namespace) must not report green.
  const res = await worker.fetch(
    new Request('https://status-api.seerly.app/health/agents'),
    { GITHUB_TOKEN: 'T', STATUS_BEAT_SECRET: 'S' }, ctx
  );
  check('missing KV binding reports unavailable', res.status === 503, `status=${res.status}`);
}
{
  // The heartbeat routes must not have punched a hole in the GitHub proxy allowlist.
  env = { ...env, STATUS_BEATS: makeKv() };
  const { res } = await hit('/health/agents/../../api/user');
  check('beat routes do not bypass the proxy allowlist', res.status === 403 || res.status === 404, `status=${res.status}`);
}
{
  env = { ...env, STATUS_BEATS: makeKv({ 'beat:agents': String(Date.now()) }) };
  const { res } = await hit('/health/agents', { method: 'POST' });
  check('health route rejects non-GET', res.status === 405, `status=${res.status}`);
}

console.log('\n--- regressions the heartbeat work must not introduce ---');
{
  // CORS must not reflect an arbitrary origin back: that would let any site read the
  // proxied GitHub responses using this Worker's token.
  const res = await worker.fetch(
    new Request('https://status-api.seerly.app/api/repos/Seerly-AI/status/issues', {
      headers: { Origin: 'https://evil.example' },
    }),
    env, ctx
  );
  check('does not reflect a disallowed Origin',
    res.headers.get('Access-Control-Allow-Origin') === ORIGIN,
    res.headers.get('Access-Control-Allow-Origin'));
}
{
  // "Never cache errors" — a cached 5xx would pin the status page to a failure for the
  // full TTL, long after GitHub recovered.
  const puts = [];
  globalThis.caches = {
    default: { match: async () => undefined, put: async (k, v) => { puts.push(v.status); } },
  };
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 502 });
  await worker.fetch(
    new Request('https://status-api.seerly.app/api/repos/Seerly-AI/status/issues', { headers: { Origin: ORIGIN } }),
    env,
    { waitUntil: (p) => p }
  );
  globalThis.fetch = realFetch2;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  check('upstream errors are not written to the edge cache', puts.length === 0, `cached: ${puts.join()}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.fetch = realFetch;
process.exit(fail ? 1 : 0);
