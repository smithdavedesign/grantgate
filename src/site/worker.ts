// The Cloudflare Worker (wrangler.jsonc, production since 2026-11-08): the landing page's API, the same handler the
// Vercel functions ran (api.ts), with the waitlist store and the checkout link from the Worker's secrets:
//
//   POST /api/waitlist   join or leave the waitlist (DATABASE_URL: the Neon database, reached over HTTPS)
//   GET  /api/checkout   303 to STRIPE_PAYMENT_LINK, or to the waitlist while there is none
//
// Every other path is a static file from `npm run cf:build`, which Cloudflare serves before the Worker runs, with
// SITE_HEADERS from its _headers file. API responses get the same headers here.
import { SITE_HEADERS, handleApi, storeFromEnv, type ApiDeps } from './api.ts';
import type { WaitlistStore } from './waitlist.ts';

/** The Worker's bindings: its static files, and the secrets set with `provision cloudflare secret grantgate <KEY>`. */
export interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DATABASE_URL?: string;
  STRIPE_PAYMENT_LINK?: string;
}

// One store per DATABASE_URL for the Worker's lifetime, so the table check runs once, not on every request (the
// Neon driver sends each query as its own HTTPS request, so nothing is tied to the request that made it).
let cached: { url: string | undefined; store: WaitlistStore | null } | null = null;

function storeFor(env: WorkerEnv): WaitlistStore | null {
  if (cached === null || cached.url !== env.DATABASE_URL) cached = { url: env.DATABASE_URL, store: storeFromEnv({ DATABASE_URL: env.DATABASE_URL }) };
  return cached.store;
}

/** The response with SITE_HEADERS added, keeping any header it already sets. */
export function withSiteHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SITE_HEADERS)) if (!out.headers.has(name)) out.headers.set(name, value);
  return out;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const deps: ApiDeps = { store: storeFor(env), checkoutUrl: env.STRIPE_PAYMENT_LINK };
      return withSiteHeaders(await handleApi(request, deps));
    }
    return env.ASSETS.fetch(request);
  },
};
