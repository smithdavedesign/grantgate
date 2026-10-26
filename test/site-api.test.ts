import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CHECKOUT_FALLBACK,
  MAX_BODY_BYTES,
  MESSAGES,
  SITE_HEADERS,
  checkoutTarget,
  escapeHtml,
  handleApi,
  nodeHandler,
  productionHandler,
  redact,
  storeFromEnv,
  type ApiDeps,
} from '../src/site/api.ts';
import { memoryStore, type WaitlistStore } from '../src/site/waitlist.ts';

const BASE = 'http://localhost';
const JSON_TYPE = 'application/json';
const FORM_TYPE = 'application/x-www-form-urlencoded';

// Built at runtime so no credential-shaped string sits in the repo.
const FAKE_DATABASE_URL = ['postgres', '://', 'grantgate', ':', 'Zx9'.repeat(6), '@', 'ep-demo.example', '/neondb'].join('');

function post(path: string, body: string, type: string | null = JSON_TYPE): Request {
  const headers: Record<string, string> = type ? { 'content-type': type } : {};
  return new Request(`${BASE}${path}`, { method: 'POST', headers, body });
}
const postJson = (fields: unknown) => post('/api/waitlist', JSON.stringify(fields));
const postForm = (fields: Record<string, string>) => post('/api/waitlist', new URLSearchParams(fields).toString(), FORM_TYPE);

/** Serves `handle` on a free port, asks it for /api/checkout, and says where it was sent. */
async function checkoutVia(handle: ReturnType<typeof productionHandler>): Promise<{ status: number; location: string | null }> {
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/checkout`, { redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location') };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function deps(overrides: Partial<ApiDeps> = {}) {
  const store = memoryStore();
  const logs: string[] = [];
  return { store, logs, deps: { store, log: (m: string) => logs.push(m), ...overrides } satisfies ApiDeps };
}

describe('handleApi: POST /api/waitlist', () => {
  it('stores a JSON sign-up and replies with JSON', async () => {
    const { store, deps: d } = deps();
    const res = await handleApi(postJson({ email: 'Owner@Acme-Dental.example', role: 'owner', team_size: '5-50' }), d);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true, message: MESSAGES.joined });
    const row = store.rows.get('owner@acme-dental.example');
    assert.equal(row?.role, 'owner');
    assert.equal(row?.teamSize, '5-50');
    assert.equal(row?.interview, false);
  });

  it('thanks people who offer a call, and records the opt-in', async () => {
    const { store, deps: d } = deps();
    const res = await handleApi(postJson({ email: 'office@acme.example', interview: true }), d);
    assert.deepEqual(await res.json(), { ok: true, message: MESSAGES.joinedInterview });
    assert.equal(store.rows.get('office@acme.example')?.interview, true);
  });

  it('accepts a JSON content type with parameters', async () => {
    const { store, deps: d } = deps();
    const res = await handleApi(post('/api/waitlist', JSON.stringify({ email: 'a@acme.example' }), 'application/json; charset=utf-8'), d);
    assert.equal(res.status, 200);
    assert.ok(store.rows.has('a@acme.example'));
  });

  it('answers a plain form post (no JS) with an HTML page that never echoes the address', async () => {
    const { store, deps: d } = deps();
    const res = await handleApi(postForm({ action: 'join', email: 'owner@acme.example', interview: 'yes', website: '' }), d);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('content-security-policy'), SITE_HEADERS['Content-Security-Policy']);
    const html = await res.text();
    assert.ok(html.includes(escapeHtml(MESSAGES.joinedInterview)), html);
    assert.ok(!html.includes('owner@acme.example'));
    assert.match(html, /<a href="\/">/);
    assert.match(html, /<link rel="stylesheet" href="\/styles.css">/);
    assert.equal(store.rows.get('owner@acme.example')?.interview, true);
  });

  it('gives a repeat sign-up the same reply, so the list cannot be probed', async () => {
    const { store, deps: d } = deps();
    const first = await (await handleApi(postJson({ email: 'owner@acme.example' }), d)).json();
    const second = await (await handleApi(postJson({ email: 'OWNER@acme.example' }), d)).json();
    assert.deepEqual(first, second);
    assert.equal(store.rows.size, 1);
  });

  it('removes an address, with the same reply whether or not it was there', async () => {
    const { store, deps: d } = deps();
    await handleApi(postJson({ email: 'owner@acme.example' }), d);
    const removed = await handleApi(postJson({ action: 'leave', email: 'owner@acme.example' }), d);
    assert.deepEqual(await removed.json(), { ok: true, message: MESSAGES.left });
    assert.equal(store.rows.size, 0);
    const unknown = await handleApi(postJson({ action: 'leave', email: 'stranger@acme.example' }), d);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { ok: true, message: MESSAGES.left });
  });

  it('removes through a plain form post too', async () => {
    const { store, deps: d } = deps();
    await store.join({ email: 'owner@acme.example', role: null, teamSize: null, interview: false });
    const res = await handleApi(postForm({ action: 'leave', email: 'owner@acme.example' }), d);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(escapeHtml(MESSAGES.left)));
    assert.equal(store.rows.size, 0);
  });

  it('tells a bot that filled the honeypot it worked, and stores nothing', async () => {
    const { store, deps: d } = deps();
    const res = await handleApi(postJson({ email: 'bot@spam.example', interview: 'yes', website: 'https://spam.example' }), d);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: MESSAGES.joined });
    assert.equal(store.rows.size, 0);
    const leave = await handleApi(postJson({ action: 'leave', email: 'owner@acme.example', website: 'x' }), d);
    assert.deepEqual(await leave.json(), { ok: true, message: MESSAGES.left });
  });

  it('refuses an invalid email with 400, in JSON or HTML', async () => {
    const { store, deps: d } = deps();
    const json = await handleApi(postJson({ email: 'owner at acme' }), d);
    assert.equal(json.status, 400);
    assert.deepEqual(await json.json(), { ok: false, error: MESSAGES.invalidEmail });
    const form = await handleApi(postForm({ email: '<script>alert(1)</script>' }), d);
    assert.equal(form.status, 400);
    const html = await form.text();
    assert.ok(html.includes(escapeHtml(MESSAGES.invalidEmail)));
    assert.ok(!html.includes('<script>alert'));
    assert.equal(store.rows.size, 0);
  });

  it('refuses an unknown action, malformed JSON and non-object JSON with 400', async () => {
    const { deps: d } = deps();
    for (const req of [
      postJson({ action: 'export', email: 'a@acme.example' }),
      post('/api/waitlist', '{"email":'),
      postJson(['a@acme.example']),
      postJson('a@acme.example'),
      postJson(null),
    ]) {
      const res = await handleApi(req, d);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { ok: false, error: MESSAGES.unreadable });
    }
  });

  it('refuses content types other than JSON and form posts with 415', async () => {
    const { store, deps: d } = deps();
    for (const type of ['text/plain', 'multipart/form-data; boundary=x', null]) {
      const res = await handleApi(post('/api/waitlist', 'email=a@acme.example', type), d);
      assert.equal(res.status, 415, String(type));
    }
    assert.equal(store.rows.size, 0);
  });

  it('refuses bodies over the size limit with 413', async () => {
    const { store, deps: d } = deps();
    const padding = 'x'.repeat(MAX_BODY_BYTES);
    const res = await handleApi(postJson({ email: 'a@acme.example', role: padding }), d);
    assert.equal(res.status, 413);
    assert.equal(store.rows.size, 0);
  });

  it('allows only POST, saying so in the Allow header', async () => {
    const { deps: d } = deps();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await handleApi(new Request(`${BASE}/api/waitlist`, { method }), d);
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'POST');
    }
  });

  it('answers 503 when no database is configured, and logs which variable is missing', async () => {
    const logs: string[] = [];
    const res = await handleApi(postJson({ email: 'owner@acme.example' }), { store: null, log: (m) => logs.push(m) });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: MESSAGES.unavailable });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /DATABASE_URL is not set/);
    assert.ok(!logs[0].includes('owner@acme.example'));
  });

  it('answers 503 when the database fails, logging the error with URLs and emails redacted', async () => {
    const logs: string[] = [];
    const failing: WaitlistStore = {
      async join() {
        throw new Error(`could not connect to ${FAKE_DATABASE_URL} for owner@acme.example`);
      },
      async leave() {
        throw new Error('timeout');
      },
    };
    const res = await handleApi(postForm({ email: 'owner@acme.example' }), { store: failing, log: (m) => logs.push(m) });
    assert.equal(res.status, 503);
    assert.ok((await res.text()).includes(escapeHtml(MESSAGES.unavailable)));
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes(FAKE_DATABASE_URL), logs[0]);
    assert.ok(!logs[0].includes('Zx9'), logs[0]);
    assert.ok(!logs[0].includes('owner@acme.example'), logs[0]);
    assert.match(logs[0], /could not connect/);
  });

  it('logs to the console by default', async () => {
    const original = console.error;
    const seen: unknown[][] = [];
    console.error = (...args: unknown[]) => void seen.push(args);
    try {
      await handleApi(postJson({ email: 'owner@acme.example' }), { store: null });
    } finally {
      console.error = original;
    }
    assert.equal(seen.length, 1);
    assert.match(String(seen[0][0]), /DATABASE_URL is not set/);
  });
});

describe('handleApi: GET /api/checkout', () => {
  const get = (path = '/api/checkout', method = 'GET') => new Request(`${BASE}${path}`, { method });

  it('sends checkout to the configured payment link', async () => {
    const res = await handleApi(get(), { store: null, checkoutUrl: 'https://pay.example/founding-plan' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'https://pay.example/founding-plan');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const head = await handleApi(get('/api/checkout', 'HEAD'), { store: null, checkoutUrl: 'https://pay.example/founding-plan' });
    assert.equal(head.status, 303);
  });

  it('falls back to the waitlist while no checkout page is configured', async () => {
    const res = await handleApi(get(), { store: null });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), CHECKOUT_FALLBACK);
    assert.match(CHECKOUT_FALLBACK, /^\/\?checkout=soon#join$/);
  });

  it('treats an insecure or malformed checkout URL as unset, and logs that without its value', async () => {
    const withCredentials = ['https://', 'user', ':', 'pw', '@pay.example/plan'].join('');
    for (const bad of ['http://pay.example/plan', withCredentials, 'javascript:alert(1)', 'pay.example/plan', ' ']) {
      const logs: string[] = [];
      const res = await handleApi(get(), { store: null, checkoutUrl: bad, log: (m) => logs.push(m) });
      assert.equal(res.headers.get('location'), CHECKOUT_FALLBACK, bad);
      if (bad.trim() !== '') {
        assert.equal(logs.length, 1, bad);
        assert.match(logs[0], /STRIPE_PAYMENT_LINK is not an https URL/);
        assert.ok(!logs[0].includes('pay.example'), logs[0]);
      }
    }
  });

  it('ignores any redirect target in the query string', async () => {
    const res = await handleApi(get('/api/checkout?to=https://evil.example&url=https://evil.example'), { store: null });
    assert.equal(res.headers.get('location'), CHECKOUT_FALLBACK);
    const configured = await handleApi(get('/api/checkout?to=https://evil.example'), { store: null, checkoutUrl: 'https://pay.example/p' });
    assert.equal(configured.headers.get('location'), 'https://pay.example/p');
  });

  it('allows only GET and HEAD', async () => {
    const res = await handleApi(new Request(`${BASE}/api/checkout`, { method: 'POST', body: '' }), { store: null });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  });
});

describe('handleApi: other paths', () => {
  it('answers 404 for anything else', async () => {
    for (const path of ['/api', '/api/', '/api/waitlist/export', '/api/checkout/x', '/index.html']) {
      const res = await handleApi(new Request(`${BASE}${path}`), { store: null });
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { ok: false, error: MESSAGES.notFound });
    }
  });
});

describe('checkoutTarget, redact and escapeHtml', () => {
  it('keeps only https URLs without credentials', () => {
    assert.equal(checkoutTarget('https://pay.example/founding'), 'https://pay.example/founding');
    assert.equal(checkoutTarget('  https://pay.example/founding  '), 'https://pay.example/founding');
    const withCredentials = ['https://', 'a', ':', 'b', '@pay.example'].join('');
    for (const bad of [undefined, '', 'http://pay.example', withCredentials, 'https://a@pay.example', 'ftp://pay.example', 'nope']) {
      assert.equal(checkoutTarget(bad), null, String(bad));
    }
  });

  it('redacts URLs and email addresses', () => {
    const text = redact(`failed: ${FAKE_DATABASE_URL} (user owner@acme.example) at https://api.example/v1?x=1`);
    assert.equal(text, 'failed: [url] (user [email]) at [url]');
  });

  it('escapes the five HTML-special characters', () => {
    assert.equal(escapeHtml(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  });
});

describe('SITE_HEADERS', () => {
  it('locks pages to their own scripts and styles and forbids framing', () => {
    const csp = SITE_HEADERS['Content-Security-Policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
    assert.equal(SITE_HEADERS['X-Content-Type-Options'], 'nosniff');
    assert.equal(SITE_HEADERS['X-Frame-Options'], 'DENY');
    assert.equal(SITE_HEADERS['Referrer-Policy'], 'no-referrer');
  });
});

describe('storeFromEnv and productionHandler', () => {
  it('has no store without DATABASE_URL', () => {
    assert.equal(storeFromEnv({}), null);
    assert.equal(storeFromEnv({ DATABASE_URL: '' }), null);
  });

  it('makes a store from DATABASE_URL without connecting yet', () => {
    const store = storeFromEnv({ DATABASE_URL: FAKE_DATABASE_URL });
    assert.ok(store);
    assert.equal(typeof store.join, 'function');
    assert.equal(typeof store.leave, 'function');
  });
});

describe('nodeHandler over real HTTP', () => {
  let server: Server;
  let base = '';
  const store = memoryStore();
  let crash = false;

  before(async () => {
    const handle = nodeHandler(async (request) => {
      if (crash) throw new Error(`boom ${FAKE_DATABASE_URL}`);
      return handleApi(request, { store, log: () => {} });
    });
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('passes the request through and copies status, headers and body back', async () => {
    const res = await fetch(`${base}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify({ email: 'node@acme.example' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true, message: MESSAGES.joined });
    assert.ok(store.rows.has('node@acme.example'));
  });

  it('keeps the query string and ignores the Host header', async () => {
    const res = await new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
      const req = httpRequest(`${base}/api/checkout?to=https://evil.example`, { headers: { host: 'evil.example' } }, (r) => {
        r.resume();
        resolve({ status: r.statusCode ?? 0, location: r.headers.location });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 303);
    assert.equal(res.location, CHECKOUT_FALLBACK);
  });

  it('refuses a declared Content-Length over the limit without reading the body', async () => {
    const res = await fetch(`${base}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': JSON_TYPE },
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    assert.equal(res.status, 413);
  });

  it('stops reading a streamed body once it passes the limit', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/api/waitlist`, { method: 'POST', headers: { 'content-type': JSON_TYPE } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      // No Content-Length: Node sends this chunked.
      req.write('x'.repeat(MAX_BODY_BYTES));
      req.write('x'.repeat(MAX_BODY_BYTES));
      req.end();
    });
    assert.equal(status, 413);
  });

  it('never acts on half a body when the client goes away mid-upload', async () => {
    const before = store.rows.size;
    const original = console.error;
    const seen: string[] = [];
    console.error = (...args: unknown[]) => void seen.push(args.map(String).join(' '));
    try {
      // Declares more than it sends: what arrives would parse as a valid, but wrong, address.
      const partial = 'action=join&email=owner%40acme.example';
      await new Promise<void>((resolve) => {
        const req = httpRequest(`${base}/api/waitlist`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(partial.length + 3) },
        });
        req.on('error', () => resolve());
        req.write(partial, () => setTimeout(() => req.destroy(), 50));
        req.on('close', () => resolve());
      });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      console.error = original;
    }
    assert.equal(store.rows.size, before);
    assert.ok(!store.rows.has('owner@acme.example'));
    assert.deepEqual(seen, [], 'a client hanging up is not an error worth logging');
  });

  it('answers 500 with a generic message when the handler throws, and logs it redacted', async () => {
    const original = console.error;
    const seen: string[] = [];
    console.error = (...args: unknown[]) => void seen.push(args.map(String).join(' '));
    crash = true;
    try {
      const res = await fetch(`${base}/api/waitlist`, { method: 'POST', headers: { 'content-type': JSON_TYPE }, body: '{}' });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { ok: false, error: MESSAGES.unavailable });
    } finally {
      crash = false;
      console.error = original;
    }
    assert.equal(seen.length, 1);
    assert.ok(!seen[0].includes('Zx9'), seen[0]);
  });

  it('serves the production handler with no database as 503', async () => {
    const handle = productionHandler({});
    const prod = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => prod.listen(0, '127.0.0.1', resolve));
    const original = console.error;
    console.error = () => {};
    try {
      const url = `http://127.0.0.1:${(prod.address() as AddressInfo).port}`;
      const res = await fetch(`${url}/api/waitlist`, { method: 'POST', headers: { 'content-type': JSON_TYPE }, body: '{"email":"a@acme.example"}' });
      assert.equal(res.status, 503);
      const checkout = await fetch(`${url}/api/checkout`, { redirect: 'manual' });
      assert.equal(checkout.headers.get('location'), CHECKOUT_FALLBACK);
    } finally {
      console.error = original;
      await new Promise<void>((resolve) => prod.close(() => resolve()));
    }
  });

  it('passes STRIPE_PAYMENT_LINK from the environment to the production handler', async () => {
    assert.equal(
      (await checkoutVia(productionHandler({ CHECKOUT_URL: 'https://pay.example/old-name' }))).location,
      CHECKOUT_FALLBACK,
      'the old variable name is no longer read',
    );
    const handle = productionHandler({ STRIPE_PAYMENT_LINK: 'https://pay.example/founding-plan' });
    const prod = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => prod.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(prod.address() as AddressInfo).port}`;
      const checkout = await fetch(`${url}/api/checkout`, { redirect: 'manual' });
      assert.equal(checkout.status, 303);
      assert.equal(checkout.headers.get('location'), 'https://pay.example/founding-plan');
    } finally {
      await new Promise<void>((resolve) => prod.close(() => resolve()));
    }
  });
});
