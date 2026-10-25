// Runs the landing page locally: npm run site [-- --port 4321]
//
// Builds the site (into dist/site), then serves its static files with the same
// headers as Vercel and mounts the same API handler at /api/. The waitlist is
// kept in memory, so local sign-ups are sample data and vanish on exit.

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from './build-site.ts';
import { SITE_HEADERS, handleApi, nodeHandler, type ApiDeps } from '../src/site/api.ts';
import { memoryStore } from '../src/site/waitlist.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 4321;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

export interface SiteServerOptions extends ApiDeps {
  /** The built static files (static/ in the build output). */
  staticDir: string;
}

export function createSiteServer(options: SiteServerOptions): Server {
  const root = resolve(options.staticDir);
  const api = nodeHandler((request) => handleApi(request, options));
  return createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) void api(req, res);
    else void serveStatic(root, pathname, req, res);
  });
}

async function serveStatic(root: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(SITE_HEADERS)) res.setHeader(name, value);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed\n');
    return;
  }
  const file = staticFile(root, pathname);
  if (file !== null) {
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    } catch {
      // Missing, or a directory: a 404 below.
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
}

/** The file under `root` that a URL path names, or null for anything that tries to leave it. */
export function staticFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  const full = resolve(root, relative);
  return full.startsWith(root + sep) ? full : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--port');
  const port = Number(flag > 0 ? process.argv[flag + 1] : (process.env.PORT ?? DEFAULT_PORT));
  const out = join(ROOT, 'dist', 'site');
  await buildSite(out);
  const server = createSiteServer({ staticDir: join(out, 'static'), store: memoryStore() });
  server.listen(port, '127.0.0.1', () => {
    console.log(`grantgate site: http://localhost:${port}/ (waitlist kept in memory; sign-ups vanish when this stops)`);
  });
}
