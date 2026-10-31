// The landing page's API, as fetch-style Request → Response:
//
//   POST /api/waitlist   join or leave the waitlist (JSON from page.js, or a plain form post)
//   GET  /api/checkout   303 to the Stripe Payment Link (STRIPE_PAYMENT_LINK), or to the waitlist
//
// nodeHandler() serves it to Node's (req, res), which is what both the Vercel
// function (scripts/build-site.ts) and the local server (scripts/serve-site.ts) run.
// Logs never contain a sign-up's address or a connection string: see redact().

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseWaitlistForm, sqlStore, type SqlClient, type WaitlistStore } from './waitlist.ts';

export const API_ROUTES: readonly string[] = Object.freeze(['/api/waitlist', '/api/checkout']);

/** A sign-up is a few hundred bytes; anything much bigger isn't one. */
export const MAX_BODY_BYTES = 4096;

/** Where /api/checkout goes while no payment link is configured. */
export const CHECKOUT_FALLBACK = '/?checkout=soon#join';

/**
 * Sent with every page: the site's own scripts and styles only, never framed. Pages may
 * also reach RepoHQ's signal endpoint (SIGNAL_URL in page.ts), which counts visits.
 */
export const SITE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://idea-factory.1426davejobs.workers.dev; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
});

export const MESSAGES = Object.freeze({
  joined: "You're on the list. We'll email you when grantgate is ready.",
  joinedInterview: "You're on the list. Thanks for offering a call: we'll email you to find 15 minutes that suit you.",
  left: 'Done. If that address was on the waitlist, it has been removed.',
  invalidEmail: "That email address doesn't look right. Please check it and try again.",
  unreadable: "grantgate couldn't read that request.",
  unavailable: "The waitlist isn't taking sign-ups right now. Please try again in a few minutes.",
  notAllowed: "That method isn't allowed here.",
  notFound: 'Not found.',
});

export interface ApiDeps {
  /** null when DATABASE_URL isn't set: sign-ups are refused, never silently dropped. */
  store: WaitlistStore | null;
  /** The checkout page (a Stripe Payment Link), from STRIPE_PAYMENT_LINK. */
  checkoutUrl?: string;
  /** Defaults to console.error. Only ever given redacted text. */
  log?: (message: string) => void;
}

type Env = Readonly<Record<string, string | undefined>>;

const JSON_TYPE = 'application/json';
const FORM_TYPE = 'application/x-www-form-urlencoded';
// Methods the fetch Request constructor refuses outright.
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const log = deps.log ?? ((message: string) => console.error(message));
  const { pathname } = new URL(request.url);
  if (pathname === '/api/waitlist') return waitlist(request, deps.store, log);
  if (pathname === '/api/checkout') return checkout(request, deps.checkoutUrl, log);
  return json(404, { ok: false, error: MESSAGES.notFound });
}

async function waitlist(request: Request, store: WaitlistStore | null, log: (message: string) => void): Promise<Response> {
  if (request.method !== 'POST') return json(405, { ok: false, error: MESSAGES.notAllowed }, { Allow: 'POST' });
  const type = mediaType(request.headers.get('content-type'));
  if (type !== JSON_TYPE && type !== FORM_TYPE) return json(415, { ok: false, error: MESSAGES.unreadable });
  // A plain form post (no JS) gets a page back; the page script gets JSON.
  const reply = (status: number, ok: boolean, message: string) =>
    type === FORM_TYPE ? html(status, message) : json(status, ok ? { ok, message } : { ok, error: message });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return reply(413, false, MESSAGES.unreadable);
  const fields = type === FORM_TYPE ? formFields(bytes) : jsonFields(bytes);
  if (fields === null) return reply(400, false, MESSAGES.unreadable);

  const parsed = parseWaitlistForm(fields);
  if (!parsed.ok) return reply(400, false, parsed.error === 'invalid-email' ? MESSAGES.invalidEmail : MESSAGES.unreadable);
  const done = parsed.action === 'leave' ? MESSAGES.left : parsed.signup.interview ? MESSAGES.joinedInterview : MESSAGES.joined;
  // Bots are told it worked (and never learn the field gave them away), but get the plain message.
  if (parsed.bot) return reply(200, true, parsed.action === 'leave' ? MESSAGES.left : MESSAGES.joined);

  if (store === null) {
    log('grantgate waitlist: DATABASE_URL is not set, so sign-ups cannot be saved');
    return reply(503, false, MESSAGES.unavailable);
  }
  try {
    if (parsed.action === 'leave') await store.leave(parsed.email);
    else await store.join(parsed.signup);
  } catch (error) {
    log(`grantgate waitlist: the database failed: ${redact(describeError(error))}`);
    return reply(503, false, MESSAGES.unavailable);
  }
  return reply(200, true, done);
}

function checkout(request: Request, configured: string | undefined, log: (message: string) => void): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { ok: false, error: MESSAGES.notAllowed }, { Allow: 'GET, HEAD' });
  }
  // The target only ever comes from the environment, never from the request.
  const target = checkoutTarget(configured);
  if (target === null && configured !== undefined && configured.trim() !== '') {
    log('grantgate checkout: STRIPE_PAYMENT_LINK is not an https URL, so checkout goes to the waitlist');
  }
  return new Response(null, { status: 303, headers: { Location: target ?? CHECKOUT_FALLBACK, 'Cache-Control': 'no-store' } });
}

/** The configured checkout URL when it is https with no credentials in it; otherwise null. */
export function checkoutTarget(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Replaces URLs (connection strings included) and email addresses before anything is logged. */
export function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[url]')
    .replace(/[^\s@()<>"',;:[\]]+@[^\s@()<>"',;:[\]]+/g, '[email]');
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });
}

/** The reply to a form post without JS. Fixed text only: nothing from the request is echoed. */
function html(status: number, message: string): Response {
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grantgate</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="notice">
<h1>grantgate</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to grantgate</a></p>
</main>
</body>
</html>
`;
  return new Response(page, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SITE_HEADERS },
  });
}

function mediaType(header: string | null): string {
  return (header ?? '').split(';')[0].trim().toLowerCase();
}

function formFields(bytes: Uint8Array): Record<string, unknown> {
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(bytes)));
}

function jsonFields(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// Node adapter

/** Serves a Request → Response handler to Node's http (req, res), capping the body. */
export function nodeHandler(handle: (request: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (FORBIDDEN_METHODS.has(method)) return await send(res, json(405, { ok: false, error: MESSAGES.notAllowed }));
      // A fixed origin: the Host header is the client's to choose, so it is never used.
      const path = req.url?.startsWith('/') ? req.url : '/';
      const url = new URL(`http://localhost${path}`);
      const headers = new Headers();
      for (const name of ['content-type', 'accept']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const tooLarge = () => send(res, json(413, { ok: false, error: MESSAGES.unreadable }));
        if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return await tooLarge();
        const read = await readBody(req, MAX_BODY_BYTES);
        if (read === 'too-large') return await tooLarge();
        // The client hung up mid-upload: there's nobody to answer, and half a body is never used.
        if (read === 'aborted') return void res.destroy();
        body = read;
      }
      await send(res, await handle(new Request(url, { method, headers, body })));
    } catch (error) {
      console.error(`grantgate api: ${redact(describeError(error))}`);
      if (res.headersSent) res.end();
      else await send(res, json(500, { ok: false, error: MESSAGES.unavailable }));
    }
  };
}

// Past this much, stop draining an oversized body and drop the connection.
const DRAIN_LIMIT_BYTES = MAX_BODY_BYTES * 64;

/**
 * The whole body; 'too-large' once it passes `limit` (the rest is drained, up to a
 * point, so the 413 arrives); or 'aborted' when the client hangs up before the end.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer> | 'too-large' | 'aborted'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else if (size > DRAIN_LIMIT_BYTES) req.destroy();
    });
    const outcome = (complete: boolean) => (size > limit ? 'too-large' : complete ? new Uint8Array(Buffer.concat(chunks)) : 'aborted');
    // Whichever comes first settles it; a body that didn't reach its end is never used.
    req.on('end', () => resolve(outcome(true)));
    req.on('close', () => resolve(outcome(req.complete)));
    req.on('error', () => resolve(outcome(false)));
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(body);
}

// ---------------------------------------------------------------------------
// Production wiring

/** The Neon store when DATABASE_URL is set. The driver is loaded on the first query. */
export function storeFromEnv(env: Env): WaitlistStore | null {
  const url = env.DATABASE_URL;
  if (!url) return null;
  let client: Promise<SqlClient> | null = null;
  return sqlStore({
    async query(text, params) {
      client ??= import('@neondatabase/serverless').then(({ neon }) => neon(url));
      return (await client).query(text, params);
    },
  });
}

/** What the Vercel function runs: the API with its store and checkout from the environment. */
export function productionHandler(env: Env) {
  const deps: ApiDeps = { store: storeFromEnv(env), checkoutUrl: env.STRIPE_PAYMENT_LINK };
  return nodeHandler((request) => handleApi(request, deps));
}
