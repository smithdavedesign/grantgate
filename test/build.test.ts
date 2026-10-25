import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildExtension } from '../scripts/build.ts';
import { INTERSTITIAL_PATH, OPTIONS_PATH } from '../src/extension/background.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROADMAP_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20openid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code';

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)));
}

describe('npm run build: the unpacked extension', () => {
  let out = '';
  let manifest: Record<string, any> = {};

  before(async () => {
    // Inside the repo (dist/ is git-ignored), never in a system temp directory.
    await mkdir(join(ROOT, 'dist'), { recursive: true });
    out = await mkdtemp(join(ROOT, 'dist', '.test-build-'));
    await buildExtension(out);
    manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  });

  after(async () => {
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('writes an MV3 manifest whose version matches package.json', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.name, 'grantgate');
  });

  it('asks for the minimum permissions: DNR, storage and accounts.google.com only', () => {
    assert.deepEqual(manifest.permissions, ['declarativeNetRequest', 'storage']);
    assert.deepEqual(manifest.host_permissions, ['https://accounts.google.com/*', 'http://accounts.google.com/*']);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.externally_connectable, undefined);
  });

  it('forbids framing extension pages and loading outside scripts', () => {
    const csp: string = manifest.content_security_policy?.extension_pages ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
  });

  it('includes every file the manifest names, and exposes only the interstitial to the web', () => {
    assert.equal(manifest.background.type, 'module');
    assert.ok(existsSync(join(out, manifest.background.service_worker)), manifest.background.service_worker);
    assert.deepEqual(manifest.web_accessible_resources, [{ resources: [INTERSTITIAL_PATH], matches: ['<all_urls>'] }]);
    assert.ok(existsSync(join(out, INTERSTITIAL_PATH)));
  });

  it('loads the page script as a module from the extension, with no inline script', async () => {
    const html = await readFile(join(out, INTERSTITIAL_PATH), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    const [, attrs, body] = scripts[0];
    assert.match(attrs, /type="module"/);
    assert.equal(body.trim(), '');
    const src = /src="([^"]+)"/.exec(attrs)?.[1] ?? '';
    assert.ok(existsSync(join(out, src)), src);
    assert.match(html, /id="app"/);
  });

  it('emits JavaScript whose relative imports all resolve to emitted .js files', async () => {
    const js = (await filesUnder(out)).filter((f) => f.endsWith('.js'));
    assert.ok(js.length >= 5, js.join(', '));
    assert.equal((await filesUnder(out)).filter((f) => f.endsWith('.ts')).length, 0);
    for (const file of js) {
      const code = await readFile(join(out, file), 'utf8');
      for (const [, spec] of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        assert.ok(spec.endsWith('.js'), `${file} imports ${spec}`);
        assert.ok(existsSync(resolve(dirname(join(out, file)), spec)), `${file} imports missing ${spec}`);
      }
    }
  });

  it('produces a policy module that runs and blocks the roadmap URL', async () => {
    const policy = await import(pathToFileURL(join(out, 'js', 'policy.js')).href);
    assert.equal(policy.decide(ROADMAP_URL, { allow: [], deny: [] }), 'block');
    assert.equal(policy.decide(ROADMAP_URL, { allow: ['abc.apps.googleusercontent.com'], deny: [] }), 'allow');
  });

  it('produces a worker and a page script that load without a browser', async () => {
    const worker = await import(pathToFileURL(join(out, manifest.background.service_worker)).href);
    assert.equal(typeof worker.createGate, 'function');
    const pageScript = await import(pathToFileURL(join(out, 'js', 'extension', 'interstitial.js')).href);
    assert.equal(typeof pageScript.runInterstitial, 'function');
  });

  // M3
  it('adds an options page that opens in its own tab and is not exposed to the web', () => {
    assert.deepEqual(manifest.options_ui, { page: OPTIONS_PATH, open_in_tab: true });
    assert.ok(existsSync(join(out, OPTIONS_PATH)));
    const exposed = manifest.web_accessible_resources.flatMap((r: { resources: string[] }) => r.resources);
    assert.ok(!exposed.includes(OPTIONS_PATH));
  });

  it('loads the options script as a module from the extension, with no inline script', async () => {
    const html = await readFile(join(out, OPTIONS_PATH), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    const [, attrs, body] = scripts[0];
    assert.match(attrs, /type="module"/);
    assert.equal(body.trim(), '');
    const src = /src="([^"]+)"/.exec(attrs)?.[1] ?? '';
    assert.equal(src, 'js/extension/options.js');
    assert.ok(existsSync(join(out, src)), src);
    assert.match(html, /id="app"/);
  });

  it('keeps the pages from importing the worker, which would start a second gate in the page', async () => {
    for (const page of ['options.js', 'interstitial.js']) {
      const code = await readFile(join(out, 'js', 'extension', page), 'utf8');
      assert.doesNotMatch(code, /(?:from|import)\s*\(?\s*['"][^'"]*background\.js['"]/, page);
    }
  });

  // M4
  it("leaves the landing page's browser and server code out of the extension", async () => {
    const files = await filesUnder(out);
    assert.deepEqual(files.filter((f) => f.split(/[\\/]/).includes('site')), []);
    assert.ok(!existsSync(join(out, 'js', 'site')));
  });

  it('produces ledger and options modules that load without a browser', async () => {
    const ledger = await import(pathToFileURL(join(out, 'js', 'ledger.js')).href);
    assert.equal(typeof ledger.createLedgerKey, 'function');
    assert.equal(typeof ledger.ledgerCsv, 'function');
    const options = await import(pathToFileURL(join(out, 'js', 'extension', 'options.js')).href);
    assert.equal(typeof options.runOptions, 'function');
  });
});
