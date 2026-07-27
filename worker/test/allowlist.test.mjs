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

const worker = (await import('../src/worker.js')).default;
const env = { GITHUB_TOKEN: 'TESTTOKEN' };
const ctx = { waitUntil: () => {} };
const ORIGIN = 'https://status.seerly.app';

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

console.log('\n--- path traversal ---');
{
  const { res, sent } = await call('/api/repos/Seerly-AI/status/../../../user');
  check('traversal cannot escape the allowlist', !sent || sent.url.startsWith('https://api.github.com/repos/Seerly-AI/status/'),
    `sent=${sent?.url} status=${res.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.fetch = realFetch;
process.exit(fail ? 1 : 0);
