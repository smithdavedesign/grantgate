import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_HEADERS } from '../src/site/api.ts';
import { HONEYPOT_FIELD } from '../src/site/waitlist.ts';
import {
  ACTIVATE_KEY,
  HONEYPOT,
  NOTRACK_KEY,
  SIGNAL_SLUG,
  SIGNAL_URL,
  VISIT_KEY,
  enhanceForm,
  externalReferrer,
  joinedWaitlist,
  sendSignal,
  signalOnce,
  trackCheckout,
  trackingAllowed,
  type KeyValueStore,
  type SignalEnv,
} from '../src/site/page.ts';
import { FakeElement } from './helpers/fake-dom.ts';

const ORIGIN = 'https://grantgate.vercel.app';

class MemoryStorage implements KeyValueStore {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
}

/** Storage that refuses every call, as Safari's can in private windows or with storage blocked. */
const brokenStorage: KeyValueStore = {
  getItem() {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  },
  setItem() {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  },
};

interface Sent {
  url: string;
  init: RequestInit;
}

function signals(overrides: Partial<SignalEnv> = {}) {
  const sent: Sent[] = [];
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const env: SignalEnv = {
    deployment: 'production',
    webdriver: false,
    referrer: '',
    origin: ORIGIN,
    session,
    local,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response(null, { status: 204 });
    },
    ...overrides,
  };
  const bodies = () => sent.map((s) => JSON.parse(String(s.init.body)));
  return { env, sent, bodies, session, local };
}

describe('externalReferrer', () => {
  it('passes on a referrer from another site, whole', () => {
    assert.equal(externalReferrer('https://news.ycombinator.com/item?id=1', ORIGIN), 'https://news.ycombinator.com/item?id=1');
    assert.equal(externalReferrer('https://www.reddit.com/', ORIGIN), 'https://www.reddit.com/');
    // Another scheme or port is another origin.
    assert.equal(externalReferrer('http://grantgate.vercel.app/', ORIGIN), 'http://grantgate.vercel.app/');
  });

  it('is null for this site, for no referrer, and for anything unparseable', () => {
    for (const referrer of ['', `${ORIGIN}/`, `${ORIGIN}/privacy?ref=share#x`, 'not a url', 'about:blank']) {
      assert.equal(externalReferrer(referrer, ORIGIN), null, referrer);
    }
  });
});

describe('trackingAllowed', () => {
  it('is true only on the production deployment, in a real browser, without the owner flag', () => {
    assert.equal(trackingAllowed(signals().env), true);
  });

  it('is false for automated browsers', () => {
    assert.equal(trackingAllowed(signals({ webdriver: true }).env), false);
  });

  it('is false on preview and development builds, or when the deployment is unknown', () => {
    for (const deployment of ['preview', 'development', '', 'Production', null]) {
      assert.equal(trackingAllowed(signals({ deployment }).env), false, String(deployment));
    }
  });

  it(`is false when localStorage "${NOTRACK_KEY}" is set, to any value`, () => {
    for (const value of ['1', 'true', '', '0']) {
      const { env, local } = signals();
      local.setItem(NOTRACK_KEY, value);
      assert.equal(trackingAllowed(env), false, JSON.stringify(value));
    }
  });

  it("is false when localStorage can't be read or doesn't exist, since the owner flag can't be checked", () => {
    assert.equal(trackingAllowed(signals({ local: brokenStorage }).env), false);
    assert.equal(trackingAllowed(signals({ local: null }).env), false);
  });
});

describe('sendSignal', () => {
  it('POSTs {slug, kind, referrer} as JSON to RepoHQ, with keepalive and no cookies or referrer header', () => {
    const { env, sent } = signals({ referrer: 'https://news.ycombinator.com/' });
    assert.equal(sendSignal(env, 'checkout'), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://idea-factory.1426davejobs.workers.dev/api/ideas/signal');
    assert.equal(SIGNAL_URL, sent[0].url);
    assert.equal(sent[0].init.method, 'POST');
    // A CORS-safelisted type, so the browser sends it with no preflight.
    assert.deepEqual(sent[0].init.headers, { 'content-type': 'text/plain;charset=UTF-8' });
    const request = new Request(SIGNAL_URL, sent[0].init);
    assert.equal(request.mode, 'cors');
    assert.equal(request.credentials, 'omit');
    assert.equal(sent[0].init.keepalive, true);
    assert.equal(sent[0].init.credentials, 'omit');
    assert.equal(sent[0].init.referrerPolicy, 'no-referrer');
    assert.equal(sent[0].init.body, JSON.stringify({ slug: 'grantgate', kind: 'checkout', referrer: 'https://news.ycombinator.com/' }));
    assert.equal(SIGNAL_SLUG, 'grantgate');
  });

  it('sends a null referrer when the visitor came from this site, so share links never leave the page', () => {
    const { env, bodies } = signals({ referrer: `${ORIGIN}/?utm_source=share&invite=abc` });
    sendSignal(env, 'checkout');
    assert.deepEqual(bodies(), [{ slug: 'grantgate', kind: 'checkout', referrer: null }]);
  });

  it('sends nothing when tracking is not allowed', () => {
    for (const overrides of [{ webdriver: true }, { deployment: 'preview' }, { deployment: null }] as Partial<SignalEnv>[]) {
      const { env, sent } = signals(overrides);
      assert.equal(sendSignal(env, 'checkout'), false);
      assert.equal(sent.length, 0);
    }
  });

  it('is fire-and-forget: a failing or throwing fetch never reaches the page', async () => {
    const rejected = signals({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    assert.equal(sendSignal(rejected.env, 'checkout'), true);
    const thrown = signals({
      fetch: () => {
        throw new TypeError('keepalive quota');
      },
    });
    assert.doesNotThrow(() => sendSignal(thrown.env, 'checkout'));
    await new Promise((r) => setImmediate(r)); // an unhandled rejection would fail the run
  });
});

describe('signalOnce', () => {
  it('"visit": once per browser session (sessionStorage)', () => {
    const { env, bodies, session, local } = signals();
    assert.equal(signalOnce(env, 'visit'), true);
    assert.equal(signalOnce(env, 'visit'), false);
    assert.deepEqual(bodies(), [{ slug: 'grantgate', kind: 'visit', referrer: null }]);
    assert.ok(session.getItem(VISIT_KEY) !== null);
    assert.equal(local.getItem(VISIT_KEY), null);
  });

  it('"activate": once per browser (localStorage)', () => {
    const { env, bodies, session, local } = signals();
    assert.equal(signalOnce(env, 'activate'), true);
    assert.equal(signalOnce(env, 'activate'), false);
    assert.deepEqual(bodies(), [{ slug: 'grantgate', kind: 'activate', referrer: null }]);
    assert.ok(local.getItem(ACTIVATE_KEY) !== null);
    assert.equal(session.getItem(ACTIVATE_KEY), null);
  });

  it('a new session counts another visit, but never another activation', () => {
    const first = signals();
    signalOnce(first.env, 'visit');
    signalOnce(first.env, 'activate');
    const nextSession = signals({ local: first.local });
    assert.equal(signalOnce(nextSession.env, 'visit'), true);
    assert.equal(signalOnce(nextSession.env, 'activate'), false);
  });

  it('passes on an outside referrer', () => {
    const { env, bodies } = signals({ referrer: 'https://www.reddit.com/r/gsuite/' });
    signalOnce(env, 'visit');
    assert.deepEqual(bodies(), [{ slug: 'grantgate', kind: 'visit', referrer: 'https://www.reddit.com/r/gsuite/' }]);
  });

  it('remembers nothing when tracking is off, so turning it on later still counts the first visit', () => {
    const { env, sent, session } = signals({ deployment: 'preview' });
    assert.equal(signalOnce(env, 'visit'), false);
    assert.equal(sent.length, 0);
    assert.equal(session.getItem(VISIT_KEY), null);
  });

  it("sends nothing when it can't remember having sent (storage refused or missing)", () => {
    for (const overrides of [{ session: brokenStorage }, { session: null }] as Partial<SignalEnv>[]) {
      const { env, sent } = signals(overrides);
      assert.equal(signalOnce(env, 'visit'), false);
      assert.equal(sent.length, 0);
    }
    const local = new MemoryStorage();
    local.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    const { env, sent } = signals({ local });
    assert.equal(signalOnce(env, 'activate'), false);
    assert.equal(sent.length, 0);
  });
});

describe('the core action: joining the waitlist', () => {
  it('counts as activation only for a real join, never for removal or a filled honeypot', () => {
    assert.equal(HONEYPOT, HONEYPOT_FIELD);
    assert.equal(joinedWaitlist({ action: 'join', email: 'owner@acme.example', website: '' }), true);
    assert.equal(joinedWaitlist({ action: 'join', email: 'owner@acme.example' }), true);
    assert.equal(joinedWaitlist({ action: 'leave', email: 'owner@acme.example' }), false);
    assert.equal(joinedWaitlist({ action: 'join', email: 'bot@spam.example', website: 'https://spam.example' }), false);
    assert.equal(joinedWaitlist({}), false);
  });

  function form(reply: Response) {
    const el = new FakeElement('form');
    el.setAttribute('action', '/api/waitlist');
    const successes: Record<string, string>[] = [];
    const values = { action: 'join', email: 'owner@acme.example', website: '' };
    enhanceForm({
      form: el as unknown as HTMLFormElement,
      status: new FakeElement('p') as unknown as HTMLElement,
      values: () => ({ ...values }),
      fetch: async () => reply,
      onSuccess: (sent) => successes.push(sent),
    });
    return { el, successes, values };
  }

  it('enhanceForm reports a sign-up the server accepted, with the values it sent', async () => {
    const { el, successes, values } = form(new Response(JSON.stringify({ ok: true, message: 'Joined.' })));
    await el.dispatch('submit');
    assert.deepEqual(successes, [values]);
  });

  it('enhanceForm reports nothing when the server refused it', async () => {
    const { el, successes } = form(new Response(JSON.stringify({ ok: false, error: 'Nope.' }), { status: 400 }));
    await el.dispatch('submit');
    assert.deepEqual(successes, []);
  });
});

describe('trackCheckout', () => {
  it('sends "checkout" on every click of a Buy link, and lets the click through to Stripe', async () => {
    const { env, bodies } = signals();
    const buy = new FakeElement('a');
    trackCheckout([buy as unknown as Element], env);
    const first = await buy.dispatch('click');
    await buy.dispatch('click');
    assert.equal(first.defaultPrevented, false);
    assert.deepEqual(bodies(), [
      { slug: 'grantgate', kind: 'checkout', referrer: null },
      { slug: 'grantgate', kind: 'checkout', referrer: null },
    ]);
  });

  it('sends nothing from an automated browser', async () => {
    const { env, sent } = signals({ webdriver: true });
    const buy = new FakeElement('a');
    trackCheckout([buy as unknown as Element], env);
    await buy.dispatch('click');
    assert.equal(sent.length, 0);
  });
});

describe('the CSP lets the page reach RepoHQ, and nothing else new', () => {
  it("connect-src is the site itself plus the signal endpoint's origin", () => {
    const csp = SITE_HEADERS['Content-Security-Policy'];
    const connect = /(?:^|;\s*)connect-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/);
    assert.deepEqual(connect, ["'self'", new URL(SIGNAL_URL).origin]);
    assert.match(csp, /script-src 'self'(;|$)/);
  });
});
