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

`wrangler.toml` declares `status-api.seerly.app` as a **Custom Domain**, which creates and
manages its own DNS record. Do **not** also add a `status-api` CNAME by hand — the two
conflict.

Note this is a different hostname from the status page itself. `status.seerly.app` stays a
CNAME to GitHub Pages and must remain **DNS only / grey cloud**, or GitHub cannot renew its
certificate.

## Verify before switching the page over

```bash
# should return JSON
curl -s "https://status-api.seerly.app/raw/Seerly-AI/status/master/history/summary.json" | head -c 120

# should return 403 — the proxy is not an open GitHub relay
curl -s -o /dev/null -w '%{http_code}\n' "https://status-api.seerly.app/api/repos/someone/other/issues"

# second call should report X-Proxy-Cache: HIT
curl -sI "https://status-api.seerly.app/api/repos/Seerly-AI/status/issues?state=open" | grep -i x-proxy-cache
```

## Then enable it

Uncomment these two keys under `status-website` in `.upptimerc.yml` and commit:

```yaml
apiBaseUrl: https://status-api.seerly.app/api
userContentBaseUrl: https://status-api.seerly.app/raw
```

**Order matters.** Enabling them before the Worker answers points every request at a
hostname that does not resolve and breaks the status page completely.

Both keys are required: `apiBaseUrl` covers the Octokit calls, `userContentBaseUrl` covers
the graphs and summary data served from `raw.githubusercontent.com`. Proxying only one
leaves half the page on the unauthenticated path.

## Tests

```bash
node test/allowlist.test.mjs
```

22 assertions covering the security-relevant behaviour: only `Seerly-AI/status` is
reachable, GET/HEAD only, the token goes to the API host but never to the raw host,
prefix-confusion names like `status-evil` are refused, and path traversal cannot escape the
allowlist. Run it after any edit — a mistake here turns the Worker into an open,
token-bearing GitHub proxy.
