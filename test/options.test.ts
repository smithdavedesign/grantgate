import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OptionsMessage, Reply } from '../src/extension/background.ts';
import { CSV_FILENAME, GOOGLE_PERMISSIONS_URL, POLICY_FILENAME, runOptions, type OptionsEnv } from '../src/extension/options.ts';
import {
  DECISION_TEXT,
  createLedgerKey,
  ledgerCsv,
  openLedger,
  parseLedgerKey,
  sealEntry,
  type LedgerEntry,
  type SealedEntry,
} from '../src/ledger.ts';
import { MAX_POLICY_FILE_CHARS, mergePolicies, parsePolicyFile, policyFile, removeFromPolicy } from '../src/policy.ts';
import { FakeElement, all, byAction, byName, fakeDocument, hasAction, tags, type FakeFile } from './helpers/fake-dom.ts';

const API = 'https://www.googleapis.com/auth/';
const PASS_A = 'alpha alpha alpha';
const PASS_B = 'bravo bravo bravo';
// Tests only: the real page uses PBKDF2_ITERATIONS.
const FAST = { iterations: 1_000 };
const ONE = 'one.apps.googleusercontent.com';
const TWO = 'two.apps.googleusercontent.com';
const T0 = Date.UTC(2026, 9, 25, 9, 30, 0);

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    at: new Date(T0).toISOString(),
    client_id: 'abc.apps.googleusercontent.com',
    redirect_uri: 'https://app.example/cb',
    scopes: ['https://mail.google.com/', 'openid'],
    rating: 'high',
    decision: 'once',
    ...overrides,
  };
}

// Oldest first, as the worker appends them.
const THREE: LedgerEntry[] = [
  entry(),
  entry({ at: new Date(T0 + 60_000).toISOString(), client_id: 'notes.apps.googleusercontent.com', scopes: ['openid'], rating: 'low', decision: 'allowed' }),
  entry({ at: new Date(T0 + 120_000).toISOString(), client_id: 'files.apps.googleusercontent.com', scopes: [`${API}drive`], decision: 'always-block' }),
];

async function sealedLedger(entries: LedgerEntry[] = THREE) {
  const key = await createLedgerKey(PASS_A, FAST);
  const ledger: SealedEntry[] = [];
  for (const e of entries) ledger.push(await sealEntry(key, e));
  return { ledgerKey: key, ledger };
}

function file(name: string, text: string, size = text.length): FakeFile & { reads: number } {
  const f = {
    name,
    size,
    reads: 0,
    async text() {
      f.reads += 1;
      return text;
    },
  };
  return f;
}

// The page wired to fakes. `send` behaves like the worker (using the same pure
// functions) unless the test queues its own replies.
function harness(options: { stored?: Record<string, unknown>; replies?: (Reply | Error)[]; confirm?: boolean; failLoad?: boolean } = {}) {
  const root = new FakeElement('main');
  let stored: Record<string, unknown> = structuredClone(options.stored ?? {});
  const sent: OptionsMessage[] = [];
  const downloads: { filename: string; type: string; text: string }[] = [];
  const questions: string[] = [];
  const replies = [...(options.replies ?? [])];

  function worker(message: OptionsMessage): Reply {
    switch (message.type) {
      case 'ledger-setup':
        stored = { ...stored, ledgerKey: message.key, ledger: [] };
        break;
      case 'ledger-reset':
        stored = { ...stored, ledgerKey: null, ledger: [] };
        break;
      case 'import-policy': {
        const parsed = parsePolicyFile(message.text);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        stored = { ...stored, policy: mergePolicies(stored.policy, parsed.policy) };
        break;
      }
      case 'remove-app':
        stored = { ...stored, policy: removeFromPolicy(stored.policy, message.list, message.client_id) };
        break;
    }
    return { ok: true, action: 'saved' };
  }

  const env: OptionsEnv = {
    doc: fakeDocument as unknown as Document,
    root: root as unknown as HTMLElement,
    async load() {
      await Promise.resolve();
      if (options.failLoad) throw new Error('storage is unavailable');
      return structuredClone(stored);
    },
    async send(message) {
      sent.push(structuredClone(message));
      await Promise.resolve();
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? worker(message);
    },
    download: (filename, type, text) => void downloads.push({ filename, type, text }),
    confirm(question) {
      questions.push(question);
      return options.confirm ?? true;
    },
    iterations: FAST.iterations,
  };
  return {
    env,
    root,
    sent,
    downloads,
    questions,
    get stored() {
      return stored;
    },
    text: () => root.textContent,
  };
}

async function opened(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await runOptions(h.env);
  return h;
}

async function submit(root: FakeElement, action: string, fields: Record<string, string>) {
  const form = byAction(root, action);
  for (const [name, value] of Object.entries(fields)) byName(form, name).value = value;
  return form.dispatch('submit');
}

async function chooseFile(root: FakeElement, f: FakeFile) {
  const input = byName(root, 'policy-file');
  input.files = [f];
  await input.dispatch('change');
  return input;
}

const tableRows = (root: FakeElement) => all(root, (el) => el.tagName === 'TR').slice(1);

// ---------------------------------------------------------------------------

describe('options page: setting up the ledger', () => {
  it('asks for a passphrase when there is no ledger yet, explaining it cannot be recovered', async () => {
    const h = await opened();
    assert.match(h.text(), /Choose a passphrase/);
    assert.match(h.text(), /can't be recovered/);
    const form = byAction(h.root, 'setup');
    for (const name of ['passphrase', 'confirm']) {
      assert.equal(byName(form, name).type, 'password');
    }
    assert.equal(hasAction(h.root, 'unlock'), false);
  });

  it('starts recording: sends a key that opens with the passphrase, never the passphrase itself', async () => {
    const h = await opened();
    const event = await submit(h.root, 'setup', { passphrase: PASS_A, confirm: PASS_A });
    assert.equal(event.defaultPrevented, true, 'the form does not navigate');
    assert.equal(h.sent.length, 1);
    const [message] = h.sent;
    assert.equal(message.type, 'ledger-setup');
    assert.ok(!JSON.stringify(h.sent).includes(PASS_A), 'the passphrase stays in the page');

    const key = parseLedgerKey(message.type === 'ledger-setup' ? message.key : null);
    assert.ok(key);
    const sealed = [await sealEntry(key, entry())];
    assert.equal((await openLedger(key, PASS_A, sealed)).entries.length, 1);
    await assert.rejects(openLedger(key, PASS_B, sealed));

    assert.match(h.text(), /Recording started/);
    assert.ok(hasAction(h.root, 'unlock'), 'now shows the locked ledger');
  });

  it('refuses passphrases that do not match or are too short, sending nothing', async () => {
    const h = await opened();
    await submit(h.root, 'setup', { passphrase: PASS_A, confirm: PASS_B });
    assert.match(h.text(), /don't match/);
    await submit(h.root, 'setup', { passphrase: 'short', confirm: 'short' });
    assert.match(h.text(), /at least 8 characters/);
    assert.deepEqual(h.sent, []);
    assert.ok(hasAction(h.root, 'setup'));
  });

  it('ignores a second submit while the first is still working', async () => {
    const h = await opened();
    await Promise.all([
      submit(h.root, 'setup', { passphrase: PASS_A, confirm: PASS_A }),
      submit(h.root, 'setup', { passphrase: PASS_A, confirm: PASS_A }),
    ]);
    assert.equal(h.sent.length, 1);
  });

  it('shows the worker’s error when setup fails', async () => {
    const h = await opened({ replies: [{ ok: false, error: 'A ledger already exists. Erase it before starting a new one.' }] });
    await submit(h.root, 'setup', { passphrase: PASS_A, confirm: PASS_A });
    assert.match(h.text(), /already exists/);
    assert.ok(hasAction(h.root, 'setup'));
  });
});

describe('options page: reading the ledger', () => {
  it('shows how many sign-ins are recorded while locked, and nothing else', async () => {
    const h = await opened({ stored: await sealedLedger() });
    assert.match(h.text(), /3 sign-ins recorded/);
    assert.ok(!h.text().includes('abc.apps'));
    assert.equal(byName(byAction(h.root, 'unlock'), 'passphrase').type, 'password');
    assert.deepEqual(tags(h.root, 'table'), []);
  });

  it('says so when the passphrase is wrong, and shows no entries', async () => {
    const h = await opened({ stored: await sealedLedger() });
    await submit(h.root, 'unlock', { passphrase: PASS_B });
    assert.match(h.text(), /passphrase doesn't open this ledger/);
    assert.deepEqual(tags(h.root, 'table'), []);
    assert.ok(!h.text().includes('abc.apps'));
  });

  it('M3 exit criterion (page): opens with passphrase A, newest first, in plain English', async () => {
    const h = await opened({ stored: await sealedLedger() });
    const event = await submit(h.root, 'unlock', { passphrase: PASS_A });
    assert.equal(event.defaultPrevented, true);
    const rows = tableRows(h.root);
    assert.equal(rows.length, 3);
    assert.match(rows[0].textContent, /files\.apps/);
    assert.match(rows[0].textContent, new RegExp(DECISION_TEXT['always-block']));
    assert.match(rows[2].textContent, /abc\.apps/);
    assert.match(rows[2].textContent, /Continued once/);
    assert.match(rows[2].textContent, /High risk/);
    assert.match(rows[2].textContent, /read, send, delete and manage all your email/);
    assert.match(rows[1].textContent, /Low risk/);
  });

  it('M3 exit criterion (page): exports the unlocked ledger as a CSV with a header and one row per entry', async () => {
    const h = await opened({ stored: await sealedLedger() });
    assert.equal(hasAction(h.root, 'export-csv'), false, 'nothing to export while locked');
    await submit(h.root, 'unlock', { passphrase: PASS_A });
    await byAction(h.root, 'export-csv').click();
    assert.equal(h.downloads.length, 1);
    const [download] = h.downloads;
    assert.equal(download.filename, CSV_FILENAME);
    assert.equal(CSV_FILENAME, 'grantgate-ledger.csv');
    assert.match(download.type, /^text\/csv/);
    assert.equal(download.text, ledgerCsv(THREE));
    assert.equal(download.text.trimEnd().split('\r\n').length, 4, 'a header plus 3 rows');
  });

  it('says how many entries could not be read', async () => {
    const stored = await sealedLedger();
    stored.ledger[1] = { ...stored.ledger[1], ct: stored.ledger[0].ct };
    const h = await opened({ stored });
    await submit(h.root, 'unlock', { passphrase: PASS_A });
    assert.equal(tableRows(h.root).length, 2);
    assert.match(h.text(), /1 entry couldn't be read/);
  });

  it('says when nothing has been recorded yet', async () => {
    const h = await opened({ stored: await sealedLedger([]) });
    assert.match(h.text(), /Nothing recorded yet/);
    await submit(h.root, 'unlock', { passphrase: PASS_A });
    assert.match(h.text(), /Nothing recorded yet/);
    assert.deepEqual(tags(h.root, 'table'), []);
  });

  it('locks again, forgetting the entries', async () => {
    const h = await opened({ stored: await sealedLedger() });
    await submit(h.root, 'unlock', { passphrase: PASS_A });
    await byAction(h.root, 'lock').click();
    assert.deepEqual(tags(h.root, 'table'), []);
    assert.ok(!h.text().includes('abc.apps'));
    assert.ok(hasAction(h.root, 'unlock'));
  });

  it('erases the ledger only after the user confirms', async () => {
    const stored = await sealedLedger();
    const no = await opened({ stored, confirm: false });
    await byAction(no.root, 'erase').click();
    assert.match(no.questions[0], /can't be undone/);
    assert.deepEqual(no.sent, []);

    const yes = await opened({ stored, confirm: true });
    await byAction(yes.root, 'erase').click();
    assert.deepEqual(yes.sent, [{ type: 'ledger-reset' }]);
    assert.ok(hasAction(yes.root, 'setup'), 'asks for a new passphrase');
    assert.match(yes.text(), /erased/);
  });
});

describe('options page: allowed and blocked apps', () => {
  it('shows both lists with a way to remove each app', async () => {
    const h = await opened({ stored: { policy: { allow: [ONE], deny: [TWO] } } });
    assert.match(h.text(), /Always allowed/);
    assert.match(h.text(), /Always blocked/);
    const removes = all(h.root, (el) => el.dataset.action === 'remove');
    assert.deepEqual(removes.map((b) => [b.dataset.list, b.dataset.id]), [['allow', ONE], ['deny', TWO]]);

    await removes[1].click();
    assert.deepEqual(h.sent, [{ type: 'remove-app', list: 'deny', client_id: TWO }]);
    assert.deepEqual(
      all(h.root, (el) => el.dataset.action === 'remove').map((b) => b.dataset.id),
      [ONE],
      'the page shows the lists as stored after the change',
    );
    assert.match(h.text(), new RegExp(`Removed ${TWO.replace(/\./g, '\\.')} from blocked apps`));
  });

  it('says when a list is empty', async () => {
    const h = await opened();
    assert.equal((h.text().match(/None yet/g) ?? []).length, 2);
  });

  it('exports the lists as a policy file', async () => {
    const policy = { allow: [ONE], deny: [TWO] };
    const h = await opened({ stored: { policy } });
    await byAction(h.root, 'export-policy').click();
    assert.deepEqual(h.downloads, [{ filename: POLICY_FILENAME, type: 'application/json', text: policyFile(policy) }]);
    assert.equal(POLICY_FILENAME, 'grantgate-policy.json');
  });

  it('M3 exit criterion (page): imports a policy file with 2 client_ids after the user confirms', async () => {
    const h = await opened();
    const text = JSON.stringify({ allow: [ONE, TWO] });
    const input = await chooseFile(h.root, file('office.json', text));
    assert.equal(h.questions.length, 1);
    assert.match(h.questions[0], /office\.json/);
    assert.match(h.questions[0], /allows 2 apps and blocks 0/);
    assert.deepEqual(h.sent, [{ type: 'import-policy', text }]);
    assert.match(h.text(), /Imported/);
    assert.ok(h.text().includes(ONE) && h.text().includes(TWO));
    assert.equal(input.value, '', 'the same file can be picked again');
  });

  it('does not import when the user cancels', async () => {
    const h = await opened({ confirm: false });
    await chooseFile(h.root, file('office.json', JSON.stringify({ allow: [ONE] })));
    assert.deepEqual(h.sent, []);
    assert.match(h.text(), /Nothing imported/);
  });

  it('reports a broken policy file without asking or sending', async () => {
    const h = await opened();
    await chooseFile(h.root, file('notes.txt', 'remember to buy milk'));
    assert.deepEqual(h.questions, []);
    assert.deepEqual(h.sent, []);
    assert.match(h.text(), /isn't valid JSON/);
  });

  it('refuses a file too big to be a policy without reading it', async () => {
    const h = await opened();
    const huge = file('huge.json', '{}', MAX_POLICY_FILE_CHARS + 1);
    await chooseFile(h.root, huge);
    assert.equal(huge.reads, 0);
    assert.deepEqual(h.sent, []);
    assert.match(h.text(), /too big/);
  });

  it('does nothing when the file picker is closed without a file', async () => {
    const h = await opened();
    const input = byName(h.root, 'policy-file');
    input.files = [];
    await input.dispatch('change');
    assert.deepEqual(h.sent, []);
  });

  it('shows the worker’s error for an import', async () => {
    const h = await opened({ replies: [{ ok: false, error: 'Your lists would hold more than 10000 apps.' }] });
    await chooseFile(h.root, file('office.json', JSON.stringify({ allow: [ONE] })));
    assert.match(h.text(), /more than 10000 apps/);
  });
});

describe('options page: the rest', () => {
  it('links to Google’s own list of apps with access, in a new tab', async () => {
    const h = await opened();
    const links = tags(h.root, 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, GOOGLE_PERMISSIONS_URL);
    assert.equal(GOOGLE_PERMISSIONS_URL, 'https://myaccount.google.com/permissions');
    assert.equal(links[0].target, '_blank');
    assert.match(links[0].rel, /noopener/);
    assert.match(h.text(), /only sees sign-ins in this browser/);
  });

  it('shows app IDs, scopes and redirects as text, never as markup', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const stored = {
      ...(await sealedLedger([entry({ client_id: hostile, scopes: [`<script>alert(1)</script>`], redirect_uri: 'javascript:alert(1)' })])),
      policy: { allow: [hostile], deny: [] },
    };
    const h = await opened({ stored });
    await submit(h.root, 'unlock', { passphrase: PASS_A });
    assert.deepEqual(all(h.root, (el) => ['IMG', 'SCRIPT'].includes(el.tagName)), []);
    assert.equal(tags(h.root, 'a').length, 1, 'only the Google link');
    assert.ok(h.text().includes(hostile));
    assert.ok(h.text().includes('<script>alert(1)</script>'));
  });

  it('says so when it cannot read its settings', async () => {
    const h = await opened({ failLoad: true });
    assert.match(h.text(), /couldn't read its settings/);
  });

  it('says so when the background worker cannot be reached', async () => {
    const h = await opened({ replies: [new Error('Could not establish connection')] });
    await submit(h.root, 'setup', { passphrase: PASS_A, confirm: PASS_A });
    assert.match(h.text(), /couldn't reach its background worker/);
  });

  it('disables the controls while it works', async () => {
    const h = harness();
    await runOptions(h.env);
    const pending = submit(h.root, 'setup', { passphrase: PASS_A, confirm: PASS_A });
    const controls = all(h.root, (el) => el.tagName === 'BUTTON' || el.tagName === 'INPUT');
    assert.ok(controls.length > 0);
    assert.ok(controls.every((el) => el.disabled), 'every control is disabled while working');
    await pending;
    assert.ok(all(h.root, (el) => el.tagName === 'BUTTON').every((el) => !el.disabled));
  });
});
