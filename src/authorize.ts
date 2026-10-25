// Recognises Google OAuth authorize requests and reads what the app is asking for.
//
// Pure and side-effect free so the M2 extension can call it on every navigation.
// Where a URL is ambiguous it errs toward "this is a grant request" and toward
// "we don't know which app this is", because the gate fails closed.

export interface AuthorizeRequest {
  /** The requesting app. null when the URL carries conflicting client_ids. */
  client_id: string | null;
  /** Every requested scope, as written, without repeats, in request order. */
  scopes: string[];
  /** Where Google sends the grant. null when missing or conflicting. */
  redirect_uri: string | null;
}

const GOOGLE_ACCOUNTS_HOST = 'accounts.google.com';

// The authorize endpoints. Later steps of the same flow (account chooser,
// identifier) live under these paths and carry the same query parameters.
const AUTHORIZE_PATHS = ['/o/oauth2/v2/auth', '/o/oauth2/auth'];

/** Parses a Google OAuth authorize URL; returns null for anything else. */
export function parseAuthorizeUrl(input: string | URL): AuthorizeRequest | null {
  if (typeof input !== 'string' && !(input instanceof URL)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!isGoogleAccounts(url) || !isAuthorizePath(url.pathname)) return null;

  const params = url.searchParams;
  const clientIds = distinct(params.getAll('client_id').map((v) => v.trim()));
  // Google refuses a request with no client_id, so there is no grant to gate.
  if (clientIds.length === 0) return null;
  const redirectUris = distinct(params.getAll('redirect_uri').map((v) => v.trim()));

  return {
    client_id: clientIds.length === 1 ? clientIds[0] : null,
    // Scopes from every copy of the parameter, so a second `scope=` can't hide one.
    scopes: distinct(params.getAll('scope').flatMap((v) => v.split(/[\s,]+/))),
    redirect_uri: redirectUris.length === 1 ? redirectUris[0] : null,
  };
}

function isGoogleAccounts(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  // url.port is '' for the scheme's default port; anything else is not Google's server.
  if (url.port !== '') return false;
  // A trailing dot is the same host to DNS and the browser.
  return url.hostname.replace(/\.$/, '') === GOOGLE_ACCOUNTS_HOST;
}

function isAuthorizePath(rawPath: string): boolean {
  const path = normalizePath(rawPath);
  return AUTHORIZE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

// Undo spellings a server may treat as the same path (%61 for "a", doubled
// slashes, upper case) so they can't be used to slip past the gate.
function normalizePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed escapes: compare the raw path.
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, '/');
}

function distinct(values: string[]): string[] {
  return [...new Set(values.filter((v) => v !== ''))];
}
