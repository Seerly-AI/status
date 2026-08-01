# Status page GitHub proxy (Cloudflare Worker)

Removes the GitHub rate limit that visitors to `status.seerly.app` hit.

## The problem this solves

The Upptime status page queries GitHub **from the visitor's browser**. Unauthenticated
GitHub API requests are capped at **60/hour per IP address** — and that IP is shared by
everyone behind the same NAT (an office, a café, a VPN). Each page load spends roughly
three API calls (open incidents, scheduled maintenance, closed incidents), so a shared
address can exhaust the quota in a couple of dozen loads. Every visitor from that address
then sees GitHub's *"Rate limit exceeded"* page instead of your status page.

That failure peaks **during an incident**, when traffic spikes and people reload — exactly
when the page has to work.

This Worker fixes it two ways:

1. **Authentication** — requests carry a token server-side, lifting the ceiling from 60 to
   **5,000/hour**.
2. **Edge caching** — responses are cached for 60 seconds, so a hundred simultaneous
   visitors collapse into a single upstream request. This matters more than the token.

## Why Cloudflare, not Seerly's own servers

A status page must not share a failure domain with the thing it reports on. Workers run on
Cloudflare's edge, independent of Seerly's VMs, so a Seerly outage cannot take this proxy —
or the status page — down with it. Putting the proxy on the API server would have quietly
undone the main reason the status page is hosted off-infrastructure at all.

## The token needs no permissions

The status repo is **public**, so the token needs **no scopes and no repository access**.
An unscoped token still authenticates, and authentication alone is what raises the limit.
If it ever leaked it would grant nothing an anonymous request could not already do.

Create it at **Settings → Developer settings → Personal access tokens → Fine-grained
tokens**, with *Public Repositories (read-only)* and no additional permissions.

## Deploy

```bash
cd worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN     # paste the token; never commit it
npx wrangler deploy
```

The Worker is deployed to **"Rakesh Menon - Account"** on its default hostname:

    https://seerly-status-proxy.rakesh-menon-account.workers.dev

`wrangler.toml` pins that account id, because the `seerly.app` zone lives in a different
Cloudflare account whose membership has no Workers role — deploying there fails with
"Authentication error [code: 10000]". The custom-domain block is present but commented out;
if that role is ever granted, uncomment it and switch the URLs below plus the two keys in
`.upptimerc.yml`.

Note `status.seerly.app` itself is unrelated to this Worker: it stays a CNAME to GitHub
Pages and must remain **DNS only / grey cloud**, or GitHub cannot renew its certificate.

## Verify before switching the page over

```bash
# should return JSON
curl -s "https://seerly-status-proxy.rakesh-menon-account.workers.dev/raw/Seerly-AI/status/master/history/summary.json" | head -c 120

# should return 403 — the proxy is not an open GitHub relay
curl -s -o /dev/null -w '%{http_code}\n' "https://seerly-status-proxy.rakesh-menon-account.workers.dev/api/repos/someone/other/issues"

# second call should report X-Proxy-Cache: HIT
curl -sI "https://seerly-status-proxy.rakesh-menon-account.workers.dev/api/repos/Seerly-AI/status/issues?state=open" | grep -i x-proxy-cache
```

## Enabled

These two keys are live under `status-website` in `.upptimerc.yml`:

```yaml
apiBaseUrl: https://seerly-status-proxy.rakesh-menon-account.workers.dev/api
userContentBaseUrl: https://seerly-status-proxy.rakesh-menon-account.workers.dev/raw
```

**Order matters** if you ever change the host: point the page at the Worker only after the
Worker answers, or every request goes to a hostname that does not resolve.

Both keys are required: `apiBaseUrl` covers the Octokit calls, `userContentBaseUrl` covers
the graphs and summary data served from `raw.githubusercontent.com`. Proxying only one
leaves half the page on the unauthenticated path.

## Heartbeat (components that cannot be probed from outside)

`seerly-agents` runs on its own VM with no public hostname. The status page used to infer
its health from an airo-backend endpoint, so on 2026-07-31 an unhealthy backend container
published *"AI Agents is down"* while the agents service was running perfectly — a claim
nothing had verified.

Rather than exposing that VM, it reports outward:

```
seerly-agents ──POST /beat/agents (every 3 min, X-Beat-Secret)──▶ Worker ──▶ KV
Upptime ──GET /health/agents──▶ Worker  → 200 if last beat < 10 min old, else 503
```

If the agents service dies, beats stop and the row goes red — independently of
airo-backend, which is the point. **Honest limitation:** a beat proves "the process is
alive and can reach the internet", so a dead beat-sender looks like a dead service. That is
why the sender lives inside the component itself.

### Setup

```bash
npx wrangler kv namespace create STATUS_BEATS   # paste id into wrangler.toml, UNCOMMENT the block
npx wrangler secret put STATUS_BEAT_SECRET             # any long random string
npx wrangler deploy
```

Then on the agents VM set `STATUS_BEAT_URL=https://seerly-status-proxy.rakesh-menon-account.workers.dev/beat/agents` and
`STATUS_BEAT_SECRET=<same value>`, and redeploy. Both are already forwarded in
`seerly-agents/docker-compose.yml` and `docker-compose.prod.yml`; a guard test
(`src/config/docker-env-passthrough.spec.ts`) fails if that forwarding is ever dropped,
because a missing var makes the heartbeat silently inert.

### Verify before pointing the status page at it

```bash
# 503 until the first beat lands — "no evidence of life" is not "up"
curl -s -o /dev/null -w '%{http_code}\n' https://seerly-status-proxy.rakesh-menon-account.workers.dev/health/agents

# after seerly-agents has been running ~3 minutes, expect 200
```

Only once that returns 200 should the `Agent execution` row in `.upptimerc.yml` be pointed
at `https://seerly-status-proxy.rakesh-menon-account.workers.dev/health/agents`. Switching earlier opens a false incident.

**Budget:** Cloudflare's free KV allows 1,000 writes/day **per account, across all
namespaces** — and the cost is per *sender*, not per component. One sender beating every 3
minutes costs 480/day. A second sender (a staging deployment pointed at the same
`/beat/agents`, say) makes it 960 — 96% of the cap, after which writes fail and the row
goes red while the service is fine. Widen the interval before adding senders; never
shorten it to 1 minute (1,440/day, over the cap on its own).

**Secret scope:** `STATUS_BEAT_SECRET` only authorises "component X is alive" claims. If it leaks,
the worst case is a forged heartbeat holding a row green while the component is dead.
Rotate by re-running `wrangler secret put` and updating the agents VM.

## Tests

```bash
node test/allowlist.test.mjs
```

68 assertions covering the security-relevant behaviour:

- **Proxy allowlist** — only `Seerly-AI/status` is reachable, GET/HEAD only, the token goes
  to the API host but never to the raw host, prefix-confusion names like `status-evil` are
  refused, path traversal cannot escape.
- **CORS** — preflight echoes the headers the browser asks for. A hardcoded list here once
  broke every Safari and iOS visitor, because Octokit sends `user-agent` (which Chrome
  strips) and the preflight rejected it.
- **Heartbeat** — forged, absent, empty and wrong-length secrets are all refused; unknown
  components cannot write; a missing `STATUS_BEAT_SECRET` or KV binding fails closed; never-seen,
  corrupt and future-dated beats report *unavailable* rather than green.

Run it after any edit — a mistake in the allowlist turns this into an open, token-bearing
GitHub proxy, and a mistake in the heartbeat makes a dead service look alive.
