// Builds the landing page for Vercel as a Build Output API v3 directory
// (.vercel/output by default, or the directory given), which Vercel deploys as-is:
//
//   config.json                         v3: SITE_HEADERS on every response, then the clean
//                                       page URLs (/privacy, /terms) from site-pages.ts
//   static/*.html                       site/'s pages, with their search and sharing tags and
//                                       the Buy button filled in (scripts/site-pages.ts)
//   static/styles.css                   copied from site/
//   static/robots.txt, sitemap.xml      from site-pages.ts
//   static/og.png                       the 1200×630 share image, drawn by share-image.ts
//   static/page.js                      src/site/page.ts, types stripped
//   functions/api/<route>.func/         one Node 22 function per API route:
//     .vc-config.json, package.json     runtime and ESM
//     index.mjs                         the entry: productionHandler(process.env)
//     site/api.js, site/waitlist.js     src/site, types stripped
//     node_modules/@neondatabase/serverless   the Postgres driver's ESM build, vendored (no dependencies of its own)
//
// No bundler and no framework: the same type stripping as the extension build.
//
// Read from the environment at build time (Vercel passes its env to the build):
//   STRIPE_PAYMENT_LINK            the Buy button's target; no button without it
//   VERCEL_ENV                     baked into each page; page.js counts visits only in "production"
//   VERCEL_PROJECT_PRODUCTION_URL  the domain for canonical URLs, the sitemap and the share image

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteImports } from './build.ts';
import { shareImagePng } from './share-image.ts';
import { PUBLIC_PAGES, SHARE_IMAGE, buildConfig, pageRoutes, renderPage, robotsTxt, sitemapXml } from './site-pages.ts';
import { SITE_HEADERS } from '../src/site/api.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Env = Readonly<Record<string, string | undefined>>;

/** Everything in site/: the pages (rendered) and the stylesheet (copied). */
export const SITE_STATIC_FILES: readonly string[] = Object.freeze(['index.html', 'privacy.html', 'terms.html', 'styles.css']);
/** Static files the build makes itself. */
export const GENERATED_FILES: readonly string[] = Object.freeze(['page.js', 'robots.txt', 'sitemap.xml', SHARE_IMAGE.file]);
/** One function per API route; each serves the whole API, so they are identical. */
export const FUNCTION_ROUTES: readonly string[] = Object.freeze(['api/waitlist', 'api/checkout']);
export const NODE_RUNTIME = 'nodejs22.x';

const SERVER_MODULES = ['api.ts', 'waitlist.ts'];
const DRIVER = join('node_modules', '@neondatabase', 'serverless');
/** What the function needs of the driver at run time (it is imported, never required), plus its licence. */
export const DRIVER_FILES: readonly string[] = Object.freeze(['LICENSE', 'index.mjs', 'package.json']);

const ENTRY = `// Vercel entry: the grantgate API, configured from the environment.
import { productionHandler } from './site/api.js';

export default productionHandler(process.env);
// For tests: the same handler with a given environment.
export { productionHandler as create };
`;

/** Writes the deploy to `outDir`, replacing whatever was there. Returns the entries written. */
export async function buildSite(outDir = join(ROOT, '.vercel', 'output'), env: Env = process.env): Promise<string[]> {
  const config = buildConfig(env);
  if (config.paymentLink === null && (env.STRIPE_PAYMENT_LINK ?? '').trim() !== '') {
    // The name only: the value never reaches a log.
    console.warn('grantgate build: STRIPE_PAYMENT_LINK is not an https URL, so the Buy button is left out');
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const emit = async (file: string, contents: string | Buffer) => {
    await mkdir(dirname(join(outDir, file)), { recursive: true });
    await writeFile(join(outDir, file), contents);
    written.push(file);
  };
  const compile = async (file: string) => rewriteImports(stripTypeScriptTypes(await readFile(join(ROOT, 'src', 'site', file), 'utf8')));
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  await emit('config.json', json({ version: 3, routes: [{ src: '/(.*)', headers: { ...SITE_HEADERS }, continue: true }, ...pageRoutes()] }));
  for (const file of SITE_STATIC_FILES) {
    const source = await readFile(join(ROOT, 'site', file), 'utf8');
    const page = PUBLIC_PAGES.find((p) => p.file === file);
    await emit(join('static', file), page ? renderPage(source, page, config) : source);
  }
  await emit(join('static', 'page.js'), await compile('page.ts'));
  await emit(join('static', 'robots.txt'), robotsTxt(config.origin));
  await emit(join('static', 'sitemap.xml'), sitemapXml(config.origin));
  await emit(join('static', SHARE_IMAGE.file), shareImagePng());

  for (const route of FUNCTION_ROUTES) {
    const fn = join('functions', `${route}.func`);
    await emit(join(fn, '.vc-config.json'), json({ runtime: NODE_RUNTIME, handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false }));
    await emit(join(fn, 'package.json'), json({ type: 'module', private: true }));
    await emit(join(fn, 'index.mjs'), ENTRY);
    for (const file of SERVER_MODULES) await emit(join(fn, 'site', file.replace(/\.ts$/, '.js')), await compile(file));
    for (const file of DRIVER_FILES) {
      await cp(join(ROOT, DRIVER, file), join(outDir, fn, DRIVER, file));
      written.push(join(fn, DRIVER, file));
    }
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, '.vercel', 'output');
  const files = await buildSite(out);
  console.log(`grantgate: wrote ${files.length} entries to ${relative(process.cwd(), out) || '.'}`);
}
