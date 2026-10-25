import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthorizeUrl } from '../src/authorize.ts';
import {
  APPROVAL_TTL_MS,
  GATE_REGEX,
  GATE_RULE_ID,
  INTERSTITIAL_PATH,
  OPTIONS_PATH,
  PASS_TTL_MS,
  createGate,
  gateRule,
  isGateTarget,
  passRule,
  passUrlFor,
  start,
  type ChromeApi,
  type DnrRule,
  type Reply,
  type Sender,
} from '../src/extension/background.ts';
import { WrongPassphraseError, createLedgerKey, openLedger } from '../src/ledger.ts';
import { MAX_POLICY_ENTRIES } from '../src/policy.ts';
import { AUTHORIZE_FIXTURES } from './fixtures/authorize-urls.ts';

const API = 'https://www.googleapis.com/auth/';
const V2 = 'https://accounts.google.com/o/oauth2/v2/auth';
const EXTENSION_ID = 'gategategategategategategategate';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const INTERSTITIAL = `${ORIGIN}/${INTERSTITIAL_PATH}`;
const OPTIONS = `${ORIGIN}/${OPTIONS_PATH}`;
// The options page opens in a tab of its own (options_ui.open_in_tab).
const OPTIONS_SENDER: Sender = { id: EXTENSION_ID, url: OPTIONS, tab: { id: 99 } };

const ROADMAP_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20openid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code';
const ROADMAP_APP = 'abc.apps.googleusercontent.com';

function authorizeUrl(params: Record<string, string | string[]>, base = V2): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    for (const one of [value].flat()) url.searchParams.append(key, one);
  }
  return url.href;
}

const LOW_URL = authorizeUrl({ client_id: 'notes.apps.googleusercontent.com', scope: 'openid email profile' });
// What Google redirects to after the user continues: the same request, one step further.
const ROADMAP_FOLLOW_UP = ROADMAP_URL.replace('/o/oauth2/v2/auth?', '/o/oauth2/auth/oauthchooseaccount?');

const gatePattern = new RegExp(GATE_REGEX, 'i');

// ---------------------------------------------------------------------------
// A fake of the chrome.* surface the worker uses. Storage and rule updates
// resolve on a later tick, like the real asynchronous APIs, so races show up.

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeOptions {
  policy?: unknown;
  sessionRules?: DnrRule[];
  failStorage?: boolean;
}

function fakeChrome(options: FakeOptions = {}) {
  const store = new Map<string, unknown>();
  if (options.policy !== undefined) store.set('policy', structuredClone(options.policy));
  const dynamicRules: DnrRule[] = [];
  const sessionRules: DnrRule[] = [...(options.sessionRules ?? [])];
  const messageListeners: Parameters<ChromeApi['runtime']['onMessage']['addListener']>[0][] = [];
  const installedListeners: Parameters<ChromeApi['runtime']['onInstalled']['addListener']>[0][] = [];
  let storageWrites = 0;
  let optionsOpened = 0;

  function update(rules: DnrRule[], change: { removeRuleIds?: number[]; addRules?: DnrRule[] }) {
    const remove = new Set(change.removeRuleIds ?? []);
    const kept = rules.filter((r) => !remove.has(r.id));
    for (const rule of change.addRules ?? []) {
      if (kept.some((r) => r.id === rule.id)) throw new Error(`duplicate rule id ${rule.id}`);
      kept.push(structuredClone(rule));
    }
    rules.splice(0, rules.length, ...kept);
  }

  const api: ChromeApi = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `${ORIGIN}/${path.replace(/^\//, '')}`,
      onMessage: { addListener: (listener) => void messageListeners.push(listener) },
      onInstalled: { addListener: (listener) => void installedListeners.push(listener) },
      async openOptionsPage() {
        await tick();
        optionsOpened += 1;
      },
    },
    storage: {
      local: {
        async get(key: string) {
          await tick();
          if (options.failStorage) throw new Error('storage is unavailable');
          return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
        },
        async set(items: Record<string, unknown>) {
          await tick();
          if (options.failStorage) throw new Error('storage is unavailable');
          storageWrites += 1;
          for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value));
        },
      },
    },
    declarativeNetRequest: {
      async updateDynamicRules(change) {
        await tick();
        update(dynamicRules, change);
      },
      async updateSessionRules(change) {
        await tick();
        update(sessionRules, change);
      },
      async getSessionRules() {
        await tick();
        return structuredClone(sessionRules);
      },
    },
  };

  // Where Chrome would send a main-frame navigation, using the subset of DNR
  // semantics our rules rely on: highest priority wins, allow beats redirect,
  // urlFilter "|…|" is an exact match, regexFilter is a regex over the URL.
  function navigate(tabId: number, url: string): { to: 'network' } | { to: 'interstitial'; target: string } {
    const href = new URL(url).href;
    const matching = [...sessionRules, ...dynamicRules].filter((rule) => {
      const c = rule.condition;
      if (!c.resourceTypes.includes('main_frame')) return false;
      if (c.tabIds && !c.tabIds.includes(tabId)) return false;
      if (c.urlFilter !== undefined) {
        assert.match(c.urlFilter, /^\|[^|*^]+\|$/, 'pass filters must be exact, wildcard-free URLs');
        const exact = c.urlFilter.slice(1, -1);
        return c.isUrlFilterCaseSensitive ? href === exact : href.toLowerCase() === exact.toLowerCase();
      }
      return new RegExp(c.regexFilter ?? '$^', c.isUrlFilterCaseSensitive ? '' : 'i').test(href);
    });
    matching.sort((a, b) => b.priority - a.priority || (a.action.type === 'allow' ? -1 : 1));
    const winner = matching[0];
    if (!winner || winner.action.type === 'allow') return { to: 'network' };
    const substitution = winner.action.redirect?.regexSubstitution ?? '';
    const redirected = href.replace(new RegExp(winner.condition.regexFilter ?? '', 'i'), (all) => substitution.replace('\\0', all));
    assert.ok(redirected.startsWith(`${INTERSTITIAL}#`), redirected);
    return { to: 'interstitial', target: redirected.slice(INTERSTITIAL.length + 1) };
  }

  return {
    api,
    store,
    dynamicRules,
    sessionRules,
    messageListeners,
    installedListeners,
    navigate,
    get storageWrites() {
      return storageWrites;
    },
    get optionsOpened() {
      return optionsOpened;
    },
  };
}

function tabSender(tabId: number, hash = ''): Sender {
  return { id: EXTENSION_ID, url: `${INTERSTITIAL}${hash}`, tab: { id: tabId } };
}

function setup(options: FakeOptions = {}) {
  const chrome = fakeChrome(options);
  let clock = 1_000_000;
  const scheduled: { at: number; fn: () => void }[] = [];
  const errors: unknown[] = [];
  const gate = createGate(chrome.api, {
    now: () => clock,
    schedule: (fn, ms) => void scheduled.push({ at: clock + ms, fn }),
    onError: (err) => void errors.push(err),
  });
  async function send(tabId: number, message: unknown): Promise<Reply> {
    return gate.handleMessage(message, tabSender(tabId));
  }
  async function advance(ms: number) {
    clock += ms;
    for (const job of scheduled.splice(0)) {
      if (job.at <= clock) job.fn();
      else scheduled.push(job);
    }
    await tick();
    await tick();
  }
  const check = (tabId: number, url: string) => send(tabId, { type: 'check', url });
  const choose = (tabId: number, url: string, choice: string) => send(tabId, { type: 'choose', url, choice });
  const fromOptionsPage = (message: unknown) => gate.handleMessage(message, OPTIONS_SENDER);
  return { chrome, gate, send, check, choose, options: fromOptionsPage, advance, errors };
}

// The reply's action, or the error, so a failure shows up in the assertion message.
function actionOf(reply: Reply): string {
  return reply.ok ? reply.action : `error: ${reply.error}`;
}

function storedPolicy(chrome: ReturnType<typeof fakeChrome>) {
  return chrome.store.get('policy');
}

function passRules(chrome: ReturnType<typeof fakeChrome>) {
  return chrome.sessionRules.filter((r) => r.action.type === 'allow');
}

// ---------------------------------------------------------------------------

describe('gate rule: which navigations reach the interstitial', () => {
  // Every spelling M1's parser accepts, canonicalised the way Chrome hands URLs to DNR.
  const spellings = [
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com/o/oauth2/auth',
    'https://accounts.google.com/o/oauth2/auth/oauthchooseaccount',
    'https://accounts.google.com/o/oauth2/v2/auth/identifier',
    'https://ACCOUNTS.Google.com/o/oauth2/v2/auth',
    'https://accounts.google.com./o/oauth2/v2/auth',
    'https://accounts.google.com:443/o/oauth2/v2/auth',
    'http://accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com/o/oauth2/v2/%61uth',
    'https://accounts.google.com/%6f/%6fauth2/v2/auth',
    'https://accounts.google.com//o//oauth2/v2/auth',
    'https://accounts.google.com/O/OAuth2/v2/auth',
  ];

  it('catches every URL the M1 parser treats as a grant request, including all 20 fixtures', () => {
    const urls = [...AUTHORIZE_FIXTURES.map((f) => f.url), ...spellings.map((base) => authorizeUrl({ client_id: 'a', scope: 'openid' }, base))];
    for (const url of urls) {
      assert.notEqual(parseAuthorizeUrl(url), null, `parser should accept ${url}`);
      assert.match(new URL(url).href, gatePattern, url);
    }
  });

  it('leaves other hosts and ordinary Google pages alone', () => {
    for (const url of [
      'https://accounts.google.com.evil.example/o/oauth2/v2/auth?client_id=a',
      'https://accounts-google.com/o/oauth2/v2/auth?client_id=a',
      'https://myaccount.google.com/o/oauth2/v2/auth?client_id=a',
      'https://evil.example/accounts.google.com/o/oauth2/v2/auth?client_id=a',
      'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com',
      'https://accounts.google.com/signin/oauth/consent?part=abc',
      'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn',
      'https://mail.google.com/mail/u/0/#inbox?q=oauth2',
    ]) {
      assert.doesNotMatch(new URL(url).href, gatePattern, url);
    }
  });

  it('uses only syntax that Chrome’s RE2 engine accepts', () => {
    assert.doesNotMatch(GATE_REGEX, /\(\?[=!<]|\\[1-9]/, 'no lookaround or backreferences');
    assert.ok(GATE_REGEX.length < 100, 'keep the filter small');
  });

  it('redirects matching main-frame navigations to the interstitial with the original URL after #', () => {
    assert.deepEqual(gateRule(INTERSTITIAL), {
      id: GATE_RULE_ID,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${INTERSTITIAL}#\\0` } },
      condition: { regexFilter: GATE_REGEX, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] },
    });
  });
});

describe('pass rules: letting one approved request through', () => {
  it('match one exact URL in one tab, case-sensitively, above the gate rule', () => {
    assert.deepEqual(passRule(1001, 7, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=a'), {
      id: 1001,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        urlFilter: '|https://accounts.google.com/o/oauth2/v2/auth?client_id=a|',
        isUrlFilterCaseSensitive: true,
        tabIds: [7],
        resourceTypes: ['main_frame'],
      },
    });
  });

  it('percent-encode the characters urlFilter would treat as wildcards and drop any fragment', () => {
    const url = `${V2}?client_id=a&state=x*y^z|w#frag`;
    assert.equal(passUrlFor(url), `${V2}?client_id=a&state=x%2Ay%5Ez%7Cw`);
    // Google reads the same parameters from the encoded URL.
    assert.equal(new URL(passUrlFor(url)).searchParams.get('state'), 'x*y^z|w');
  });

  it('isGateTarget accepts only http(s) URLs on accounts.google.com that the gate rule stops', () => {
    assert.equal(isGateTarget(ROADMAP_URL), true);
    assert.equal(isGateTarget('http://accounts.google.com./o/oauth2/auth?client_id=a'), true);
    const withUserinfo = `https://${['someone', 'x'].join(':')}@accounts.google.com/o/oauth2/v2/auth?client_id=a`;
    for (const bad of [
      'javascript:alert(1)//accounts.google.com/o/oauth2/v2/auth',
      'data:text/html,accounts.google.com/o/oauth2/v2/auth',
      'https://evil.example/o/oauth2/v2/auth?client_id=a',
      'https://accounts.google.com.evil.example/o/oauth2/v2/auth?client_id=a',
      `${ORIGIN}/o/oauth2/v2/auth`,
      'https://accounts.google.com:8443/o/oauth2/v2/auth?client_id=a',
      withUserinfo,
      'https://accounts.google.com/ServiceLogin',
      '/o/oauth2/v2/auth?client_id=a',
      '',
      42,
      null,
    ]) {
      assert.equal(isGateTarget(bad), false, String(bad));
    }
  });
});

describe('worker: M2 exit criterion — confirming adds nothing to the allowlist unless "always allow" is chosen', () => {
  it('"continue once" lets this request through without writing the lists, so the next tab is asked again', async () => {
    const { chrome, check, choose } = setup();
    const asked = await check(7, ROADMAP_URL);
    assert.equal(asked.ok && asked.action, 'ask');

    const reply = await choose(7, ROADMAP_URL, 'once');
    assert.deepEqual(reply, { ok: true, action: 'proceed', url: passUrlFor(ROADMAP_URL) });
    assert.equal(chrome.storageWrites, 0, 'nothing written to storage');
    assert.equal(storedPolicy(chrome), undefined);
    assert.deepEqual(chrome.navigate(7, ROADMAP_URL), { to: 'network' });

    const otherTab = await check(8, ROADMAP_URL);
    assert.equal(otherTab.ok && otherTab.action, 'ask');
    assert.deepEqual(chrome.navigate(8, ROADMAP_URL), { to: 'interstitial', target: ROADMAP_URL });
  });

  it('"always allow" stores the client_id, so the next tab goes straight through', async () => {
    const { chrome, check, choose } = setup({ policy: { allow: ['kept.apps.googleusercontent.com'], deny: [] } });
    const reply = await choose(7, ROADMAP_URL, 'always-allow');
    assert.equal(reply.ok && reply.action, 'proceed');
    assert.deepEqual(storedPolicy(chrome), { allow: ['kept.apps.googleusercontent.com', ROADMAP_APP], deny: [] });

    assert.deepEqual(await check(8, ROADMAP_URL), { ok: true, action: 'proceed', url: passUrlFor(ROADMAP_URL) });
  });

  it('"go back" writes nothing and adds no pass', async () => {
    const { chrome, choose } = setup();
    assert.deepEqual(await choose(7, ROADMAP_URL, 'back'), { ok: true, action: 'back' });
    assert.equal(chrome.storageWrites, 0);
    assert.deepEqual(passRules(chrome), []);
  });

  it('"always block" stores the client_id on the denylist only and sends the tab back', async () => {
    const { chrome, check, choose } = setup();
    assert.deepEqual(await choose(7, ROADMAP_URL, 'always-block'), { ok: true, action: 'back' });
    assert.deepEqual(storedPolicy(chrome), { allow: [], deny: [ROADMAP_APP] });
    assert.deepEqual(passRules(chrome), []);
    const again = await check(8, ROADMAP_URL);
    assert.ok(again.ok && again.action === 'ask');
    assert.equal(again.assessment.reason, 'denylisted');
    assert.deepEqual(again.choices, ['back']);
  });
});

describe('worker: checking a request', () => {
  it('lets low-risk sign-ins straight through with a pass for that tab only', async () => {
    const { chrome, check } = setup();
    assert.deepEqual(await check(7, LOW_URL), { ok: true, action: 'proceed', url: passUrlFor(LOW_URL) });
    assert.deepEqual(chrome.navigate(7, LOW_URL), { to: 'network' });
    assert.deepEqual(chrome.navigate(8, LOW_URL), { to: 'interstitial', target: LOW_URL });
  });

  it('asks about a high-risk request and explains it, adding no pass', async () => {
    const { chrome, check } = setup();
    const reply = await check(7, ROADMAP_URL);
    assert.ok(reply.ok && reply.action === 'ask');
    assert.equal(reply.assessment.decision, 'block');
    assert.equal(reply.assessment.reason, 'high-risk');
    assert.equal(reply.assessment.request?.client_id, ROADMAP_APP);
    assert.equal(reply.assessment.risk?.rating, 'high');
    assert.deepEqual(reply.choices, ['back', 'once', 'always-allow', 'always-block']);
    assert.deepEqual(passRules(chrome), []);
  });

  it('does not let a low-risk pass in a popup cover a high-risk request sent to the same popup', async () => {
    const { chrome, check } = setup();
    await check(7, LOW_URL);
    assert.deepEqual(chrome.navigate(7, ROADMAP_URL), { to: 'interstitial', target: ROADMAP_URL });
    const sameAppMoreScopes = authorizeUrl({ client_id: 'notes.apps.googleusercontent.com', scope: 'openid https://mail.google.com/' });
    assert.equal(chrome.navigate(7, sameAppMoreScopes).to, 'interstitial');
  });

  it('reads the lists fresh from storage on every check', async () => {
    const { chrome, check } = setup();
    assert.equal(actionOf(await check(7, ROADMAP_URL)), 'ask');
    chrome.store.set('policy', { allow: [ROADMAP_APP], deny: [] });
    assert.equal(actionOf(await check(7, ROADMAP_URL)), 'proceed');
  });

  it('copes with a corrupt stored policy', async () => {
    const { check } = setup({ policy: 'garbage' });
    const reply = await check(7, ROADMAP_URL);
    assert.ok(reply.ok && reply.action === 'ask');
  });
});

describe('worker: Google’s follow-up steps after the user continues', () => {
  it('lets the same request through again in the same tab without asking twice', async () => {
    const { check, choose } = setup();
    await choose(7, ROADMAP_URL, 'once');
    assert.deepEqual(await check(7, ROADMAP_FOLLOW_UP), { ok: true, action: 'proceed', url: passUrlFor(ROADMAP_FOLLOW_UP) });
  });

  it('covers fewer scopes but not more scopes, another app, another redirect or another tab', async () => {
    const { check, choose } = setup();
    await choose(7, ROADMAP_URL, 'once');
    const fewer = authorizeUrl({ client_id: ROADMAP_APP, scope: 'https://mail.google.com/', redirect_uri: 'https://app.example/cb' });
    assert.equal(actionOf(await check(7, fewer)), 'proceed');

    const asks = [
      authorizeUrl({ client_id: ROADMAP_APP, scope: `https://mail.google.com/ ${API}drive`, redirect_uri: 'https://app.example/cb' }),
      authorizeUrl({ client_id: 'evil.apps.googleusercontent.com', scope: 'https://mail.google.com/', redirect_uri: 'https://app.example/cb' }),
      authorizeUrl({ client_id: ROADMAP_APP, scope: 'https://mail.google.com/', redirect_uri: 'https://evil.example/cb' }),
    ];
    for (const url of asks) assert.equal(actionOf(await check(7, url)), 'ask', url);
    assert.equal(actionOf(await check(8, ROADMAP_FOLLOW_UP)), 'ask');
  });

  it('forgets the approval after a minute', async () => {
    const { check, choose, advance } = setup();
    await choose(7, ROADMAP_URL, 'once');
    await advance(APPROVAL_TTL_MS + 1);
    assert.equal(actionOf(await check(7, ROADMAP_FOLLOW_UP)), 'ask');
  });

  it('never lets an approval cover an app that has since been denylisted', async () => {
    const { check, choose } = setup();
    await choose(7, ROADMAP_URL, 'once');
    await choose(8, ROADMAP_URL, 'always-block');
    const reply = await check(7, ROADMAP_FOLLOW_UP);
    assert.ok(reply.ok && reply.action === 'ask');
    assert.equal(reply.assessment.reason, 'denylisted');
  });

  it('remembers nothing for an app it cannot identify', async () => {
    const { check, choose } = setup();
    const unidentified = authorizeUrl({ client_id: ['a.apps.googleusercontent.com', 'b.apps.googleusercontent.com'], scope: `${API}drive` });
    assert.equal(actionOf(await choose(7, unidentified, 'once')), 'proceed');
    const followUp = unidentified.replace('/o/oauth2/v2/auth?', '/o/oauth2/auth/oauthchooseaccount?');
    assert.equal(actionOf(await check(7, followUp)), 'ask');
  });
});

describe('worker: pass rules expire', () => {
  it('removes a pass on a timer once its time is up', async () => {
    const { chrome, check, advance } = setup();
    await check(7, LOW_URL);
    assert.equal(passRules(chrome).length, 1);
    await advance(PASS_TTL_MS - 1);
    assert.equal(passRules(chrome).length, 1);
    await advance(2);
    assert.deepEqual(passRules(chrome), []);
    assert.equal(chrome.navigate(7, LOW_URL).to, 'interstitial');
  });

  it('also sweeps expired passes when the next message arrives', async () => {
    const chrome = fakeChrome();
    let clock = 0;
    const gate = createGate(chrome.api, { now: () => clock, schedule: () => {} });
    await gate.handleMessage({ type: 'check', url: LOW_URL }, tabSender(7));
    clock += PASS_TTL_MS + 1;
    await gate.handleMessage({ type: 'check', url: ROADMAP_URL }, tabSender(7));
    await tick();
    assert.deepEqual(passRules(chrome), []);
  });

  it('refuses instead of looping when a live pass for the same URL did not match the navigation', async () => {
    const { chrome, check } = setup();
    await check(7, LOW_URL);
    const again = await check(7, LOW_URL);
    assert.equal(again.ok, false);
    assert.equal(passRules(chrome).length, 1);
    // A different tab is a different navigation.
    assert.equal(actionOf(await check(8, LOW_URL)), 'proceed');
  });
});

describe('worker: list writes are serialised', () => {
  it('keeps both apps when two tabs choose "always allow" at the same moment', async () => {
    const { chrome, choose } = setup();
    const other = authorizeUrl({ client_id: 'other.apps.googleusercontent.com', scope: `${API}drive` });
    const replies = await Promise.all([choose(7, ROADMAP_URL, 'always-allow'), choose(8, other, 'always-allow')]);
    assert.deepEqual(replies.map((r) => r.ok), [true, true]);
    assert.deepEqual(storedPolicy(chrome), { allow: [ROADMAP_APP, 'other.apps.googleusercontent.com'], deny: [] });
  });

  it('keeps going after a failed choice', async () => {
    const { chrome, choose } = setup({ policy: { allow: [], deny: [ROADMAP_APP] } });
    const results = await Promise.all([choose(7, ROADMAP_URL, 'once'), choose(8, LOW_URL.replace('notes', 'x'), 'once')]);
    assert.deepEqual(results.map((r) => r.ok), [false, false]);
    const other = authorizeUrl({ client_id: 'other.apps.googleusercontent.com', scope: `${API}drive` });
    assert.equal(actionOf(await choose(9, other, 'always-allow')), 'proceed');
    assert.deepEqual(storedPolicy(chrome), { allow: ['other.apps.googleusercontent.com'], deny: [ROADMAP_APP] });
  });
});

describe('worker: rejects what it should not act on', () => {
  it('refuses messages from anything but our interstitial page in a tab', async () => {
    const { chrome, gate } = setup();
    const message = { type: 'choose', url: ROADMAP_URL, choice: 'always-allow' };
    const senders: Sender[] = [
      { id: 'someotherextension', url: INTERSTITIAL, tab: { id: 7 } },
      { id: EXTENSION_ID, url: `${ORIGIN}/other.html`, tab: { id: 7 } },
      { id: EXTENSION_ID, url: `${INTERSTITIAL}.evil`, tab: { id: 7 } },
      { id: EXTENSION_ID, url: 'https://evil.example/interstitial.html', tab: { id: 7 } },
      { id: EXTENSION_ID, url: INTERSTITIAL },
      { id: EXTENSION_ID, url: INTERSTITIAL, tab: { id: -1 } },
      {},
    ];
    for (const sender of senders) {
      const reply = await gate.handleMessage(message, sender);
      assert.equal(reply.ok, false, JSON.stringify(sender));
    }
    assert.equal(chrome.storageWrites, 0);
    assert.deepEqual(passRules(chrome), []);
  });

  it('accepts the interstitial with its #fragment on the sender URL', async () => {
    const { gate } = setup();
    const reply = await gate.handleMessage({ type: 'check', url: LOW_URL }, tabSender(7, `#${LOW_URL}`));
    assert.equal(reply.ok, true);
  });

  it('refuses malformed messages', async () => {
    const { chrome, send } = setup();
    for (const message of [
      null,
      'check',
      {},
      { type: 'navigate', url: LOW_URL },
      { type: 'check' },
      { type: 'check', url: 42 },
      { type: 'choose', url: ROADMAP_URL },
      { type: 'choose', url: ROADMAP_URL, choice: 'maybe' },
    ]) {
      const reply = await send(7, message);
      assert.equal(reply.ok, false, JSON.stringify(message));
    }
    assert.equal(chrome.storageWrites, 0);
    assert.deepEqual(passRules(chrome), []);
  });

  it('refuses to send a tab anywhere but a Google sign-in address', async () => {
    const { chrome, check, choose } = setup();
    for (const url of ['javascript:alert(document.domain)', 'https://evil.example/o/oauth2/v2/auth?client_id=a', `${ORIGIN}/interstitial.html`]) {
      const reply = await check(7, url);
      assert.deepEqual(reply, { ok: false, error: 'That is not a Google sign-in address.' }, url);
      assert.equal((await choose(7, url, 'once')).ok, false);
    }
    assert.deepEqual(passRules(chrome), []);
  });

  it('refuses a choice the page should not have offered', async () => {
    const { chrome, choose } = setup({ policy: { allow: [], deny: [ROADMAP_APP] } });
    for (const choice of ['once', 'always-allow', 'always-block']) {
      const reply = await choose(7, ROADMAP_URL, choice);
      assert.equal(reply.ok, false, choice);
    }
    assert.equal(actionOf(await choose(7, ROADMAP_URL, 'back')), 'back');
    assert.equal(chrome.storageWrites, 0);
    assert.deepEqual(passRules(chrome), []);
  });

  it('reports a storage failure instead of letting the request through', async () => {
    const { chrome, check, choose } = setup({ failStorage: true });
    assert.equal((await check(7, ROADMAP_URL)).ok, false);
    assert.equal((await check(7, LOW_URL)).ok, false);
    assert.equal((await choose(7, ROADMAP_URL, 'always-allow')).ok, false);
    assert.deepEqual(passRules(chrome), []);
  });
});

describe('worker: start-up', () => {
  it('installs the gate rule pointing at our interstitial and clears stale passes', async () => {
    const stale = passRule(1005, 3, LOW_URL);
    const { chrome, gate, check } = setup({ sessionRules: [stale] });
    await gate.ready;
    assert.deepEqual(chrome.dynamicRules, [gateRule(INTERSTITIAL)]);
    assert.deepEqual(chrome.sessionRules, []);
    // New pass ids never collide with rules that were there before.
    await check(7, LOW_URL);
    assert.equal(passRules(chrome).length, 1);
  });

  it('replaces an existing gate rule instead of failing on the duplicate id', async () => {
    const chrome = fakeChrome();
    await createGate(chrome.api, { schedule: () => {} }).ready;
    await createGate(chrome.api, { schedule: () => {} }).ready;
    assert.deepEqual(chrome.dynamicRules, [gateRule(INTERSTITIAL)]);
  });

  it('answers a message sent before start-up finished, after the stale rules are gone', async () => {
    const chrome = fakeChrome({ sessionRules: [passRule(1000, 7, LOW_URL)] });
    const gate = createGate(chrome.api, { schedule: () => {} });
    const reply = await gate.handleMessage({ type: 'check', url: LOW_URL }, tabSender(7));
    assert.equal(reply.ok, true);
    assert.equal(passRules(chrome).length, 1);
  });

  it('registers a message listener that answers asynchronously', async () => {
    const chrome = fakeChrome();
    start(chrome.api, { schedule: () => {} });
    assert.equal(chrome.messageListeners.length, 1);
    const reply = await new Promise<unknown>((resolve) => {
      const keepOpen = chrome.messageListeners[0]({ type: 'check', url: LOW_URL }, tabSender(7), resolve);
      assert.equal(keepOpen, true, 'returns true so Chrome waits for sendResponse');
    });
    assert.deepEqual(reply, { ok: true, action: 'proceed', url: passUrlFor(LOW_URL) });
  });

  it('logs instead of crashing when the rules cannot be installed', async () => {
    const chrome = fakeChrome();
    chrome.api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('rule limit');
    };
    const errors: unknown[] = [];
    const gate = createGate(chrome.api, { schedule: () => {}, onError: (err) => void errors.push(err) });
    await gate.ready;
    assert.equal(errors.length, 1);
    assert.equal((await gate.handleMessage({ type: 'check', url: LOW_URL }, tabSender(7))).ok, true);
  });
});

// ---------------------------------------------------------------------------
// M3: the encrypted ledger, and the options page's messages

const PASS_A = 'alpha alpha alpha';
const PASS_B = 'bravo bravo bravo';
// Tests only: the options page always uses the real PBKDF2 iteration count.
const FAST = { iterations: 1_000 };
const OTHER_APP = 'other.apps.googleusercontent.com';
const OTHER_HIGH = authorizeUrl({ client_id: OTHER_APP, scope: `${API}drive` });
const LOW_FOLLOW_UP = LOW_URL.replace('/o/oauth2/v2/auth?', '/o/oauth2/auth/oauthchooseaccount?');
const ONE = 'one.apps.googleusercontent.com';
const TWO = 'two.apps.googleusercontent.com';
const mailFrom = (clientId: string) =>
  authorizeUrl({ client_id: clientId, scope: 'https://mail.google.com/', redirect_uri: 'https://app.example/cb' });

// A worker whose ledger was set up from the options page with PASS_A.
async function withLedger(options: FakeOptions = {}) {
  const s = setup(options);
  const key = await createLedgerKey(PASS_A, FAST);
  assert.deepEqual(await s.options({ type: 'ledger-setup', key }), { ok: true, action: 'saved' });
  const read = (passphrase = PASS_A) => openLedger(key, passphrase, s.chrome.store.get('ledger'));
  return { ...s, key, read };
}

const allowList = (chrome: ReturnType<typeof fakeChrome>) => (storedPolicy(chrome) as { allow: string[] }).allow;

describe('worker: M3 exit criterion — the ledger it writes opens with passphrase A and fails with B', () => {
  it('records each decision sealed, so only passphrase A reads it back', async () => {
    const { chrome, check, choose, read } = await withLedger();
    await choose(7, ROADMAP_URL, 'once');
    await check(8, LOW_URL);
    await choose(9, OTHER_HIGH, 'always-block');

    const { entries, unreadable } = await read(PASS_A);
    assert.equal(unreadable, 0);
    assert.deepEqual(
      entries.map((e) => [e.client_id, e.decision, e.rating]),
      [
        [ROADMAP_APP, 'once', 'high'],
        ['notes.apps.googleusercontent.com', 'allowed', 'low'],
        [OTHER_APP, 'always-block', 'high'],
      ],
    );
    assert.equal(entries[0].at, new Date(1_000_000).toISOString());
    assert.deepEqual(entries[0].scopes, ['https://mail.google.com/', 'openid']);
    assert.equal(entries[0].redirect_uri, 'https://app.example/cb');
    await assert.rejects(read(PASS_B), WrongPassphraseError);

    // Apps that were only let through appear nowhere in storage as plain text.
    const raw = JSON.stringify([...chrome.store]);
    assert.ok(!raw.includes(ROADMAP_APP), 'the app continued once is not readable');
    assert.ok(!raw.includes('notes.apps'), 'the app let through automatically is not readable');
  });
});

describe('worker: what goes into the ledger', () => {
  it('records nothing until a passphrase is set', async () => {
    const { chrome, check, choose } = setup();
    await choose(7, ROADMAP_URL, 'once');
    await check(8, LOW_URL);
    assert.equal(chrome.store.has('ledger'), false);
    assert.equal(chrome.storageWrites, 0);
  });

  it('records allowlisted apps as such, and every interstitial choice', async () => {
    const { check, choose, read } = await withLedger({ policy: { allow: [ROADMAP_APP], deny: [] } });
    await check(7, ROADMAP_URL);
    await choose(8, OTHER_HIGH, 'back');
    await choose(9, OTHER_HIGH, 'always-allow');
    assert.deepEqual((await read()).entries.map((e) => e.decision), ['allowlisted', 'back', 'always-allow']);
  });

  it('records a sign-in once, not again for Google’s follow-up steps in the same tab', async () => {
    const { check, choose, read } = await withLedger();
    await choose(7, ROADMAP_URL, 'once');
    assert.equal(actionOf(await check(7, ROADMAP_FOLLOW_UP)), 'proceed');
    await check(8, LOW_URL);
    assert.equal(actionOf(await check(8, LOW_FOLLOW_UP)), 'proceed');
    assert.equal((await read()).entries.length, 2);
    await check(9, LOW_URL);
    assert.equal((await read()).entries.length, 3, 'another tab is another sign-in');
  });

  it('records the same sign-in again once the minute is up', async () => {
    const { check, advance, read } = await withLedger();
    await check(8, LOW_URL);
    await advance(APPROVAL_TTL_MS + 1);
    assert.equal(actionOf(await check(8, LOW_URL)), 'proceed');
    assert.equal((await read()).entries.length, 2);
  });

  it('records a narrower sign-in the site tries after the user went back', async () => {
    const { check, choose, read } = await withLedger();
    await choose(7, ROADMAP_URL, 'back');
    const signInOnly = authorizeUrl({ client_id: ROADMAP_APP, scope: 'openid', redirect_uri: 'https://app.example/cb' });
    assert.equal(actionOf(await check(7, signInOnly)), 'proceed');
    assert.deepEqual((await read()).entries.map((e) => e.decision), ['back', 'allowed']);
  });

  it('records a new choice even right after an earlier one in the same tab', async () => {
    const { choose, read } = await withLedger();
    await choose(7, ROADMAP_URL, 'back');
    await choose(7, ROADMAP_URL, 'once');
    assert.deepEqual((await read()).entries.map((e) => e.decision), ['back', 'once']);
  });

  it('does not record oauth2 addresses that are not grant requests', async () => {
    const { check, read } = await withLedger();
    const notGrant = 'https://accounts.google.com/o/oauth2/iframerpc?action=checkOrigin';
    assert.equal(parseAuthorizeUrl(notGrant), null);
    assert.equal(actionOf(await check(7, notGrant)), 'proceed');
    assert.deepEqual((await read()).entries, []);
  });

  it('records decisions made at the same moment in different tabs without losing any', async () => {
    const { check, choose, read } = await withLedger();
    await Promise.all([choose(7, ROADMAP_URL, 'once'), check(8, LOW_URL), choose(9, OTHER_HIGH, 'always-allow')]);
    assert.equal((await read()).entries.length, 3);
  });

  it('still lets the sign-in through when the ledger cannot be written', async () => {
    const s = await withLedger();
    const set = s.chrome.api.storage.local.set;
    s.chrome.api.storage.local.set = async (items) => {
      if ('ledger' in items) throw new Error('quota exceeded');
      return set(items);
    };
    assert.equal(actionOf(await s.choose(7, ROADMAP_URL, 'once')), 'proceed');
    assert.equal(actionOf(await s.check(8, LOW_URL)), 'proceed');
    assert.equal(actionOf(await s.choose(9, OTHER_HIGH, 'always-allow')), 'proceed');
    assert.deepEqual(storedPolicy(s.chrome), { allow: [OTHER_APP], deny: [] });
    assert.equal(s.errors.length, 3, 'each failure is logged');
    assert.deepEqual((await s.read()).entries, []);
  });
});

describe('worker: M3 exit criterion — importing a policy file with 2 client_ids lets both apps through', () => {
  it('stores both IDs on the allow list and stops asking about them', async () => {
    const { chrome, check, options } = setup();
    assert.equal(actionOf(await check(7, mailFrom(ONE))), 'ask');
    assert.equal(actionOf(await options({ type: 'import-policy', text: JSON.stringify({ allow: [ONE, TWO] }) })), 'saved');
    assert.deepEqual(storedPolicy(chrome), { allow: [ONE, TWO], deny: [] });
    assert.equal(actionOf(await check(8, mailFrom(ONE))), 'proceed');
    assert.equal(actionOf(await check(9, mailFrom(TWO))), 'proceed');
    assert.equal(actionOf(await check(10, mailFrom('three.apps.googleusercontent.com'))), 'ask');
  });
});

describe('worker: messages from the options page', () => {
  it('merges an import into the lists already there, and a block still wins', async () => {
    const { chrome, options } = setup({ policy: { allow: [ROADMAP_APP], deny: [ONE] } });
    await options({ type: 'import-policy', text: JSON.stringify({ allow: [ONE, TWO], deny: [ROADMAP_APP] }) });
    assert.deepEqual(storedPolicy(chrome), { allow: [TWO], deny: [ONE, ROADMAP_APP] });
  });

  it('rejects a broken policy file with the reason, and changes nothing', async () => {
    const { chrome, options } = setup({ policy: { allow: [ONE], deny: [] } });
    const reply = await options({ type: 'import-policy', text: 'not json' });
    assert.match(reply.ok ? '' : reply.error, /isn't valid JSON/);
    for (const text of [JSON.stringify({ allow: 'x' }), JSON.stringify({ allow: ['two words'] }), 42]) {
      assert.equal((await options({ type: 'import-policy', text })).ok, false, String(text));
    }
    assert.equal(chrome.storageWrites, 0);
    assert.deepEqual(storedPolicy(chrome), { allow: [ONE], deny: [] });
  });

  it('refuses an import that would push the lists past the limit', async () => {
    const many = Array.from({ length: MAX_POLICY_ENTRIES }, (_, i) => `app${i}.apps.googleusercontent.com`);
    const { chrome, options } = setup({ policy: { allow: [ONE], deny: [] } });
    const reply = await options({ type: 'import-policy', text: JSON.stringify({ allow: many }) });
    assert.equal(reply.ok, false);
    assert.equal(chrome.storageWrites, 0);
  });

  it('removes an app from a list, so the gate asks about it again', async () => {
    const { chrome, check, options } = setup({ policy: { allow: [ROADMAP_APP], deny: [OTHER_APP] } });
    assert.equal(actionOf(await options({ type: 'remove-app', list: 'allow', client_id: ROADMAP_APP })), 'saved');
    assert.deepEqual(storedPolicy(chrome), { allow: [], deny: [OTHER_APP] });
    assert.equal(actionOf(await check(7, ROADMAP_URL)), 'ask');

    await options({ type: 'remove-app', list: 'deny', client_id: OTHER_APP.toUpperCase() });
    const reply = await check(8, OTHER_HIGH);
    assert.ok(reply.ok && reply.action === 'ask');
    assert.equal(reply.assessment.reason, 'high-risk');
  });

  it('sets up the ledger with no entries, and refuses to replace a working one', async () => {
    const { chrome, options, key } = await withLedger();
    assert.deepEqual(chrome.store.get('ledgerKey'), key);
    assert.deepEqual(chrome.store.get('ledger'), []);
    const reply = await options({ type: 'ledger-setup', key: await createLedgerKey(PASS_B, FAST) });
    assert.match(reply.ok ? '' : reply.error, /already/);
    assert.deepEqual(chrome.store.get('ledgerKey'), key);
  });

  it('accepts a new ledger over a damaged one, starting with no entries', async () => {
    const { chrome, options } = setup();
    chrome.store.set('ledgerKey', { v: 1, broken: true });
    chrome.store.set('ledger', [{ v: 1, epk: 'e', iv: 'i', ct: 'c' }]);
    const key = await createLedgerKey(PASS_A, FAST);
    assert.equal(actionOf(await options({ type: 'ledger-setup', key })), 'saved');
    assert.deepEqual(chrome.store.get('ledgerKey'), key);
    assert.deepEqual(chrome.store.get('ledger'), []);
  });

  it('rejects a damaged key from the page', async () => {
    const { chrome, options } = setup();
    const key = await createLedgerKey(PASS_A, FAST);
    for (const bad of [undefined, {}, { ...key, publicKey: 'AAAA' }]) {
      assert.equal((await options({ type: 'ledger-setup', key: bad })).ok, false, JSON.stringify(bad));
    }
    assert.equal(chrome.storageWrites, 0);
  });

  it('erases the ledger: the key and entries go, and recording stops', async () => {
    const { chrome, check, options, read } = await withLedger();
    await check(7, LOW_URL);
    assert.equal((await read()).entries.length, 1);
    assert.equal(actionOf(await options({ type: 'ledger-reset' })), 'saved');
    assert.equal(chrome.store.get('ledgerKey'), null);
    assert.deepEqual(chrome.store.get('ledger'), []);
    await check(8, LOW_URL);
    assert.deepEqual(chrome.store.get('ledger'), []);
  });

  it('reports a storage failure as a change that was not saved', async () => {
    const { options } = setup({ failStorage: true });
    assert.deepEqual(await options({ type: 'remove-app', list: 'allow', client_id: ONE }), {
      ok: false,
      error: 'grantgate could not save that change. Try again.',
    });
  });

  it('keeps both changes when an import and an "always allow" land together', async () => {
    const { chrome, choose, options } = setup();
    await Promise.all([
      options({ type: 'import-policy', text: JSON.stringify({ allow: [ONE] }) }),
      choose(7, ROADMAP_URL, 'always-allow'),
    ]);
    assert.deepEqual(new Set(allowList(chrome)), new Set([ONE, ROADMAP_APP]));
  });

  it('refuses malformed options messages', async () => {
    const { chrome, options } = setup();
    for (const message of [
      null,
      'ledger-reset',
      {},
      { type: 'wipe' },
      { type: 'import-policy' },
      { type: 'remove-app', list: 'maybe', client_id: ONE },
      { type: 'remove-app', list: 'allow' },
      { type: 'remove-app', list: 'allow', client_id: '   ' },
      { type: 'ledger-setup' },
    ]) {
      assert.equal((await options(message)).ok, false, JSON.stringify(message));
    }
    assert.equal(chrome.storageWrites, 0);
  });
});

describe('worker: each page may send only its own messages', () => {
  it('refuses list and ledger changes from the interstitial, which any site can open', async () => {
    const { chrome, send } = setup();
    const key = await createLedgerKey(PASS_A, FAST);
    for (const message of [
      { type: 'import-policy', text: JSON.stringify({ allow: [ONE] }) },
      { type: 'remove-app', list: 'deny', client_id: ONE },
      { type: 'ledger-setup', key },
      { type: 'ledger-reset' },
    ]) {
      assert.equal((await send(7, message)).ok, false, message.type);
    }
    assert.equal(chrome.storageWrites, 0);
  });

  it('refuses gate messages from the options page', async () => {
    const { chrome, options } = setup();
    for (const message of [
      { type: 'check', url: LOW_URL },
      { type: 'choose', url: ROADMAP_URL, choice: 'always-allow' },
    ]) {
      assert.equal((await options(message)).ok, false, message.type);
    }
    assert.equal(chrome.storageWrites, 0);
    assert.deepEqual(passRules(chrome), []);
  });

  it('answers the options page with or without a tab', async () => {
    const { gate } = setup();
    for (const sender of [
      { id: EXTENSION_ID, url: OPTIONS },
      { id: EXTENSION_ID, url: `${OPTIONS}#ledger`, tab: { id: 4 } },
    ]) {
      assert.equal(actionOf(await gate.handleMessage({ type: 'import-policy', text: '{"allow":[]}' }, sender)), 'saved');
    }
  });

  it('refuses options messages from anything but our options page', async () => {
    const { chrome, gate } = setup();
    for (const sender of [
      { id: 'someotherextension', url: OPTIONS },
      { id: EXTENSION_ID, url: `${ORIGIN}/other.html` },
      { id: EXTENSION_ID, url: `${OPTIONS}.evil` },
      { id: EXTENSION_ID, url: 'https://evil.example/options.html' },
      {},
    ]) {
      assert.equal((await gate.handleMessage({ type: 'ledger-reset' }, sender)).ok, false, JSON.stringify(sender));
    }
    assert.equal(chrome.storageWrites, 0);
  });
});

describe('worker: first install', () => {
  it('opens the options page on install so the user can set a passphrase, but not on update', async () => {
    const chrome = fakeChrome();
    start(chrome.api, { schedule: () => {} });
    assert.equal(chrome.installedListeners.length, 1);
    chrome.installedListeners[0]({ reason: 'update' });
    chrome.installedListeners[0]({ reason: 'chrome_update' });
    await tick();
    await tick();
    assert.equal(chrome.optionsOpened, 0);
    chrome.installedListeners[0]({ reason: 'install' });
    await tick();
    await tick();
    assert.equal(chrome.optionsOpened, 1);
  });

  it('logs instead of crashing when the options page cannot open', async () => {
    const chrome = fakeChrome();
    chrome.api.runtime.openOptionsPage = async () => {
      throw new Error('no window');
    };
    const errors: unknown[] = [];
    start(chrome.api, { schedule: () => {}, onError: (err) => void errors.push(err) });
    chrome.installedListeners[0]({ reason: 'install' });
    await tick();
    await tick();
    assert.equal(errors.length, 1);
  });
});
