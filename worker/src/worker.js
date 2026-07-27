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
 *   status-website.apiBaseUrl         -> https://status-api.seerly.app/api
 *   status-website.userContentBaseUrl -> https://status-api.seerly.app/raw
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

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, If-None-Match',
    // Octokit reads pagination and rate-limit metadata off the response.
    'Access-Control-Expose-Headers': 'ETag, Link, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    Vary: 'Origin',
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

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
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
