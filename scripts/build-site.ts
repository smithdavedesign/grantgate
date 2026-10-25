// Builds the landing page for Vercel as a Build Output API v3 directory
// (.vercel/output by default, or the directory given), which Vercel deploys as-is:
//
//   config.json                         v3, with SITE_HEADERS on every response
//   static/*.html, styles.css           copied from site/
//   static/page.js                      src/site/page.ts, types stripped
//   functions/api/<route>.func/         one Node 22 function per API route:
//     .vc-config.json, package.json     runtime and ESM
//     index.mjs                         the entry: productionHandler(process.env)
//     site/api.js, site/waitlist.js     src/site, types stripped
//     node_modules/@neondatabase/serverless   the Postgres driver's ESM build, vendored (no dependencies of its own)
//
// No bundler and no framework: the same type stripping as the extension build.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteImports } from './build.ts';
import { SITE_HEADERS } from '../src/site/api.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SITE_STATIC_FILES: readonly string[] = Object.freeze(['index.html', 'privacy.html', 'terms.html', 'styles.css']);
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
export async function buildSite(outDir = join(ROOT, '.vercel', 'output')): Promise<string[]> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const emit = async (file: string, contents: string) => {
    await mkdir(dirname(join(outDir, file)), { recursive: true });
    await writeFile(join(outDir, file), contents);
    written.push(file);
  };
  const compile = async (file: string) => rewriteImports(stripTypeScriptTypes(await readFile(join(ROOT, 'src', 'site', file), 'utf8')));
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  await emit('config.json', json({ version: 3, routes: [{ src: '/(.*)', headers: { ...SITE_HEADERS }, continue: true }] }));
  for (const file of SITE_STATIC_FILES) await emit(join('static', file), await readFile(join(ROOT, 'site', file), 'utf8'));
  await emit(join('static', 'page.js'), await compile('page.ts'));

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
