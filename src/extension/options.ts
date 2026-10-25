// The options page: the encrypted sign-in ledger (set a passphrase, unlock, read,
// export CSV, erase), the allow and block lists (remove an app, export or import a
// policy file) and a link to Google's own list of apps with access.
//
// It reads storage but never writes it: every change is a message to the service
// worker, which owns the write queue. The passphrase never leaves this page; the
// worker only ever gets the ledger key, whose private half the passphrase wraps.
//
// Imports from background.ts must stay type-only: loading that module for real
// would start a second gate inside this page.

import type { OptionsMessage, Reply } from './background.ts';
import {
  DECISION_TEXT,
  LEDGER_KEY_STORAGE_KEY,
  LEDGER_STORAGE_KEY,
  MIN_PASSPHRASE_LENGTH,
  PBKDF2_ITERATIONS,
  UNIDENTIFIED_APP,
  WrongPassphraseError,
  createLedgerKey,
  ledgerCsv,
  openLedger,
  parseLedgerKey,
  type LedgerKey,
  type OpenedLedger,
} from '../ledger.ts';
import {
  MAX_POLICY_FILE_CHARS,
  POLICY_STORAGE_KEY,
  normalizePolicy,
  parsePolicyFile,
  policyFile,
  type ListName,
  type Policy,
} from '../policy.ts';
import { scopeRisk, type Rating } from '../scopes.ts';

/** Google's page listing every app with access to the account, where it can be removed. */
export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';
export const CSV_FILENAME = 'grantgate-ledger.csv';
export const POLICY_FILENAME = 'grantgate-policy.json';
export const STORAGE_KEYS = [POLICY_STORAGE_KEY, LEDGER_KEY_STORAGE_KEY, LEDGER_STORAGE_KEY];

export interface OptionsEnv {
  doc: Document;
  root: HTMLElement;
  /** The raw stored values for STORAGE_KEYS. */
  load(): Promise<Record<string, unknown>>;
  send(message: OptionsMessage): Promise<Reply>;
  download(filename: string, type: string, text: string): void;
  confirm(question: string): boolean;
  /** PBKDF2 iterations for a new ledger key. Only tests lower it. */
  iterations?: number;
}

/** A message meant for the user. Anything else is a bug and gets a generic message. */
class Problem extends Error {}

const RATING_TEXT: Record<Rating, string> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };
const LIST_TEXT: Record<ListName, { title: string; noun: string }> = {
  allow: { title: 'Always allowed', noun: 'allowed apps' },
  deny: { title: 'Always blocked', noun: 'blocked apps' },
};
const ERASE_QUESTION = "Erase the ledger? Every recorded sign-in will be deleted. This can't be undone.";

interface State {
  policy: Policy;
  key: LedgerKey | null;
  ledger: unknown;
  recorded: number;
  open: OpenedLedger | null;
  notice: { text: string; error: boolean } | null;
  busy: boolean;
}

export async function runOptions(env: OptionsEnv): Promise<void> {
  const state: State = { policy: { allow: [], deny: [] }, key: null, ledger: [], recorded: 0, open: null, notice: null, busy: false };

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = env.doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text: string, action: string, onClick?: () => unknown) => {
    const node = el('button', text);
    node.type = onClick ? 'button' : 'submit';
    node.dataset.action = action;
    node.disabled = state.busy;
    if (onClick) node.addEventListener('click', onClick);
    return node;
  };
  const passwordInput = (name: string, autocomplete: string) => {
    const input = el('input');
    input.type = 'password';
    input.name = name;
    input.autocomplete = autocomplete as AutoFill;
    input.required = true;
    input.disabled = state.busy;
    return input;
  };
  const labelled = (text: string, input: HTMLElement) => {
    const label = el('label');
    label.append(`${text} `, input);
    return label;
  };
  const form = (action: string, onSubmit: (values: Record<string, string>) => Promise<string | null>, ...fields: HTMLElement[]) => {
    const node = el('form');
    node.dataset.action = action;
    node.append(...fields);
    node.addEventListener('submit', (event) => {
      event.preventDefault();
      const values: Record<string, string> = {};
      for (const input of node.querySelectorAll('input')) values[input.name] = input.value;
      return act(() => onSubmit(values));
    });
    return node;
  };

  async function reload(): Promise<void> {
    const stored = await env.load();
    state.policy = normalizePolicy(stored[POLICY_STORAGE_KEY]);
    state.key = parseLedgerKey(stored[LEDGER_KEY_STORAGE_KEY]);
    state.ledger = stored[LEDGER_STORAGE_KEY];
    state.recorded = Array.isArray(state.ledger) ? state.ledger.length : 0;
    if (!state.key) state.open = null;
  }

  // One action at a time. The page is redrawn with every control disabled while it
  // runs, then from freshly read storage with the outcome.
  async function act(work: () => Promise<string | null>): Promise<void> {
    if (state.busy) return;
    state.busy = true;
    state.notice = { text: 'Working…', error: false };
    draw();
    try {
      const text = await work();
      state.notice = text === null ? null : { text, error: false };
    } catch (error) {
      state.notice = { text: messageFor(error), error: true };
    }
    try {
      await reload();
    } catch {
      state.notice = { text: "grantgate couldn't read its settings. Reload this page.", error: true };
    }
    state.busy = false;
    draw();
  }

  async function request(message: OptionsMessage): Promise<void> {
    let reply: Reply;
    try {
      reply = await env.send(message);
    } catch {
      throw new Problem("grantgate couldn't reach its background worker. Reload this page to try again.");
    }
    if (!reply || typeof reply !== 'object' || !('ok' in reply)) {
      throw new Problem("grantgate couldn't reach its background worker. Reload this page to try again.");
    }
    if (!reply.ok) throw new Problem(reply.error);
  }

  // ---------------------------------------------------------------------------
  // Sections

  function ledgerSection(): HTMLElement {
    const section = el('section');
    section.append(el('h2', 'Sign-in ledger'));
    if (!state.key) {
      section.append(
        el('p', 'grantgate can keep an encrypted record of every Google sign-in it checks: when, which app, what it asked for and what you decided.'),
        el('p', "Choose a passphrase to start. You'll need it to read or export the record, and it can't be recovered if you forget it."),
        form(
          'setup',
          async ({ passphrase, confirm }) => {
            if (passphrase !== confirm) throw new Problem("The two passphrases don't match.");
            if ([...passphrase.normalize('NFC')].length < MIN_PASSPHRASE_LENGTH) {
              throw new Problem(`Use at least ${MIN_PASSPHRASE_LENGTH} characters for the passphrase.`);
            }
            const key = await createLedgerKey(passphrase, { iterations: env.iterations ?? PBKDF2_ITERATIONS });
            await request({ type: 'ledger-setup', key });
            return 'Recording started. grantgate will add every Google sign-in it checks from now on.';
          },
          labelled('Passphrase', passwordInput('passphrase', 'new-password')),
          labelled('Type it again', passwordInput('confirm', 'new-password')),
          button('Start recording', 'start'),
        ),
      );
      return section;
    }

    if (!state.open) {
      section.append(
        el('p', state.recorded === 0 ? 'Nothing recorded yet.' : `${count(state.recorded, 'sign-in')} recorded. Enter your passphrase to read them.`),
        form(
          'unlock',
          async ({ passphrase }) => {
            const key = state.key;
            if (!key) throw new Problem('There is no ledger to open.');
            state.open = await openLedger(key, passphrase, state.ledger);
            return null;
          },
          labelled('Passphrase', passwordInput('passphrase', 'current-password')),
          button('Unlock', 'submit-unlock'),
        ),
        el('p', "Forgot the passphrase? The record can't be opened without it, but you can erase it and start again.", 'note'),
        button('Erase the ledger', 'erase', () => {
          if (!env.confirm(ERASE_QUESTION)) return;
          return act(async () => {
            await request({ type: 'ledger-reset' });
            state.open = null;
            return 'The ledger is erased. Choose a passphrase to start a new one.';
          });
        }),
      );
      return section;
    }

    const { entries, unreadable } = state.open;
    section.append(el('p', entries.length === 0 ? 'Nothing recorded yet.' : `${count(entries.length, 'sign-in')}, newest first.`));
    if (unreadable > 0) section.append(el('p', `${count(unreadable, 'entry', 'entries')} couldn't be read.`, 'warning'));
    if (entries.length > 0) {
      const table = el('table');
      const head = el('tr');
      for (const title of ['When', 'App', 'Decision', 'Risk', 'Permissions']) head.append(el('th', title));
      const body = el('tbody');
      for (const entry of [...entries].reverse()) {
        const row = el('tr', undefined, `rating-${entry.rating}`);
        row.append(
          el('td', new Date(entry.at).toLocaleString()),
          el('td', entry.client_id ?? UNIDENTIFIED_APP, 'app'),
          el('td', DECISION_TEXT[entry.decision]),
          el('td', RATING_TEXT[entry.rating], 'badge'),
          el('td', scopeRisk(entry.scopes).labels.map((label) => label.label).join('; ')),
        );
        body.append(row);
      }
      const thead = el('thead');
      thead.append(head);
      table.append(thead, body);
      section.append(table);
    }
    const actions = el('div', undefined, 'actions');
    actions.append(
      button('Export CSV', 'export-csv', () =>
        act(async () => {
          const opened = state.open;
          if (!opened) throw new Problem('Unlock the ledger first.');
          env.download(CSV_FILENAME, 'text/csv;charset=utf-8', ledgerCsv(opened.entries));
          return `Exported ${count(opened.entries.length, 'sign-in')}.`;
        }),
      ),
      button('Lock', 'lock', () => {
        if (state.busy) return;
        state.open = null;
        state.notice = null;
        draw();
      }),
    );
    section.append(actions);
    return section;
  }

  function appsSection(): HTMLElement {
    const section = el('section');
    section.append(
      el('h2', 'Allowed and blocked apps'),
      el('p', "Apps on the allow list skip grantgate's questions. Apps on the block list are always stopped. The lists aren't encrypted: grantgate reads them at every sign-in."),
    );
    for (const list of ['allow', 'deny'] as const) {
      section.append(el('h3', LIST_TEXT[list].title));
      const ids = state.policy[list];
      if (ids.length === 0) {
        section.append(el('p', 'None yet.', 'note'));
        continue;
      }
      const ul = el('ul', undefined, 'apps');
      for (const id of ids) {
        const item = el('li');
        const remove = button('Remove', 'remove', () =>
          act(async () => {
            await request({ type: 'remove-app', list, client_id: id });
            return `Removed ${id} from ${LIST_TEXT[list].noun}.`;
          }),
        );
        remove.dataset.list = list;
        remove.dataset.id = id;
        item.append(el('code', id), ' ', remove);
        ul.append(item);
      }
      section.append(ul);
    }

    const picker = el('input');
    picker.type = 'file';
    picker.name = 'policy-file';
    picker.accept = '.json,application/json';
    picker.disabled = state.busy;
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      return act(async () => {
        if (file.size > MAX_POLICY_FILE_CHARS) throw new Problem('That file is too big to be a grantgate policy file.');
        const text = await file.text();
        const parsed = parsePolicyFile(text);
        if (!parsed.ok) throw new Problem(parsed.error);
        const { allow, deny } = parsed.policy;
        const summary = `allows ${count(allow.length, 'app')} and blocks ${deny.length}`;
        if (!env.confirm(`"${file.name}" ${summary}. Add them to your lists? A block always wins over an allow.`)) return 'Nothing imported.';
        await request({ type: 'import-policy', text });
        return `Imported "${file.name}": it ${summary}.`;
      });
    });

    const actions = el('div', undefined, 'actions');
    actions.append(
      button('Export policy file', 'export-policy', () =>
        act(async () => {
          env.download(POLICY_FILENAME, 'application/json', policyFile(state.policy));
          return null;
        }),
      ),
      labelled('Import a policy file:', picker),
    );
    section.append(
      actions,
      el('p', 'A policy file hands the same lists to everyone: an owner exports it here and sends it, and staff import it. Importing adds to your lists.', 'note'),
    );
    return section;
  }

  function googleSection(): HTMLElement {
    const section = el('section');
    const link = el('a', "Open Google's list of apps with access to your account");
    link.href = GOOGLE_PERMISSIONS_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    section.append(
      el('h2', 'Review grants at Google'),
      el('p', 'grantgate only sees sign-ins in this browser, from the day it was installed. Google keeps the full list of apps that can still reach your account, and lets you remove any of them.'),
      link,
    );
    return section;
  }

  function draw(): void {
    const notice = el('p', state.notice?.text ?? '', state.notice?.error ? 'notice error' : 'notice');
    notice.setAttribute('role', 'status');
    env.root.replaceChildren(el('h1', 'grantgate settings'), notice, ledgerSection(), appsSection(), googleSection());
  }

  try {
    await reload();
  } catch {
    state.notice = { text: "grantgate couldn't read its settings. Reload this page.", error: true };
  }
  draw();
}

function messageFor(error: unknown): string {
  if (error instanceof Problem || error instanceof WrongPassphraseError) return error.message;
  return 'Something went wrong. Reload this page and try again.';
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function main(): void {
  const root = document.getElementById('app');
  if (!root) return;
  const chromeApi = (
    globalThis as unknown as {
      chrome: {
        runtime: { sendMessage(message: OptionsMessage): Promise<Reply> };
        storage: { local: { get(keys: string[]): Promise<Record<string, unknown>> } };
      };
    }
  ).chrome;
  void runOptions({
    doc: document,
    root,
    load: () => chromeApi.storage.local.get(STORAGE_KEYS),
    send: (message) => chromeApi.runtime.sendMessage(message),
    download(filename, type, text) {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      // Revoked later: revoking straight away can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
    },
    confirm: (question) => window.confirm(question),
  });
}

const DOWNLOAD_URL_TTL_MS = 60_000;

if (typeof document !== 'undefined' && typeof location !== 'undefined') main();
