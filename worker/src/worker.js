/**
 * GitHub proxy for the Seerly status page.
 *
 * WHY THIS EXISTS
 * The Upptime status page talks to GitHub from the VISITOR'S browser. Unauthenticated
 * GitHub API requests are capped at 60/hour PER IP — and that IP is shared by everyone
 * behind the same NAT (an office, a café, a VPN). Each page load spends ~3 API calls
 * (open incidents, scheduled maintenance, closed incidents), so a shared address can
 * exhaust the quota in a couple of dozen loads and every visitor then sees GitHub's
 * "Rate limit exceeded" page instead of the status page. That failure peaks during an
 * incident, when traffic spikes and people reload — exactly when the page must work.
 *
 * This Worker sits in front of GitHub, adds a token server-side (5,000/hour instead of
 * 60), and caches responses at the edge so N simultaneous visitors collapse into one
 * upstream call.
 *
 * WHY CLOUDFLARE AND NOT SEERLY'S OWN SERVERS
 * A status page must not share failure domains with the thing it reports on. Workers run
 * on Cloudflare's edge, independent of Seerly's VMs, so a Seerly outage cannot take this
 * proxy — or the status page — down with it.
 *
 * The status page is configured to reach it via two keys in .upptimerc.yml:
 *   status-website.apiBaseUrl         -> <worker-host>/api
 *   status-website.userContentBaseUrl -> <worker-host>/raw
 */

/** Path prefix -> upstream origin. */
const UPSTREAMS = {
  '/api': 'https://api.github.com',
  '/raw': 'https://raw.githubusercontent.com',
};

/**
 * Only this repository may be proxied. Without this the Worker would be an open,
 * token-bearing GitHub proxy that anyone could point at any repo — and our token,
 * however weak, would be doing the asking.
 */
const OWNER = 'Seerly-AI';
const REPO = 'status';

/** Browsers allowed to call this proxy. */
const ALLOWED_ORIGINS = ['https://status.seerly.app', 'https://seerly-ai.github.io'];

/** Edge cache lifetime. Uptime data changes on the order of minutes, never seconds. */
const CACHE_TTL_SECONDS = 60;

/**
 * Headers GitHub's own API permits. We must be at least as permissive: a proxy that
 * allows FEWER headers than the origin it fronts silently breaks clients that worked
 * before it existed.
 *
 * This bit us in Safari. Octokit sets a `user-agent` header; Chrome strips it (it is a
 * forbidden header name) so the request stays "simple" and skips preflight, but Safari
 * sends it, which forces a preflight. The old hardcoded list here — Accept, Content-Type,
 * If-None-Match — did not include user-agent, so Safari's preflight failed, the fetch
 * threw, and the page rendered "An error occurred". Chrome was fine, which is exactly
 * what made it look like a Safari bug rather than ours.
 */
const DEFAULT_ALLOWED_HEADERS =
  'Accept, Accept-Encoding, Authorization, Content-Type, If-Match, If-Modified-Since, ' +
  'If-None-Match, If-Unmodified-Since, User-Agent, X-Requested-With, X-GitHub-Api-Version';

/**
 * @param origin        the requesting page's origin
 * @param requestedHeaders  value of Access-Control-Request-Headers on a preflight; echoed
 *                          back so we never reject a header the browser actually needs.
 */
function corsHeaders(origin, requestedHeaders) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': requestedHeaders || DEFAULT_ALLOWED_HEADERS,
    // Octokit reads pagination and rate-limit metadata off the response.
    'Access-Control-Expose-Headers': 'ETag, Link, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    // Preflights are per (origin, method, headers); caching them for a day keeps Safari
    // from paying an extra round trip before every API call.
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Headers',
  };
}

function deny(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/**
 * Decide whether a path is one we are willing to fetch, and translate it upstream.
 * Returns null when the request is not allowed.
 */
function resolveTarget(pathname) {
  for (const [prefix, origin] of Object.entries(UPSTREAMS)) {
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue;
    const rest = pathname.slice(prefix.length) || '/';

    // api.github.com/repos/Seerly-AI/status/...
    if (prefix === '/api' && !rest.startsWith(`/repos/${OWNER}/${REPO}/`)) return null;
    // raw.githubusercontent.com/Seerly-AI/status/...
    if (prefix === '/raw' && !rest.startsWith(`/${OWNER}/${REPO}/`)) return null;

    return origin + rest;
  }
  return null;
}

/**
 * HEARTBEAT ("dead man's switch")
 * ------------------------------------------------------------------------------------
 * Some components cannot be observed from outside. seerly-agents runs on its own VM with
 * no public hostname, so the status page used to infer its health from an airo-backend
 * endpoint — which meant an unhealthy backend container reported "AI Agents is down" while
 * the agents service was running perfectly (incident #5, 2026-07-31).
 *
 * Instead of opening that VM to the internet, it reports outward: the service POSTs a beat
 * on a timer, and this Worker answers GET /health/<component> based on how long ago the
 * last beat arrived. If the agents service dies, beats stop and the row goes red —
 * independently of airo-backend, which is the whole point.
 *
 * Honest limitation: this proves "the component is alive and can reach the internet", so a
 * dead beat-sender looks like a dead component. That is why the sender lives inside the
 * component itself rather than somewhere adjacent to it.
 */

/** Components allowed to beat. Anything else is refused, so the endpoint cannot be used as free storage. */
const BEAT_COMPONENTS = new Set(['agents']);

/**
 * A component is considered up if its last beat is younger than this.
 * Senders beat every 3 minutes, so this tolerates two missed beats before going red —
 * enough to ride out a restart or a slow network without flapping.
 */
const BEAT_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * KV keys expire on their own so a component that is decommissioned stops answering
 * instead of lingering. Comfortably longer than the staleness window.
 */
const BEAT_KEY_TTL_SECONDS = 24 * 60 * 60;

/** Length-safe, non-short-circuiting comparison so a wrong secret leaks nothing via timing. */
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function beatJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Never cache: a cached "ok" would keep reporting a dead component as alive, which
      // is precisely the failure this endpoint exists to prevent.
      'Cache-Control': 'no-store',
    },
  });
}

/** POST /beat/<component> — record a heartbeat. Requires the shared secret. */
async function recordBeat(request, env, component, now) {
  if (!BEAT_COMPONENTS.has(component)) return beatJson(404, { status: 'unknown component' });
  // Fail closed: with no secret configured, anyone could forge liveness.
  if (!env.STATUS_BEAT_SECRET) return beatJson(503, { status: 'unavailable' });

  const presented =
    request.headers.get('X-Beat-Secret') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secretsMatch(presented, env.STATUS_BEAT_SECRET)) return beatJson(401, { status: 'unauthorized' });

  if (!env.STATUS_BEATS) return beatJson(503, { status: 'unavailable' });

  // A rejected put() would escape fetch() as an opaque Cloudflare 1101. The realistic
  // trigger is the free tier's 1,000 writes/day cap, after which beats stop landing for
  // the rest of the UTC day and a healthy service reads as dead — the exact false report
  // this heartbeat exists to end. Answer honestly instead: the sender logs it, and the
  // health route keeps reporting on whatever the last good beat was.
  try {
    await env.STATUS_BEATS.put(`beat:${component}`, String(now), {
      expirationTtl: BEAT_KEY_TTL_SECONDS,
    });
  } catch {
    return beatJson(503, { status: 'unavailable' });
  }
  return beatJson(202, { status: 'ok' });
}

/**
 * GET /health/<component> — what Upptime monitors. Public and unauthenticated, like every
 * other status probe, and it reveals only up/down.
 */
async function readBeat(env, component, now) {
  if (!BEAT_COMPONENTS.has(component)) return beatJson(404, { status: 'unknown component' });
  if (!env.STATUS_BEATS) return beatJson(503, { status: 'unavailable' });

  let raw;
  try {
    raw = await env.STATUS_BEATS.get(`beat:${component}`);
  } catch {
    // A KV read failure is not evidence the component is down, but it is also not evidence
    // it is up. Report unavailable rather than inventing a green.
    return beatJson(503, { status: 'unavailable' });
  }
  const last = raw ? Number(raw) : NaN;
  // No beat ever recorded, or an unparseable one, means we have no evidence of life.
  // Reporting "up" here would be a claim we cannot support.
  if (!Number.isFinite(last)) return beatJson(503, { status: 'unavailable' });

  const ageMs = now - last;
  const fresh = ageMs >= 0 && ageMs <= BEAT_STALE_AFTER_MS;
  return beatJson(fresh ? 200 : 503, { status: fresh ? 'ok' : 'unavailable' });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, request.headers.get('Access-Control-Request-Headers')),
      });
    }

    // Heartbeat routes are handled before the GitHub proxy: they are not proxied traffic
    // and POST is legitimate here, unlike everywhere else in this Worker.
    const beatMatch = url.pathname.match(/^\/beat\/([a-z0-9-]{1,32})$/);
    if (beatMatch) {
      if (request.method !== 'POST') return beatJson(405, { status: 'method not allowed' });
      return recordBeat(request, env, beatMatch[1], Date.now());
    }
    const healthMatch = url.pathname.match(/^\/health\/([a-z0-9-]{1,32})$/);
    if (healthMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return beatJson(405, { status: 'method not allowed' });
      }
      return readBeat(env, healthMatch[1], Date.now());
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return deny(405, 'Only GET and HEAD are proxied', origin);
    }

    const target = resolveTarget(url.pathname);
    if (!target) {
      return deny(403, `Only ${OWNER}/${REPO} may be proxied through this endpoint`, origin);
    }

    // Serve from the edge cache when we can: during an incident hundreds of visitors
    // arrive at once, and they should cost one upstream request between them.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set('X-Proxy-Cache', 'HIT');
      for (const [k, v] of Object.entries(corsHeaders(origin))) hit.headers.set(k, v);
      return hit;
    }

    const upstreamHeaders = {
      Accept: request.headers.get('Accept') || 'application/vnd.github.v3+json',
      'User-Agent': 'seerly-status-proxy',
    };
    // The API needs the token to lift the 60/hour cap. raw.githubusercontent.com is a
    // CDN with no such limit for public content, so we deliberately do NOT send the
    // token there — fewer places for it to travel.
    if (url.pathname.startsWith('/api') && env.GITHUB_TOKEN) {
      upstreamHeaders.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    }

    // Deliberately no `cf: { cacheTtl, cacheEverything }` here. We already cache
    // explicitly through the Cache API below; layering the edge's own cache hints on top
    // was redundant and coincided with intermittent Cloudflare 1042 errors on the
    // upstream fetch. One caching mechanism, owned by us, is easier to reason about.
    let upstream;
    try {
      upstream = await fetch(target + url.search, {
        method: 'GET',
        headers: upstreamHeaders,
      });
    } catch (err) {
      return deny(502, 'Upstream request failed', origin);
    }

    // Buffer the body rather than streaming it. A streamed body cannot be shared between
    // the response we return and the copy we hand to cache.put() without the two racing
    // over the same stream. These payloads are small JSON/SVG documents, so the cost is
    // negligible and the behaviour becomes deterministic.
    const body = await upstream.arrayBuffer();

    const response = new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        'X-Proxy-Cache': 'MISS',
        ...corsHeaders(origin),
      },
    });
    // Forward pagination + rate-limit metadata. Octokit reads Link; the X-RateLimit-*
    // headers are how we can tell from outside whether the token is actually being
    // applied — an authenticated request reports a limit of 5000, an unauthenticated one
    // reports 60. Without this passthrough a mis-named secret would fail silently, and
    // the proxy would quietly run anonymous from shared Cloudflare IPs: strictly worse
    // than not proxying at all.
    for (const h of ['Link', 'ETag', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']) {
      const v = upstream.headers.get(h);
      if (v) response.headers.set(h, v);
    }

    // Never cache errors — a transient 5xx must not pin the status page to a failure
    // for a full minute.
    if (upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};
