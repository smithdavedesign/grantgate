// The website's script (served as /page.js on every page). The forms work without it, as
// plain posts; with it, a sign-up is sent as JSON and the reply is shown in place.
// Server text is only ever rendered with textContent.
//
// It also counts real use for RepoHQ (see the privacy page): "visit" once per browser
// session, "activate" the first time this browser joins the waitlist, "checkout" on each
// Buy click. Fire-and-forget, without cookies, and never from automated browsers, preview
// builds, or a browser with localStorage "repohq:notrack" set.

export const SENDING = 'Sending…';
export const NETWORK_ERROR = "grantgate couldn't be reached. Check your connection and try again.";
export const UNEXPECTED_REPLY = 'Something went wrong on our side. Please try again in a minute.';
export const CHECKOUT_SOON = "Checkout opens soon. Join the waitlist below and you'll hear first.";

/** The <meta name> the build writes VERCEL_ENV into (scripts/site-pages.ts). */
export const DEPLOYMENT_META = 'vercel-env';
export const SIGNAL_URL = 'https://repohq.vercel.app/api/ideas/signal';
export const SIGNAL_SLUG = 'grantgate';
/** Set (to anything) in the owner's browser so their own visits aren't counted. */
export const NOTRACK_KEY = 'repohq:notrack';
/** sessionStorage: this session's visit was counted. */
export const VISIT_KEY = 'grantgate:signal:visit';
/** localStorage: this browser's activation was counted. */
export const ACTIVATE_KEY = 'grantgate:signal:activate';
/** The waitlist's honeypot field (HONEYPOT_FIELD in waitlist.ts, which the browser doesn't load). */
export const HONEYPOT = 'website';

export type SignalKind = 'visit' | 'activate' | 'checkout';

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export interface SignalEnv {
  /** The deployment the page was built for (<meta name="vercel-env">); only "production" counts. */
  deployment: string | null;
  /** navigator.webdriver: true for automated browsers. */
  webdriver: boolean;
  /** document.referrer and location.origin. */
  referrer: string;
  origin: string;
  /** null when the browser won't give the page its storage. */
  session: KeyValueStore | null;
  local: KeyValueStore | null;
  fetch(url: string, init: RequestInit): Promise<unknown>;
}

export interface FormEnv {
  form: HTMLFormElement;
  /** The live region that shows progress and the reply. */
  status: HTMLElement;
  /** The form's fields as strings (unticked checkboxes are absent). */
  values(): Record<string, string>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Called with the values sent, once the server has accepted them. */
  onSuccess?(sent: Record<string, string>): void;
}

type Reply = { ok: true; message: string } | { ok: false; error: string };

/** Sends the form with fetch instead of a page load. */
export function enhanceForm(env: FormEnv): void {
  const { form, status } = env;
  let pending = false;
  const setButtons = (disabled: boolean) => {
    for (const button of form.querySelectorAll('button')) button.disabled = disabled;
  };
  const show = (text: string, kind: 'success' | 'error' | '') => {
    status.textContent = text;
    status.className = kind ? `form-status ${kind}` : 'form-status';
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    setButtons(true);
    show(SENDING, '');
    const sent = env.values();
    const reply = await send(env, sent);
    if (reply.ok) {
      form.hidden = true;
      show(reply.message, 'success');
      env.onSuccess?.(sent);
      return;
    }
    show(reply.error, 'error');
    setButtons(false);
    pending = false;
  });
}

async function send(env: FormEnv, values: Record<string, string>): Promise<Reply> {
  let response: Response;
  try {
    response = await env.fetch(env.form.getAttribute('action') ?? '/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(values),
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const { ok, message, error } = body as Record<string, unknown>;
      if (ok === true && typeof message === 'string') return { ok, message };
      if (ok === false && typeof error === 'string') return { ok, error };
    }
  } catch {
    // Not JSON: a proxy error page, say.
  }
  return { ok: false, error: UNEXPECTED_REPLY };
}

/** After /api/checkout while checkout isn't open, says so above the waitlist form. */
export function showCheckoutNotice(notice: HTMLElement | null, search: string): boolean {
  if (notice === null || new URLSearchParams(search).get('checkout') !== 'soon') return false;
  notice.textContent = CHECKOUT_SOON;
  notice.hidden = false;
  return true;
}

// ---------------------------------------------------------------------------
// Counting real use for RepoHQ

/** The referrer when it is another site; null for this site, none, or anything unparseable. */
export function externalReferrer(referrer: string, origin: string): string | null {
  try {
    const from = new URL(referrer);
    return from.origin !== 'null' && from.origin !== origin ? referrer : null;
  } catch {
    return null;
  }
}

/** Only the production site counts, only for people, and never in the owner's browser. */
export function trackingAllowed(env: SignalEnv): boolean {
  if (env.webdriver || env.deployment !== 'production' || env.local === null) return false;
  try {
    return env.local.getItem(NOTRACK_KEY) === null;
  } catch {
    // Storage refused: the owner's flag can't be checked, so send nothing.
    return false;
  }
}

/**
 * Sends one event, fire-and-forget. Returns whether it was sent. The body is JSON, labelled
 * text/plain: that keeps it a CORS "simple" request, so there's no preflight to fail and
 * keepalive works in every browser; nobody reads the reply.
 */
export function sendSignal(env: SignalEnv, kind: SignalKind): boolean {
  if (!trackingAllowed(env)) return false;
  const body = JSON.stringify({ slug: SIGNAL_SLUG, kind, referrer: externalReferrer(env.referrer, env.origin) });
  try {
    env
      .fetch(SIGNAL_URL, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body,
        keepalive: true,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
      .catch(() => {});
  } catch {
    // A browser that refuses the request outright (a keepalive quota, say): nothing to do.
  }
  return true;
}

/**
 * "visit" once per browser session, "activate" once per browser. The mark is set before
 * sending, and nothing is sent when it can't be set, so a refusing storage never means
 * an event on every page.
 */
export function signalOnce(env: SignalEnv, kind: 'visit' | 'activate'): boolean {
  if (!trackingAllowed(env)) return false;
  const [store, key] = kind === 'visit' ? [env.session, VISIT_KEY] : [env.local, ACTIVATE_KEY];
  if (store === null) return false;
  try {
    if (store.getItem(key) !== null) return false;
    store.setItem(key, '1');
  } catch {
    return false;
  }
  return sendSignal(env, kind);
}

/** The core action on the website: a sign-up for the waitlist (not a removal, not a bot). */
export function joinedWaitlist(sent: Record<string, string>): boolean {
  return sent.action === 'join' && !sent[HONEYPOT];
}

/** Sends "checkout" on every click of a Buy link, and lets the click go on to Stripe. */
export function trackCheckout(links: Iterable<Pick<Element, 'addEventListener'>>, env: SignalEnv): void {
  for (const link of links) link.addEventListener('click', () => void sendSignal(env, 'checkout'));
}

/** Storage the browser may refuse (blocked cookies, some private windows): null then. */
function storage(get: () => Storage): KeyValueStore | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function main(): void {
  const signals: SignalEnv = {
    deployment: document.querySelector(`meta[name="${DEPLOYMENT_META}"]`)?.getAttribute('content') ?? null,
    webdriver: navigator.webdriver === true,
    referrer: document.referrer,
    origin: location.origin,
    session: storage(() => sessionStorage),
    local: storage(() => localStorage),
    fetch: (url, init) => fetch(url, init),
  };
  signalOnce(signals, 'visit');

  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-waitlist]')) {
    const status = document.getElementById(form.dataset.status ?? '');
    if (!status) continue;
    enhanceForm({
      form,
      status,
      values() {
        const values: Record<string, string> = {};
        new FormData(form).forEach((value, name) => {
          if (typeof value === 'string') values[name] = value;
        });
        return values;
      },
      fetch: (url, init) => fetch(url, init),
      onSuccess: (sent) => {
        if (joinedWaitlist(sent)) signalOnce(signals, 'activate');
      },
    });
  }
  trackCheckout(document.querySelectorAll('a[data-buy]'), signals);
  showCheckoutNotice(document.getElementById('checkout-notice'), location.search);
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') main();
