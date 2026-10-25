// The interstitial page: shown when the gate stops a Google sign-in. It asks the
// service worker about the URL in its #fragment, explains a blocked request and
// sends the user's choice back. It holds no state and never writes the lists itself.
//
// Any site can open this page (it must be web-accessible for the redirect), so the
// only input it trusts is the worker's reply. Text from the URL is rendered with
// textContent only, the page does nothing inside a frame, and the buttons stay
// disabled for ARM_DELAY_MS after each prompt appears: a site that opened this
// page can reload it with another app's prompt just before a click lands.

import type { Message, Reply } from './background.ts';
import type { Assessment, Choice, Reason } from '../policy.ts';
import type { Rating } from '../scopes.ts';

/** How long a new prompt ignores clicks. */
export const ARM_DELAY_MS = 600;

export interface PageEnv {
  doc: Document;
  root: HTMLElement;
  /** location.hash: "#" followed by the URL the gate stopped. */
  hash: string;
  /** true when the page is inside a frame. */
  framed: boolean;
  send(message: Message): Promise<Reply>;
  /** Leaves this page for `url`, without leaving the page itself in history. */
  navigate(url: string): void;
  /** Goes back, or closes a popup. false when neither was possible. */
  goBack(): boolean;
  wait(ms: number): Promise<void>;
}

const COPY: Record<Reason, { title: string; lead: string }> = {
  'high-risk': {
    title: 'Hold on: this app wants risky access to your Google account',
    lead: 'grantgate stopped this sign-in before it reached Google. Only continue if you know this app and trust it with what it asks for.',
  },
  denylisted: {
    title: "You've blocked this app",
    lead: 'This app is on your block list, so grantgate stopped the sign-in.',
  },
  'unidentified-app': {
    title: "Hold on: grantgate can't tell which app is asking",
    lead: 'The sign-in link names more than one app, a trick used to slip past block lists.',
  },
  // The worker never asks about these; listed so every reason has words.
  allowlisted: { title: 'This app is on your allow list', lead: 'grantgate has nothing to ask.' },
  'not-high-risk': { title: 'Nothing risky here', lead: 'grantgate has nothing to ask.' },
  'not-a-grant-request': { title: 'Nothing to check', lead: 'This is not a sign-in request.' },
};

const BUTTONS: Record<Choice, string> = {
  back: 'Go back',
  once: 'Continue to Google, just this once',
  'always-allow': 'Always allow this app',
  'always-block': 'Always block this app',
};

const RATING_TEXT: Record<Rating, string> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };
const RATING_ORDER: Record<Rating, number> = { high: 0, medium: 1, low: 2 };

/** The URL the gate stopped, or null when the fragment is empty. */
export function targetFromHash(hash: string): string | null {
  const target = hash.replace(/^#/, '');
  return target.trim() === '' ? null : target;
}

/** Shows a blocked request and its choices. `onChoice` gets the clicked choice. */
export function renderPrompt(
  doc: Document,
  root: HTMLElement,
  assessment: Assessment,
  choices: readonly Choice[],
  onChoice: (choice: Choice) => void,
): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const copy = COPY[assessment.reason];
  const request = assessment.request;

  const facts = el('dl', undefined, 'facts');
  facts.append(
    el('dt', 'App'),
    el('dd', request?.client_id ?? 'Unknown: the link names more than one app', 'app'),
    el('dt', 'Sends access to'),
    el('dd', destination(request?.redirect_uri ?? null), 'destination'),
  );

  const labels = [...(assessment.risk?.labels ?? [])].sort((a, b) => RATING_ORDER[a.rating] - RATING_ORDER[b.rating]);
  const list = el('ul', undefined, 'scopes');
  for (const label of labels) {
    const item = el('li', undefined, `rating-${label.rating}`);
    item.append(el('span', RATING_TEXT[label.rating], 'badge'), ' ', label.label);
    list.append(item);
  }
  const wants = labels.length > 0 ? el('p', 'It wants to:') : el('p', 'It names no permissions.');

  const actions = el('div', undefined, 'choices');
  for (const choice of choices) {
    const button = el('button', BUTTONS[choice], choice === 'back' ? 'primary' : 'secondary');
    button.type = 'button';
    button.dataset.choice = choice;
    button.addEventListener('click', () => onChoice(choice));
    actions.append(button);
  }

  root.replaceChildren(
    el('h1', copy.title),
    el('p', copy.lead, 'lead'),
    facts,
    wants,
    list,
    el('p', "Continuing doesn't grant anything yet: Google will still show its own screen where you choose Allow or Cancel.", 'note'),
    actions,
  );
}

/** Runs the page: check the stopped URL, then either continue or ask. */
export async function runInterstitial(env: PageEnv): Promise<void> {
  if (env.framed) {
    showMessage(env, "grantgate won't run inside another page.");
    return;
  }
  const target = targetFromHash(env.hash);
  if (target === null) {
    showError(env, 'There is no sign-in to check.');
    return;
  }

  let pending = false;
  const setButtons = (disabled: boolean) => {
    for (const button of env.root.querySelectorAll('button')) button.disabled = disabled;
  };
  const handle = async (reply: Reply): Promise<void> => {
    if (!reply.ok) return showError(env, reply.error);
    if (reply.action === 'back') return goBack(env);
    if (reply.action === 'proceed') {
      // The worker only returns Google addresses; check anyway before leaving.
      if (!isGoogleAccountsUrl(reply.url)) return showError(env, 'grantgate was asked to go somewhere other than Google.');
      return env.navigate(reply.url);
    }
    // Replies meant for the options page; fail closed.
    if (reply.action !== 'ask') return showError(env, "grantgate got an answer it didn't expect. Reload this page to check again.");
    renderPrompt(env.doc, env.root, reply.assessment, reply.choices, (choice) => {
      if (pending) return;
      pending = true;
      setButtons(true);
      void send(env, { type: 'choose', url: target, choice }).then(handle);
    });
    setButtons(true);
    await env.wait(ARM_DELAY_MS);
    if (!pending) setButtons(false);
  };
  await handle(await send(env, { type: 'check', url: target }));
}

async function send(env: PageEnv, message: Message): Promise<Reply> {
  const unreachable: Reply = { ok: false, error: "grantgate couldn't reach its background worker. Reload this page to try again." };
  try {
    const reply = await env.send(message);
    return reply && typeof reply === 'object' && 'ok' in reply ? reply : unreachable;
  } catch {
    return unreachable;
  }
}

function goBack(env: PageEnv): void {
  if (!env.goBack()) showMessage(env, 'grantgate stopped this sign-in. You can close this tab now.');
}

function showMessage(env: PageEnv, text: string): void {
  const p = env.doc.createElement('p');
  p.textContent = text;
  env.root.replaceChildren(p);
}

function showError(env: PageEnv, text: string): void {
  const title = env.doc.createElement('h1');
  title.textContent = 'grantgate stopped this sign-in';
  const p = env.doc.createElement('p');
  p.textContent = text;
  const back = env.doc.createElement('button');
  back.textContent = BUTTONS.back;
  back.type = 'button';
  back.className = 'primary';
  back.dataset.choice = 'back';
  back.addEventListener('click', () => goBack(env));
  env.root.replaceChildren(title, p, back);
}

function destination(redirectUri: string | null): string {
  if (redirectUri === null) return 'Not stated';
  try {
    return new URL(redirectUri).host || redirectUri;
  } catch {
    return redirectUri;
  }
}

function isGoogleAccountsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.replace(/\.$/, '') === 'accounts.google.com';
  } catch {
    return false;
  }
}

function main(): void {
  const root = document.getElementById('app');
  if (!root) return;
  const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage(m: Message): Promise<Reply> } } }).chrome.runtime;
  void runInterstitial({
    doc: document,
    root,
    hash: location.hash,
    framed: window.top !== window,
    send: (message) => runtime.sendMessage(message),
    navigate: (url) => location.replace(url),
    goBack: () => {
      if (history.length > 1) {
        history.back();
        return true;
      }
      // A sign-in popup has no history; a script-opened window may close itself.
      window.close();
      return false;
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') main();
