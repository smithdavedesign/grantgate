import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DRIVER_FILES, FUNCTION_ROUTES, NODE_RUNTIME, SITE_STATIC_FILES, buildSite } from '../scripts/build-site.ts';
import { API_ROUTES, CHECKOUT_FALLBACK, MESSAGES, SITE_HEADERS } from '../src/site/api.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_DATABASE_URL = ['postgres', '://', 'grantgate', ':', 'Qw7'.repeat(6), '@', 'ep-demo.example', '/neondb'].join('');

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)));
}

async function serve(handle: (req: any, res: any) => Promise<void>) {
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('npm run build:site: the Vercel deploy (Build Output API v3)', () => {
  let out = '';
  const fn = (route: string, ...path: string[]) => join(out, 'functions', `${route}.func`, ...path);

  before(async () => {
    // Inside the repo (dist/ is git-ignored), never in a system temp directory.
    await mkdir(join(ROOT, 'dist'), { recursive: true });
    out = await mkdtemp(join(ROOT, 'dist', '.test-site-'));
    await buildSite(out);
  });

  after(async () => {
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('is what Vercel builds: vercel.json runs build:site with no framework', async () => {
    const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(vercel.framework, null);
    assert.equal(vercel.buildCommand, 'npm run build:site');
    assert.equal(vercel.installCommand, 'npm ci');
    assert.match(pkg.scripts['build:site'], /scripts\/build-site\.ts$/);
    assert.ok(pkg.dependencies['@neondatabase/serverless'], 'the driver is a runtime dependency, so npm ci installs it');
  });

  it('writes a v3 config that puts the security headers on every response', async () => {
    const config = JSON.parse(await readFile(join(out, 'config.json'), 'utf8'));
    assert.equal(config.version, 3);
    assert.deepEqual(config.routes, [{ src: '/(.*)', headers: { ...SITE_HEADERS }, continue: true }]);
  });

  it('copies every page and the stylesheet unchanged', async () => {
    assert.deepEqual([...SITE_STATIC_FILES].sort(), ['index.html', 'privacy.html', 'styles.css', 'terms.html']);
    // A file added to site/ but not to SITE_STATIC_FILES would pass the link checks and 404 on Vercel.
    assert.deepEqual((await readdir(join(ROOT, 'site'))).sort(), [...SITE_STATIC_FILES].sort());
    for (const file of SITE_STATIC_FILES) {
      assert.equal(await readFile(join(out, 'static', file), 'utf8'), await readFile(join(ROOT, 'site', file), 'utf8'), file);
    }
  });

  it('emits page.js from src/site/page.ts, loadable as a module', async () => {
    const page = await import(pathToFileURL(join(out, 'static', 'page.js')).href);
    assert.equal(typeof page.enhanceForm, 'function');
    assert.equal(typeof page.showCheckoutNotice, 'function');
  });

  it('ships only the pages, the stylesheet and the page script as static files', async () => {
    assert.deepEqual((await filesUnder(join(out, 'static'))).sort(), [...SITE_STATIC_FILES, 'page.js'].sort());
  });

  it('makes one Node 22 function per API route', async () => {
    assert.deepEqual(FUNCTION_ROUTES.map((r) => `/${r}`), [...API_ROUTES]);
    assert.equal(NODE_RUNTIME, 'nodejs22.x');
    for (const route of FUNCTION_ROUTES) {
      assert.deepEqual(JSON.parse(await readFile(fn(route, '.vc-config.json'), 'utf8')), {
        runtime: NODE_RUNTIME,
        handler: 'index.mjs',
        launcherType: 'Nodejs',
        shouldAddHelpers: false,
      });
      assert.deepEqual(JSON.parse(await readFile(fn(route, 'package.json'), 'utf8')), { type: 'module', private: true });
    }
  });

  it('puts only the server code and the vendored driver in each function', async () => {
    for (const route of FUNCTION_ROUTES) {
      const files = await filesUnder(fn(route));
      const own = files.filter((f) => !f.startsWith(join('node_modules', '@neondatabase', 'serverless') + '/')).sort();
      assert.deepEqual(own, ['.vc-config.json', 'index.mjs', 'package.json', join('site', 'api.js'), join('site', 'waitlist.js')].sort(), route);
      const vendored = JSON.parse(await readFile(fn(route, 'node_modules', '@neondatabase', 'serverless', 'package.json'), 'utf8'));
      const installed = JSON.parse(await readFile(join(ROOT, 'node_modules', '@neondatabase', 'serverless', 'package.json'), 'utf8'));
      assert.equal(vendored.version, installed.version);
      assert.equal(vendored.dependencies, undefined, 'the driver needs nothing else at run time');
      assert.deepEqual((await filesUnder(fn(route, 'node_modules'))).sort(), DRIVER_FILES.map((f) => join('@neondatabase', 'serverless', f)).sort());
    }
  });

  it('emits JavaScript whose relative imports all resolve to emitted .js files', async () => {
    const all = await filesUnder(out);
    assert.equal(all.filter((f) => f.endsWith('.ts')).length, 0);
    const ours = all.filter((f) => /\.m?js$/.test(f) && !f.includes('node_modules'));
    assert.ok(ours.length >= 7, ours.join(', '));
    for (const file of ours) {
      const code = await readFile(join(out, file), 'utf8');
      for (const [, spec] of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        assert.ok(spec.endsWith('.js'), `${file} imports ${spec}`);
        assert.ok(existsSync(resolve(dirname(join(out, file)), spec)), `${file} imports missing ${spec}`);
      }
    }
  });

  it('M4 exit criterion (shipped code): the emitted function captures an email', async () => {
    const api = await import(pathToFileURL(fn('api/waitlist', 'site', 'api.js')).href);
    const waitlist = await import(pathToFileURL(fn('api/waitlist', 'site', 'waitlist.js')).href);
    const store = waitlist.memoryStore();
    const server = await serve(api.nodeHandler((request: Request) => api.handleApi(request, { store, log: () => {} })));
    try {
      const res = await fetch(`${server.url}/api/waitlist`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'join', email: 'owner@acme-dental.example', role: 'owner', team_size: '5-50', interview: 'yes', website: '' }),
      });
      assert.equal(res.status, 200);
      assert.ok(store.rows.has('owner@acme-dental.example'));
      assert.equal(store.rows.get('owner@acme-dental.example').interview, true);
    } finally {
      await server.close();
    }
  });

  it('emits an entry point that answers 503 without a database and sends pre-orders to CHECKOUT_URL', async () => {
    for (const route of FUNCTION_ROUTES) {
      const entry = await import(pathToFileURL(fn(route, 'index.mjs')).href);
      assert.equal(typeof entry.default, 'function', route);
      assert.equal(typeof entry.create, 'function', route);
    }
    const entry = await import(pathToFileURL(fn('api/waitlist', 'index.mjs')).href);
    const original = console.error;
    console.error = () => {};
    const bare = await serve(entry.create({}));
    const paid = await serve(entry.create({ CHECKOUT_URL: 'https://pay.example/founding-plan' }));
    try {
      const res = await fetch(`${bare.url}/api/waitlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@acme.example"}' });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, error: MESSAGES.unavailable });
      assert.equal((await fetch(`${bare.url}/api/checkout`, { redirect: 'manual' })).headers.get('location'), CHECKOUT_FALLBACK);
      assert.equal((await fetch(`${paid.url}/api/checkout`, { redirect: 'manual' })).headers.get('location'), 'https://pay.example/founding-plan');
    } finally {
      console.error = original;
      await bare.close();
      await paid.close();
    }
  });

  it("loads the vendored Neon driver from inside the function when DATABASE_URL is set", async () => {
    const api = await import(pathToFileURL(fn('api/waitlist', 'site', 'api.js')).href);
    const store = api.storeFromEnv({ DATABASE_URL: FAKE_DATABASE_URL });
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(input instanceof Request ? input.url : String(input));
      throw new TypeError('offline in tests');
    }) as typeof fetch;
    try {
      await assert.rejects(store.join({ email: 'a@acme.example', role: null, teamSize: null, interview: false }));
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(seen.length >= 1, 'the driver tried to send the query');
    // Neon's driver sends queries to the database domain's "api." host over https.
    const target = new URL(seen[0]);
    assert.equal(target.protocol, 'https:');
    assert.match(target.hostname, /(^|\.)example$/);
    assert.ok(!seen[0].includes('Qw7'), 'the password is not in the URL');
  });
});
