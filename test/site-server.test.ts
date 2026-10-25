import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../scripts/build-site.ts';
import { createSiteServer } from '../scripts/serve-site.ts';
import { CHECKOUT_FALLBACK, MESSAGES, SITE_HEADERS, escapeHtml } from '../src/site/api.ts';
import { memoryStore } from '../src/site/waitlist.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A request with the path sent exactly as written (fetch would normalise "..").  */
function raw(base: string, path: string, method = 'GET'): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = httpRequest({ hostname, port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('npm run site: the local server', () => {
  let out = '';
  let server: Server;
  let base = '';
  const store = memoryStore();

  before(async () => {
    await mkdir(join(ROOT, 'dist'), { recursive: true });
    out = await mkdtemp(join(ROOT, 'dist', '.test-serve-'));
    await buildSite(out);
    server = createSiteServer({ staticDir: join(out, 'static'), store, log: () => {} });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('M4 exit criterion: the waitlist form captures an email end to end', async () => {
    // Read the form the way a browser would, from the served page…
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(html);
    assert.ok(form, 'the page has a form');
    const action = /action="([^"]+)"/.exec(form[1])?.[1] ?? '';
    const method = /method="([^"]+)"/.exec(form[1])?.[1] ?? '';
    const names = [...form[2].matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...names].sort(), ['action', 'email', 'interview', 'role', 'team_size', 'website']);
    const hidden = /<input type="hidden" name="action" value="([^"]+)">/.exec(form[2])?.[1];

    // …fill it in as the owner of a small dental practice would, and send it with no JS.
    const filled: Record<string, string> = {
      action: hidden ?? '',
      email: 'Owner@Acme-Dental.example',
      role: 'owner',
      team_size: '5-50',
      interview: 'yes',
      website: '',
    };
    const res = await fetch(new URL(action, base), {
      method: method.toUpperCase(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(filled),
    });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(escapeHtml(MESSAGES.joinedInterview)));

    const row = store.rows.get('owner@acme-dental.example');
    assert.ok(row, 'the email was captured');
    assert.equal(row.role, 'owner');
    assert.equal(row.teamSize, '5-50');
    assert.equal(row.interview, true);
    assert.deepEqual(store.interviewVolunteers().map((r) => r.email), ['owner@acme-dental.example']);
  });

  it('captures a sign-up sent by the page script as JSON', async () => {
    const res = await fetch(`${base}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ action: 'join', email: 'office@acme-dental.example', website: '' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: MESSAGES.joined });
    assert.ok(store.rows.has('office@acme-dental.example'));
  });

  it('serves the landing page at / with the security headers', async () => {
    const res = await fetch(`${base}/`);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html; charset=utf-8$/);
    for (const [name, value] of Object.entries(SITE_HEADERS)) assert.equal(res.headers.get(name), value, name);
    assert.equal(await res.text(), await readFile(join(ROOT, 'site', 'index.html'), 'utf8'));
  });

  it('serves each file with its type', async () => {
    const types: Record<string, RegExp> = {
      '/index.html': /^text\/html/,
      '/privacy.html': /^text\/html/,
      '/terms.html': /^text\/html/,
      '/styles.css': /^text\/css/,
      '/page.js': /^text\/javascript/,
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', type, path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    }
  });

  it('answers HEAD without a body', async () => {
    const res = await raw(base, '/', 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  });

  it('answers 404 for missing files, with the security headers', async () => {
    const res = await fetch(`${base}/nope.html`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('content-security-policy'), SITE_HEADERS['Content-Security-Policy']);
  });

  it('never serves a file from outside the site', async () => {
    for (const path of [
      '/../package.json',
      '/../../package.json',
      '/%2e%2e/package.json',
      '/%2e%2e%2fpackage.json',
      '/..%2f..%2fpackage.json',
      '/%2E%2E/%2E%2E/package.json',
      '/..\\package.json',
      '/index.html%00.css',
      '/%ff',
      '//etc/passwd',
    ]) {
      const res = await raw(base, path);
      assert.ok(res.status === 404 || res.status === 400, `${path} → ${res.status}`);
      assert.doesNotMatch(res.body, /"name": "grantgate"|root:/, path);
    }
  });

  it('refuses to write to pages', async () => {
    const res = await raw(base, '/index.html', 'POST');
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
  });

  it('mounts the checkout route', async () => {
    const res = await fetch(`${base}/api/checkout`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), CHECKOUT_FALLBACK);
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false, error: MESSAGES.notFound });
  });
});
