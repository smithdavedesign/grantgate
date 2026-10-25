// npm run screenshots: proof that grantgate works, as PNGs in docs/screenshots/.
//
// Starts the local site (scripts/serve-site.ts, in-memory waitlist), waits until it
// answers, drives it with Playwright and stops it again. The extension's real
// interstitial page is shown from the built extension, with a stand-in for the
// chrome.runtime messaging that answers with the real assess() from policy.js.
//
// Chromium comes from CHROMIUM_PATH; this script never downloads a browser.
// Sample data only: an invented app, an invented business, a .example address.
// Not part of `npm test`.

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { buildExtension } from './build.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const EXTENSION_BUILD = join(ROOT, 'dist', 'screenshot-extension');
const PORT = 4387;
const SITE = `http://127.0.0.1:${PORT}`;
// Never resolved: Playwright answers every request to it from the built extension.
const EXTENSION_ORIGIN = 'https://extension.grantgate.test';
const START_TIMEOUT_MS = 30_000;

const SAMPLE_GRANT =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: '204918377465-pdfmagic.apps.googleusercontent.com',
    scope: 'openid email https://mail.google.com/ https://www.googleapis.com/auth/drive',
    redirect_uri: 'https://pdf-magic.example/oauth/callback',
    response_type: 'code',
    access_type: 'offline',
  });
const SAMPLE_SIGNUP = { email: 'owner@acme-dental.example', role: 'owner', teamSize: '5-50' };

const SIZES = [
  ['desktop', { viewport: { width: 1280, height: 800 } }],
  ['mobile', devices['iPhone 13']],
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

async function main() {
  const executablePath = process.env.CHROMIUM_PATH;
  if (!executablePath) throw new Error('Set CHROMIUM_PATH to a Chromium binary: this script never downloads a browser.');
  await mkdir(OUT, { recursive: true });
  await buildExtension(EXTENSION_BUILD);

  const site = startSite();
  try {
    await waitForSite(site);
    const browser = await chromium.launch({ executablePath });
    try {
      for (const [size, options] of SIZES) {
        const context = await browser.newContext(options);
        await serveExtension(context);
        const page = await context.newPage();
        await home(page, size);
        await gate(page, size);
        await joined(page, size);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    site.kill('SIGTERM');
  }
}

function startSite() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'serve-site.ts'), '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.exited = new Promise((resolve) => child.once('exit', resolve));
  return child;
}

async function waitForSite(child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let exited = false;
  child.exited.then(() => (exited = true));
  while (Date.now() < deadline) {
    if (exited) throw new Error('the site server stopped before answering');
    try {
      if ((await fetch(`${SITE}/`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the site did not answer on ${SITE} within ${START_TIMEOUT_MS / 1000}s`);
}

async function serveExtension(context) {
  await context.route(`${EXTENSION_ORIGIN}/**`, async (route) => {
    const file = resolve(EXTENSION_BUILD, `.${new URL(route.request().url()).pathname}`);
    if (!file.startsWith(EXTENSION_BUILD + sep)) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: await readFile(file) });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  // Stands in for the service worker: answers the page's "check" with the real policy code.
  await context.addInitScript((origin) => {
    if (location.origin !== origin) return;
    globalThis.chrome = {
      runtime: {
        id: 'screenshots',
        async sendMessage(message) {
          const policy = await import('/js/policy.js');
          const assessment = policy.assess(message.url, { allow: [], deny: [] });
          return { ok: true, action: 'ask', assessment, choices: policy.choicesFor(assessment) };
        },
      },
    };
  }, EXTENSION_ORIGIN);
}

async function shoot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  console.log(`saved docs/screenshots/${name}.png`);
}

/** The landing page as a visitor first sees it. */
async function home(page, size) {
  await page.goto(`${SITE}/`, { waitUntil: 'networkidle' });
  await shoot(page, `home-${size}`);
}

/** The extension stopping a "PDF tool" that asks for all of Gmail and Drive. */
async function gate(page, size) {
  await page.goto(`${EXTENSION_ORIGIN}/interstitial.html#${SAMPLE_GRANT}`);
  await page.locator('button[data-choice="back"]:not([disabled])').waitFor();
  await shoot(page, `gate-${size}`);
}

/** Joining the waitlist (and offering a call), through the real form and API. */
async function joined(page, size) {
  await page.goto(`${SITE}/#join`, { waitUntil: 'networkidle' });
  await page.fill('#join-email', SAMPLE_SIGNUP.email);
  await page.selectOption('#join-role', SAMPLE_SIGNUP.role);
  await page.selectOption('#join-team', SAMPLE_SIGNUP.teamSize);
  await page.check('#join-interview');
  await page.click('form[data-waitlist] button[type="submit"]');
  await page.locator('#join-status.success').waitFor();
  await page.locator('#join').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shoot(page, `waitlist-joined-${size}`);
}

await main();
