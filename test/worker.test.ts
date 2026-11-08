// The Cloudflare Worker (src/site/worker.ts): the API on /api/*, the static files everywhere else, and the site's
// security headers on API responses. No database: without DATABASE_URL the waitlist refuses sign-ups (503).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { withSiteHeaders, type WorkerEnv } from '../src/site/worker.ts';
import { CHECKOUT_FALLBACK, MESSAGES, SITE_HEADERS } from '../src/site/api.ts';

const BASE = 'https://grantgate.1426davejobs.workers.dev';
const PAY = ['https://pay.example', 'grantgate'].join('/');

function env(extra: Partial<WorkerEnv> = {}) {
  const assetRequests: string[] = [];
  const e: WorkerEnv = {
    ASSETS: {
      async fetch(request: Request) {
        assetRequests.push(new URL(request.url).pathname);
        return new Response('static', { status: 200, headers: { 'Content-Type': 'text/html' } });
      },
    },
    ...extra,
  };
  return { env: e, assetRequests };
}

describe('the Cloudflare Worker', () => {
  it('serves pages and files from the static assets', async () => {
    const { env: e, assetRequests } = env();
    for (const path of ['/', '/privacy', '/page.js', '/apiary']) {
      const res = await worker.fetch(new Request(BASE + path), e);
      assert.equal(await res.text(), 'static', path);
    }
    assert.deepEqual(assetRequests, ['/', '/privacy', '/page.js', '/apiary']);
  });

  it('sends /api/checkout to the waitlist without a payment link, and to the link with one', async () => {
    const none = await worker.fetch(new Request(`${BASE}/api/checkout`), env().env);
    assert.equal(none.status, 303);
    assert.equal(none.headers.get('location'), CHECKOUT_FALLBACK);
    const paid = await worker.fetch(new Request(`${BASE}/api/checkout`), env({ STRIPE_PAYMENT_LINK: PAY }).env);
    assert.equal(paid.status, 303);
    assert.equal(paid.headers.get('location'), PAY);
  });

  it('refuses sign-ups without DATABASE_URL instead of dropping them', async () => {
    const res = await worker.fetch(
      new Request(`${BASE}/api/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.org' }) }),
      env().env,
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: MESSAGES.unavailable });
  });

  it('answers unknown API paths itself (404), never from the static files', async () => {
    const { env: e, assetRequests } = env();
    assert.equal((await worker.fetch(new Request(`${BASE}/api/nope`), e)).status, 404);
    assert.equal((await worker.fetch(new Request(`${BASE}/api`), e)).status, 404);
    assert.deepEqual(assetRequests, []);
  });

  it('puts the security headers on API responses, keeping the ones the API set', async () => {
    const res = await worker.fetch(new Request(`${BASE}/api/checkout`), env().env);
    for (const [name, value] of Object.entries(SITE_HEADERS)) assert.equal(res.headers.get(name), value, name);
    const own = withSiteHeaders(new Response('x', { headers: { 'X-Frame-Options': 'SAMEORIGIN' } }));
    assert.equal(own.headers.get('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(own.headers.get('Referrer-Policy'), SITE_HEADERS['Referrer-Policy']);
  });
});
