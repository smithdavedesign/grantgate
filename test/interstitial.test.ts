import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assess, choicesFor, type Assessment, type Choice } from '../src/policy.ts';
import type { Message, Reply } from '../src/extension/background.ts';
import { ARM_DELAY_MS, renderPrompt, runInterstitial, targetFromHash, type PageEnv } from '../src/extension/interstitial.ts';

const API = 'https://www.googleapis.com/auth/';
const V2 = 'https://accounts.google.com/o/oauth2/v2/auth';
const ROADMAP_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20openid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code';
const ROADMAP_APP = 'abc.apps.googleusercontent.com';

function authorizeUrl(params: Record<string, string | string[]>): string {
  const url = new URL(V2);
  for (const [key, value] of Object.entries(params)) {
    for (const one of [value].flat()) url.searchParams.append(key, one);
  }
  return url.href;
}

// ---------------------------------------------------------------------------
// Just enough DOM to render the page in Node. Setting innerHTML throws, so any
// attempt to render request text as markup fails the test.

class FakeElement {
  readonly tagName: string;
  children: (FakeElement | string)[] = [];
  className = '';
  type = '';
  disabled = false;
  dataset: Record<string, string> = {};
  private listeners: ((event: { type: string }) => void)[] = [];

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(value: string) {
    this.children = [String(value)];
  }
  set innerHTML(_value: string) {
    throw new Error('the interstitial must not render HTML');
  }
  insertAdjacentHTML(): never {
    throw new Error('the interstitial must not render HTML');
  }
  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeElement | string)[]) {
    this.children = [...nodes];
  }
  addEventListener(type: string, listener: (event: { type: string }) => void) {
    if (type === 'click') this.listeners.push(listener);
  }
  click() {
    if (this.disabled) return;
    for (const listener of this.listeners) listener({ type: 'click' });
  }
  querySelectorAll(selector: string): FakeElement[] {
    assert.match(selector, /^[a-z]+$/, 'the fake only supports tag selectors');
    return all(this, (el) => el.tagName === selector.toUpperCase());
  }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) };

function all(root: FakeElement, test: (el: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  for (const child of root.children) {
    if (typeof child === 'string') continue;
    if (test(child)) found.push(child);
    found.push(...all(child, test));
  }
  return found;
}

const buttons = (root: FakeElement) => all(root, (el) => el.tagName === 'BUTTON');
const button = (root: FakeElement, choice: string) => {
  const match = buttons(root).find((b) => b.dataset.choice === choice);
  assert.ok(match, `no ${choice} button`);
  return match;
};

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function render(assessment: Assessment, choices: Choice[] = choicesFor(assessment)) {
  const root = new FakeElement('main');
  const picked: Choice[] = [];
  renderPrompt(fakeDocument as unknown as Document, root as unknown as HTMLElement, assessment, choices, (c) => void picked.push(c));
  return { root, picked };
}

// A page wired to fakes. `replies` answers messages in order.
// `wait` resolves at once unless the test supplies its own.
function page(
  options: {
    hash?: string;
    framed?: boolean;
    replies?: (Reply | Error | undefined)[];
    canGoBack?: boolean;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  const root = new FakeElement('main');
  const sent: Message[] = [];
  const navigations: string[] = [];
  let backs = 0;
  const replies = [...(options.replies ?? [])];
  const env: PageEnv = {
    doc: fakeDocument as unknown as Document,
    root: root as unknown as HTMLElement,
    hash: options.hash ?? `#${ROADMAP_URL}`,
    framed: options.framed ?? false,
    async send(message) {
      sent.push(message);
      await flush();
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply as Reply;
    },
    navigate: (url) => void navigations.push(url),
    goBack() {
      backs += 1;
      return options.canGoBack ?? true;
    },
    wait: options.wait ?? (async () => {}),
  };
  return {
    env,
    root,
    sent,
    navigations,
    get backs() {
      return backs;
    },
  };
}

const highRisk = assess(ROADMAP_URL, { allow: [], deny: [] });
const ASK: Reply = { ok: true, action: 'ask', assessment: highRisk, choices: choicesFor(highRisk) };
const PROCEED: Reply = { ok: true, action: 'proceed', url: ROADMAP_URL };

// ---------------------------------------------------------------------------

describe('targetFromHash', () => {
  it('returns everything after the first #, or null when there is nothing', () => {
    assert.equal(targetFromHash(`#${ROADMAP_URL}`), ROADMAP_URL);
    assert.equal(targetFromHash(`#${V2}?client_id=a#frag`), `${V2}?client_id=a#frag`);
    assert.equal(targetFromHash('#'), null);
    assert.equal(targetFromHash(''), null);
    assert.equal(targetFromHash('#   '), null);
  });
});

describe('renderPrompt: what the user sees', () => {
  it('explains a high-risk request: the app, where access goes, and each permission, riskiest first', () => {
    const { root } = render(highRisk);
    const text = root.textContent;
    assert.match(text, /risky access/i);
    assert.ok(text.includes(ROADMAP_APP));
    assert.ok(text.includes('app.example'));
    assert.ok(text.includes('read, send, delete and manage all your email'));
    assert.ok(text.includes('confirm who you are when you sign in'));
    assert.ok(text.indexOf('all your email') < text.indexOf('confirm who you are'), 'high-risk permission listed first');
    assert.match(text, /High risk/);
    assert.match(text, /Google will still show its own screen/);
  });

  it('offers go back, continue once, always allow and always block, with going back first', () => {
    const { root } = render(highRisk);
    assert.deepEqual(buttons(root).map((b) => b.dataset.choice), ['back', 'once', 'always-allow', 'always-block']);
    assert.deepEqual(buttons(root).map((b) => b.textContent), [
      'Go back',
      'Continue to Google, just this once',
      'Always allow this app',
      'Always block this app',
    ]);
    assert.ok(buttons(root).every((b) => b.type === 'button'));
    assert.match(button(root, 'back').className, /primary/);
  });

  it('sends the clicked choice', () => {
    const { root, picked } = render(highRisk);
    button(root, 'once').click();
    button(root, 'always-allow').click();
    assert.deepEqual(picked, ['once', 'always-allow']);
  });

  it('only offers "go back" for a denylisted app', () => {
    const denied = assess(ROADMAP_URL, { allow: [], deny: [ROADMAP_APP] });
    const { root } = render(denied);
    assert.match(root.textContent, /You've blocked this app/);
    assert.deepEqual(buttons(root).map((b) => b.dataset.choice), ['back']);
  });

  it('says when it cannot tell which app is asking', () => {
    const unidentified = assess(authorizeUrl({ client_id: ['a', 'b'], scope: `${API}drive` }), {});
    const { root } = render(unidentified);
    assert.match(root.textContent, /can't tell which app/);
    assert.match(root.textContent, /more than one app/);
    assert.deepEqual(buttons(root).map((b) => b.dataset.choice), ['back', 'once']);
  });

  it('says so when the request names no redirect address', () => {
    const noRedirect = assess(authorizeUrl({ client_id: 'x', scope: `${API}drive` }), {});
    assert.match(render(noRedirect).root.textContent, /Not stated/);
  });

  it('shows text from the URL as text, never as markup', () => {
    const hostile = '<img/src=x/onerror=alert(1)>';
    const url = authorizeUrl({
      client_id: '<script>alert(1)</script>',
      scope: `${hostile} https://mail.google.com/`,
      redirect_uri: 'javascript:alert(1)',
    });
    const assessment = assess(url, {});
    assert.equal(assessment.decision, 'block');
    const { root } = render(assessment);
    assert.deepEqual(all(root, (el) => ['IMG', 'SCRIPT', 'A'].includes(el.tagName)), []);
    assert.ok(root.textContent.includes(hostile));
    assert.ok(root.textContent.includes('<script>alert(1)</script>'));
  });
});

describe('runInterstitial: the page’s flow', () => {
  it('refuses to run inside a frame and sends nothing', async () => {
    const p = page({ framed: true, replies: [PROCEED] });
    await runInterstitial(p.env);
    assert.deepEqual(p.sent, []);
    assert.deepEqual(p.navigations, []);
    assert.match(p.root.textContent, /inside another page/);
    assert.deepEqual(buttons(p.root), []);
  });

  it('shows an error and sends nothing when there is no sign-in to check', async () => {
    for (const hash of ['', '#']) {
      const p = page({ hash });
      await runInterstitial(p.env);
      assert.deepEqual(p.sent, []);
      assert.match(p.root.textContent, /no sign-in to check/);
    }
  });

  it('asks the worker about the URL and goes straight on when it says proceed', async () => {
    const p = page({ replies: [PROCEED] });
    await runInterstitial(p.env);
    assert.deepEqual(p.sent, [{ type: 'check', url: ROADMAP_URL }]);
    assert.deepEqual(p.navigations, [ROADMAP_URL]);
  });

  it('never navigates to a non-Google address, even if told to', async () => {
    for (const url of ['javascript:alert(1)', 'https://evil.example/o/oauth2/v2/auth', 'chrome://settings']) {
      const p = page({ replies: [{ ok: true, action: 'proceed', url }] });
      await runInterstitial(p.env);
      assert.deepEqual(p.navigations, [], url);
      assert.match(p.root.textContent, /stopped this sign-in/);
    }
  });

  for (const choice of ['once', 'always-allow'] as const) {
    it(`sends "${choice}" for its button and continues to Google when told to`, async () => {
      const p = page({ replies: [ASK, PROCEED] });
      await runInterstitial(p.env);
      button(p.root, choice).click();
      await flush();
      await flush();
      assert.deepEqual(p.sent, [
        { type: 'check', url: ROADMAP_URL },
        { type: 'choose', url: ROADMAP_URL, choice },
      ]);
      assert.deepEqual(p.navigations, [ROADMAP_URL]);
    });
  }

  for (const choice of ['back', 'always-block'] as const) {
    it(`sends "${choice}" for its button and goes back when told to`, async () => {
      const p = page({ replies: [ASK, { ok: true, action: 'back' }] });
      await runInterstitial(p.env);
      button(p.root, choice).click();
      await flush();
      await flush();
      assert.deepEqual(p.sent[1], { type: 'choose', url: ROADMAP_URL, choice });
      assert.equal(p.backs, 1);
      assert.deepEqual(p.navigations, []);
    });
  }

  it('ignores clicks until the prompt has been on screen for a moment', async () => {
    let arm = () => {};
    const delays: number[] = [];
    const wait = (ms: number) => {
      delays.push(ms);
      return new Promise<void>((resolve) => (arm = resolve));
    };
    const p = page({ replies: [ASK, PROCEED], wait });
    const running = runInterstitial(p.env);
    await flush();
    await flush();
    assert.deepEqual(delays, [ARM_DELAY_MS]);
    assert.ok(ARM_DELAY_MS >= 500, 'long enough to notice the page changed');
    assert.equal(buttons(p.root).length, 4);
    assert.ok(buttons(p.root).every((b) => b.disabled));
    button(p.root, 'always-allow').click();
    await flush();
    assert.equal(p.sent.length, 1, 'a click before arming sends nothing');

    arm();
    await running;
    assert.ok(buttons(p.root).every((b) => !b.disabled));
    button(p.root, 'always-allow').click();
    await flush();
    await flush();
    assert.deepEqual(p.sent[1], { type: 'choose', url: ROADMAP_URL, choice: 'always-allow' });
  });

  it('sends one choice per prompt, disabling the buttons while it waits', async () => {
    const p = page({ replies: [ASK, PROCEED, PROCEED] });
    await runInterstitial(p.env);
    button(p.root, 'once').click();
    assert.ok(buttons(p.root).every((b) => b.disabled));
    button(p.root, 'always-allow').click();
    await flush();
    await flush();
    assert.equal(p.sent.filter((m) => m.type === 'choose').length, 1);
  });

  it('tells the user to close the tab when there is nowhere to go back to', async () => {
    const p = page({ replies: [ASK, { ok: true, action: 'back' }], canGoBack: false });
    await runInterstitial(p.env);
    button(p.root, 'back').click();
    await flush();
    await flush();
    assert.match(p.root.textContent, /close this tab/);
  });

  it('shows the worker’s error with a way back, without navigating', async () => {
    const p = page({ replies: [{ ok: false, error: 'That is not a Google sign-in address.' }] });
    await runInterstitial(p.env);
    assert.match(p.root.textContent, /stopped this sign-in/);
    assert.match(p.root.textContent, /not a Google sign-in address/);
    assert.deepEqual(p.navigations, []);
    button(p.root, 'back').click();
    assert.equal(p.backs, 1);
    assert.equal(p.sent.length, 1, 'going back from an error needs no worker');
  });

  it('shows an error when the worker cannot be reached or does not answer', async () => {
    for (const reply of [new Error('Could not establish connection'), undefined]) {
      const p = page({ replies: [reply] });
      await runInterstitial(p.env);
      assert.match(p.root.textContent, /couldn't reach/);
      assert.deepEqual(p.navigations, []);
    }
  });

  it('shows an error when a choice fails', async () => {
    const p = page({ replies: [ASK, { ok: false, error: "That choice isn't offered for this sign-in." }] });
    await runInterstitial(p.env);
    button(p.root, 'once').click();
    await flush();
    await flush();
    assert.match(p.root.textContent, /isn't offered/);
    assert.deepEqual(p.navigations, []);
  });
});

describe('runInterstitial: replies meant for another page (M3)', () => {
  it('shows an error with a way back instead of a prompt', async () => {
    const p = page({ replies: [{ ok: true, action: 'saved' }] });
    await runInterstitial(p.env);
    assert.match(p.root.textContent, /didn't expect/);
    assert.deepEqual(p.navigations, []);
    assert.deepEqual(buttons(p.root).map((b) => b.dataset.choice), ['back']);
  });
});
