// Builds the unpacked Chrome extension into dist/extension (or the directory given).
//
//   extension/manifest.json   -> manifest.json, with "version" from package.json
//   extension/*.html          -> *.html (the interstitial and the options page)
//   src/**/*.ts               -> js/**/*.js   (types stripped by Node, ".ts" imports -> ".js")
//                                except src/site/, the landing page's code (scripts/build-site.ts)
//
// No bundler: the service worker and the page load native ES modules, and the
// file layout under js/ mirrors src/ so relative imports keep working.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_FILES = ['interstitial.html', 'options.html'];

/** Writes the extension to `outDir`, replacing whatever was there. Returns the files written. */
export async function buildExtension(outDir = join(ROOT, 'dist', 'extension')): Promise<string[]> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const emit = async (file: string, contents: string) => {
    await mkdir(dirname(join(outDir, file)), { recursive: true });
    await writeFile(join(outDir, file), contents);
    written.push(file);
  };

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  await emit('manifest.json', `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`);
  for (const file of STATIC_FILES) await emit(file, await readFile(join(ROOT, 'extension', file), 'utf8'));

  const src = join(ROOT, 'src');
  for (const entry of await readdir(src, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    if (relative(src, path).split(sep)[0] === 'site') continue;
    const js = rewriteImports(stripTypeScriptTypes(await readFile(path, 'utf8')));
    await emit(join('js', relative(src, path)).replace(/\.ts$/, '.js'), js);
  }
  return written;
}

/** Points relative `.ts` import specifiers at the emitted `.js` files. */
export function rewriteImports(code: string): string {
  return code.replace(/(\b(?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"\n]+)\.ts\2/g, '$1$2$3.js$2');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const files = await buildExtension(out);
  console.log(`grantgate: wrote ${files.length} files to ${relative(process.cwd(), out ?? join(ROOT, 'dist', 'extension')) || '.'}`);
}
