import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthorizeUrl, type AuthorizeRequest } from '../src/authorize.ts';
import {
  CSV_HEADER,
  DECISION_TEXT,
  LEDGER_DECISIONS,
  MAX_FIELD_CHARS,
  MAX_LEDGER_CHARS,
  MAX_LEDGER_ENTRIES,
  MAX_RECORDED_SCOPES,
  MIN_PASSPHRASE_LENGTH,
  PBKDF2_ITERATIONS,
  WrongPassphraseError,
  appendSealed,
  createLedgerKey,
  ledgerCsv,
  ledgerEntry,
  openLedger,
  parseLedgerKey,
  sealEntry,
  type LedgerEntry,
  type LedgerKey,
  type SealedEntry,
} from '../src/ledger.ts';

const API = 'https://www.googleapis.com/auth/';
const PASS_A = 'alpha alpha alpha';
const PASS_B = 'bravo bravo bravo';
// Tests only: real keys always use PBKDF2_ITERATIONS. Keeps the suite fast.
const FAST = { iterations: 1_000 };
const T0 = Date.UTC(2026, 9, 25, 9, 30, 0);
const ROADMAP_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20openid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code';

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

const THREE: LedgerEntry[] = [
  entry(),
  entry({
    at: new Date(T0 + 60_000).toISOString(),
    client_id: 'notes.apps.googleusercontent.com',
    redirect_uri: 'https://notes.example/auth',
    scopes: ['openid', 'email', 'profile'],
    rating: 'low',
    decision: 'allowed',
  }),
  entry({
    at: new Date(T0 + 120_000).toISOString(),
    client_id: 'files.apps.googleusercontent.com',
    redirect_uri: null,
    scopes: [`${API}drive`],
    rating: 'high',
    decision: 'always-block',
  }),
];

async function sealAll(key: Pick<LedgerKey, 'publicKey'>, entries: LedgerEntry[]): Promise<SealedEntry[]> {
  const sealed: SealedEntry[] = [];
  for (const e of entries) sealed.push(await sealEntry(key, e));
  return sealed;
}

const bytes = (b64: string) => Buffer.from(b64, 'base64');

// RFC 4180, enough to check what a spreadsheet would read back.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------

describe('M3 exit criterion: a ledger written with passphrase A decrypts with A and fails with B', () => {
  it('opens with A and rejects B, using the real key-stretching settings', async () => {
    const key = await createLedgerKey(PASS_A);
    assert.equal(key.kdf.iterations, PBKDF2_ITERATIONS);
    const sealed = await sealAll(key, THREE);

    assert.deepEqual(await openLedger(key, PASS_A, sealed), { entries: THREE, unreadable: 0 });
    await assert.rejects(openLedger(key, PASS_B, sealed), WrongPassphraseError);
  });

  it('says so in words a person can act on', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    await assert.rejects(openLedger(key, PASS_B, []), (error: unknown) => {
      assert.ok(error instanceof WrongPassphraseError);
      assert.match(error.message, /passphrase doesn't open this ledger/);
      return true;
    });
  });

  it('cannot open entries sealed to a different ledger, even with the same passphrase', async () => {
    const first = await createLedgerKey(PASS_A, FAST);
    const second = await createLedgerKey(PASS_A, FAST);
    const sealed = await sealAll(first, THREE);
    assert.deepEqual(await openLedger(second, PASS_A, sealed), { entries: [], unreadable: 3 });
  });

  it('opens with the same passphrase however the keyboard composed its accents', async () => {
    // Built from code points so no editor can quietly normalise one form into the other.
    const word = `caf${String.fromCodePoint(0xe9)}`;
    const composed = [word, word, word].join(' ');
    const decomposed = composed.normalize('NFD');
    assert.notEqual(composed, decomposed);
    const key = await createLedgerKey(decomposed, FAST);
    const sealed = await sealAll(key, [entry()]);
    assert.equal((await openLedger(key, composed, sealed)).entries.length, 1);
  });
});

describe('createLedgerKey and parseLedgerKey', () => {
  it('stretches the passphrase with PBKDF2-SHA-256 at OWASP’s 600,000 iterations by default', () => {
    assert.ok(PBKDF2_ITERATIONS >= 600_000);
  });

  it('stores only a salt, a public key and the private key wrapped by the passphrase', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    assert.equal(key.v, 1);
    assert.deepEqual({ ...key.kdf, salt: undefined }, { name: 'PBKDF2', hash: 'SHA-256', iterations: 1_000, salt: undefined });
    assert.equal(bytes(key.kdf.salt).length, 16);
    assert.equal(bytes(key.publicKey).length, 65, 'uncompressed P-256 point');
    assert.equal(bytes(key.publicKey)[0], 0x04);
    assert.equal(bytes(key.iv).length, 12);
    assert.ok(bytes(key.wrappedPrivateKey).length > 100, 'a wrapped pkcs8 key plus its tag');
    const json = JSON.stringify(key);
    assert.ok(!json.includes(PASS_A) && !json.includes('alpha'), 'the passphrase is never stored');
  });

  it('makes a fresh salt and key pair every time', async () => {
    const one = await createLedgerKey(PASS_A, FAST);
    const two = await createLedgerKey(PASS_A, FAST);
    assert.notEqual(one.kdf.salt, two.kdf.salt);
    assert.notEqual(one.publicKey, two.publicKey);
    assert.notEqual(one.wrappedPrivateKey, two.wrappedPrivateKey);
  });

  it(`refuses passphrases shorter than ${MIN_PASSPHRASE_LENGTH} characters`, async () => {
    assert.equal(MIN_PASSPHRASE_LENGTH, 8);
    await assert.rejects(createLedgerKey('seven77', FAST), /at least 8 characters/);
    await assert.rejects(createLedgerKey(42 as unknown as string, FAST), /at least 8 characters/);
    await createLedgerKey('eight888', FAST);
  });

  it('round-trips a key through JSON storage', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    assert.deepEqual(parseLedgerKey(JSON.parse(JSON.stringify(key))), key);
  });

  it('rejects anything that is not a well-formed key', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    const b64 = (n: number, first = 0) => Buffer.from([first, ...new Array(n - 1).fill(7)]).toString('base64');
    const variants: unknown[] = [
      null,
      'key',
      [],
      {},
      { ...key, v: 2 },
      { ...key, kdf: undefined },
      { ...key, kdf: { ...key.kdf, name: 'scrypt' } },
      { ...key, kdf: { ...key.kdf, hash: 'SHA-1' } },
      { ...key, kdf: { ...key.kdf, iterations: 999 } },
      { ...key, kdf: { ...key.kdf, iterations: 10_000_001 } },
      { ...key, kdf: { ...key.kdf, iterations: 1500.5 } },
      { ...key, kdf: { ...key.kdf, iterations: '600000' } },
      { ...key, kdf: { ...key.kdf, salt: 'not base64!' } },
      { ...key, kdf: { ...key.kdf, salt: b64(8) } },
      { ...key, publicKey: b64(64, 4) },
      { ...key, publicKey: b64(65, 2) },
      { ...key, publicKey: 42 },
      { ...key, iv: b64(16) },
      { ...key, wrappedPrivateKey: b64(16) },
      { ...key, wrappedPrivateKey: undefined },
    ];
    for (const variant of variants) assert.equal(parseLedgerKey(variant), null, JSON.stringify(variant));
  });
});

describe('sealEntry and openLedger', () => {
  it('keeps no readable trace of the entry in what it stores', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    const sealed = await sealEntry(key, entry());
    assert.deepEqual(Object.keys(sealed).sort(), ['ct', 'epk', 'iv', 'v']);
    const json = JSON.stringify(sealed);
    for (const plain of ['abc.apps', 'mail.google.com', 'app.example', 'once']) assert.ok(!json.includes(plain), plain);
    assert.equal(bytes(sealed.epk).length, 65);
    assert.equal(bytes(sealed.iv).length, 12);
  });

  it('seals the same entry differently every time', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    const [a, b] = [await sealEntry(key, entry()), await sealEntry(key, entry())];
    assert.notEqual(a.epk, b.epk);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  it('counts a tampered entry as unreadable and still opens the rest', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    const sealed = await sealAll(key, THREE);
    const ct = bytes(sealed[1].ct);
    ct[0] ^= 1;
    sealed[1] = { ...sealed[1], ct: ct.toString('base64') };
    assert.deepEqual(await openLedger(key, PASS_A, sealed), { entries: [THREE[0], THREE[2]], unreadable: 1 });
  });

  it('copes with whatever storage holds instead of a list of sealed entries', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    for (const stored of [undefined, null, 'ledger', {}]) {
      assert.deepEqual(await openLedger(key, PASS_A, stored), { entries: [], unreadable: 0 }, String(stored));
    }
    const good = await sealEntry(key, entry());
    const junk = [null, 1, {}, { v: 1, epk: 'x', iv: 'y' }, { ...good, epk: '!!!' }];
    assert.deepEqual(await openLedger(key, PASS_A, [...junk, good]), { entries: [entry()], unreadable: junk.length });
  });

  it('rejects a record that decrypts but is not a ledger entry', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    const notEntries = [
      { hello: 'world' },
      entry({ decision: 'maybe' as LedgerEntry['decision'] }),
      entry({ rating: 'extreme' as LedgerEntry['rating'] }),
      entry({ at: 'yesterday' }),
      entry({ scopes: [1] as unknown as string[] }),
      entry({ client_id: 5 as unknown as string }),
      entry({ redirect_uri: [] as unknown as string }),
    ];
    const sealed = await sealAll(key, notEntries as LedgerEntry[]);
    assert.deepEqual(await openLedger(key, PASS_A, sealed), { entries: [], unreadable: notEntries.length });
  });

  it('opens an entry for an app it could not identify', async () => {
    const key = await createLedgerKey(PASS_A, FAST);
    const unidentified = entry({ client_id: null, decision: 'back' });
    assert.deepEqual((await openLedger(key, PASS_A, await sealAll(key, [unidentified]))).entries, [unidentified]);
  });
});

describe('ledgerEntry: what is recorded for a decision', () => {
  it('records the time, app, redirect, scopes, rating and decision', () => {
    const request = parseAuthorizeUrl(ROADMAP_URL) as AuthorizeRequest;
    assert.deepEqual(ledgerEntry(T0, request, 'once'), {
      at: '2026-10-25T09:30:00.000Z',
      client_id: 'abc.apps.googleusercontent.com',
      redirect_uri: 'https://app.example/cb',
      scopes: ['https://mail.google.com/', 'openid'],
      rating: 'high',
      decision: 'once',
    });
  });

  it('keeps scopes in request order and records an unidentified app as null', () => {
    const request: AuthorizeRequest = { client_id: null, redirect_uri: null, scopes: ['openid', `${API}drive`] };
    const recorded = ledgerEntry(T0, request, 'back');
    assert.deepEqual(recorded.scopes, ['openid', `${API}drive`]);
    assert.equal(recorded.client_id, null);
    assert.equal(recorded.redirect_uri, null);
    assert.equal(recorded.rating, 'high');
  });

  it('clips oversized text so a hostile URL cannot fill storage', () => {
    const long = `https://app.example/${'x'.repeat(5_000)}`;
    const request: AuthorizeRequest = { client_id: 'c'.repeat(5_000), redirect_uri: long, scopes: [`${API}${'s'.repeat(5_000)}`] };
    const recorded = ledgerEntry(T0, request, 'allowed');
    for (const text of [recorded.client_id ?? '', recorded.redirect_uri ?? '', recorded.scopes[0]]) {
      assert.equal(text.length, MAX_FIELD_CHARS);
      assert.ok(text.endsWith('…'));
    }
  });

  it('keeps the riskiest scopes when there are too many, and rates the whole request', () => {
    const padding = Array.from({ length: 60 }, (_, i) => `${API}padding${i}`);
    const request: AuthorizeRequest = { client_id: 'a', redirect_uri: null, scopes: [...padding, 'https://mail.google.com/'] };
    const recorded = ledgerEntry(T0, request, 'once');
    assert.equal(recorded.scopes.length, MAX_RECORDED_SCOPES);
    assert.equal(recorded.scopes[0], 'https://mail.google.com/');
    assert.equal(recorded.rating, 'high');
  });
});

describe('appendSealed: the stored ledger stays bounded', () => {
  const fake = (n: number, size = 1): SealedEntry => ({ v: 1, epk: 'e', iv: 'i', ct: `${n}`.padEnd(size, '.') });

  it('adds the new entry at the end', () => {
    assert.deepEqual(appendSealed([fake(1)], fake(2)), [fake(1), fake(2)]);
    assert.deepEqual(appendSealed(undefined, fake(1)), [fake(1)]);
    assert.deepEqual(appendSealed('garbage', fake(1)), [fake(1)]);
  });

  it('drops records that are not sealed entries', () => {
    assert.deepEqual(appendSealed([fake(1), null, 'x', { v: 2, epk: 'e', iv: 'i', ct: 'c' }, { v: 1 }], fake(2)), [fake(1), fake(2)]);
  });

  it(`drops the oldest beyond ${MAX_LEDGER_ENTRIES} entries`, () => {
    const full = Array.from({ length: MAX_LEDGER_ENTRIES }, (_, i) => fake(i));
    const next = appendSealed(full, fake(-1));
    assert.equal(next.length, MAX_LEDGER_ENTRIES);
    assert.deepEqual(next[0], fake(1));
    assert.deepEqual(next.at(-1), fake(-1));
    assert.equal(full.length, MAX_LEDGER_ENTRIES, 'does not change its input');
  });

  it(`drops the oldest once the sealed text passes ${MAX_LEDGER_CHARS} characters`, () => {
    const size = Math.floor(MAX_LEDGER_CHARS / 4);
    const big = [fake(1, size), fake(2, size), fake(3, size)];
    const next = appendSealed(big, fake(4, size));
    const total = next.reduce((n, e) => n + e.epk.length + e.iv.length + e.ct.length, 0);
    assert.ok(total <= MAX_LEDGER_CHARS, `${total}`);
    assert.deepEqual(next.at(-1), fake(4, size));
    assert.ok(next.length < 4);
  });
});

describe('M3 exit criterion: exporting 3 entries yields a CSV with a header plus 3 rows', () => {
  it('writes a header and one row per entry', () => {
    const csv = ledgerCsv(THREE);
    const rows = parseCsv(csv);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], [...CSV_HEADER]);
    for (const row of rows.slice(1)) assert.equal(row.length, CSV_HEADER.length);
    assert.equal(csv.split('\r\n').filter((line) => line !== '').length, 4);
  });
});

describe('ledgerCsv: what the spreadsheet shows', () => {
  it('has the documented columns', () => {
    assert.deepEqual([...CSV_HEADER], ['date (UTC)', 'app', 'decision', 'risk', 'permissions', 'scopes', 'redirect_uri']);
  });

  it('writes each entry oldest first, with a UTC date, plain-English decision and permissions', () => {
    const rows = parseCsv(ledgerCsv(THREE));
    assert.deepEqual(rows[1], [
      '2026-10-25 09:30:00',
      'abc.apps.googleusercontent.com',
      'Continued once',
      'high',
      'read, send, delete and manage all your email; confirm who you are when you sign in',
      'https://mail.google.com/ openid',
      'https://app.example/cb',
    ]);
    assert.deepEqual(rows.map((r) => r[2]).slice(1), ['Continued once', 'Allowed (not high risk)', 'Always blocked']);
    assert.equal(rows[3][6], '', 'no redirect stated');
  });

  it('names an unidentified app', () => {
    const rows = parseCsv(ledgerCsv([entry({ client_id: null })]));
    assert.match(rows[1][1], /more than one app/);
  });

  it('quotes commas, quotes and line breaks so they survive a round trip', () => {
    const tricky = 'a,b "c"\r\nd';
    const rows = parseCsv(ledgerCsv([entry({ client_id: tricky, redirect_uri: 'https://x.example/?a=1,2' })]));
    assert.equal(rows.length, 2);
    assert.equal(rows[1][1], tricky);
    assert.equal(rows[1][6], 'https://x.example/?a=1,2');
  });

  it('stops a spreadsheet from running app-supplied text as a formula', () => {
    const rows = parseCsv(
      ledgerCsv([entry({ client_id: '=HYPERLINK("https://evil.example","open")', redirect_uri: '@SUM(1)', scopes: ['+cmd', '-2+3'] })]),
    );
    assert.equal(rows[1][1], `'=HYPERLINK("https://evil.example","open")`);
    assert.equal(rows[1][6], `'@SUM(1)`);
    assert.ok(rows[1][5].startsWith(`'+cmd`), rows[1][5]);
    const tabbed = parseCsv(ledgerCsv([entry({ client_id: '\tx' })]));
    assert.equal(tabbed[1][1], `'\tx`);
  });

  it('writes only the header for an empty ledger', () => {
    assert.deepEqual(parseCsv(ledgerCsv([])), [[...CSV_HEADER]]);
  });

  it('has words for every decision', () => {
    assert.deepEqual([...LEDGER_DECISIONS].sort(), ['allowed', 'allowlisted', 'always-allow', 'always-block', 'back', 'once']);
    for (const decision of LEDGER_DECISIONS) {
      assert.ok(DECISION_TEXT[decision].length > 3, decision);
      const rows = parseCsv(ledgerCsv([entry({ decision })]));
      assert.equal(rows[1][2], DECISION_TEXT[decision]);
    }
  });
});
