import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HONEYPOT_FIELD,
  INTERVIEW_QUERY,
  JOIN_SQL,
  LEAVE_SQL,
  MAX_EMAIL_LENGTH,
  ROLES,
  TEAM_SIZES,
  WAITLIST_SCHEMA,
  memoryStore,
  normalizeEmail,
  parseWaitlistForm,
  sqlStore,
  type SqlClient,
} from '../src/site/waitlist.ts';

/** A fake Neon client: records every query and can fail on demand. */
function fakeSql(fail: (text: string, call: number) => boolean = () => false) {
  const calls: { text: string; params: unknown[] }[] = [];
  const sql: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      if (fail(text, calls.length)) throw new Error('connection reset');
      return [];
    },
  };
  return { sql, calls };
}

describe('normalizeEmail', () => {
  it('trims and lower-cases a valid address', () => {
    assert.equal(normalizeEmail('  Owner@Acme-Dental.Example '), 'owner@acme-dental.example');
    assert.equal(normalizeEmail('first.last+grantgate@mail.example.co.uk'), 'first.last+grantgate@mail.example.co.uk');
  });

  it('rejects anything that is not one plausible address', () => {
    for (const bad of [
      '',
      '   ',
      'owner',
      'owner@',
      '@acme.example',
      'owner@localhost',
      'owner@acme',
      'own er@acme.example',
      'owner@@acme.example',
      'owner@acme@other.example',
      '<script>@acme.example',
      'owner\n@acme.example',
      'owner\u0000@acme.example',
      `owner@acme.example${String.fromCharCode(0x202e)}`,
      'owner@-acme.example',
      'owner@acme..example',
      'owner@acme.example.',
    ]) {
      assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
    }
  });

  it('rejects addresses longer than the limit, and non-strings', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example`;
    const long = `${local}@${domain}`;
    assert.ok(long.length > MAX_EMAIL_LENGTH);
    assert.equal(normalizeEmail(long), null);
    for (const value of [undefined, null, 42, ['owner@acme.example'], { email: 'owner@acme.example' }]) {
      assert.equal(normalizeEmail(value), null);
    }
  });
});

describe('parseWaitlistForm', () => {
  it('reads a full sign-up from the form fields', () => {
    assert.deepEqual(
      parseWaitlistForm({ action: 'join', email: 'Owner@Acme.example', role: 'owner', team_size: '5-50', interview: 'yes', [HONEYPOT_FIELD]: '' }),
      { ok: true, action: 'join', bot: false, signup: { email: 'owner@acme.example', role: 'owner', teamSize: '5-50', interview: true } },
    );
  });

  it('defaults to joining, with every optional answer blank', () => {
    assert.deepEqual(parseWaitlistForm({ email: 'owner@acme.example' }), {
      ok: true,
      action: 'join',
      bot: false,
      signup: { email: 'owner@acme.example', role: null, teamSize: null, interview: false },
    });
  });

  it('accepts every role and team size the form offers', () => {
    for (const role of ROLES) {
      const parsed = parseWaitlistForm({ email: 'a@b.example', role });
      assert.ok(parsed.ok && parsed.action === 'join' && parsed.signup.role === role, role);
    }
    for (const size of TEAM_SIZES) {
      const parsed = parseWaitlistForm({ email: 'a@b.example', team_size: size });
      assert.ok(parsed.ok && parsed.action === 'join' && parsed.signup.teamSize === size, size);
    }
  });

  it('stores unknown or malformed optional answers as blank instead of refusing the sign-up', () => {
    const parsed = parseWaitlistForm({ email: 'a@b.example', role: 'ceo', team_size: ['5-50'], interview: 'maybe' });
    assert.deepEqual(parsed, { ok: true, action: 'join', bot: false, signup: { email: 'a@b.example', role: null, teamSize: null, interview: false } });
  });

  it('treats each way a browser or script says "ticked" as an interview opt-in', () => {
    for (const ticked of ['yes', 'on', 'true', true]) {
      const parsed = parseWaitlistForm({ email: 'a@b.example', interview: ticked });
      assert.ok(parsed.ok && parsed.action === 'join' && parsed.signup.interview, String(ticked));
    }
    for (const unticked of ['', 'no', 'false', false, undefined, 1]) {
      const parsed = parseWaitlistForm({ email: 'a@b.example', interview: unticked });
      assert.ok(parsed.ok && parsed.action === 'join' && !parsed.signup.interview, String(unticked));
    }
  });

  it('reads a removal request', () => {
    assert.deepEqual(parseWaitlistForm({ action: 'leave', email: ' Owner@Acme.example' }), {
      ok: true,
      action: 'leave',
      bot: false,
      email: 'owner@acme.example',
    });
  });

  it('flags a filled-in honeypot as a bot, for both actions', () => {
    const join = parseWaitlistForm({ email: 'a@b.example', [HONEYPOT_FIELD]: 'https://spam.example' });
    assert.ok(join.ok && join.bot);
    const leave = parseWaitlistForm({ action: 'leave', email: 'a@b.example', [HONEYPOT_FIELD]: 'x' });
    assert.ok(leave.ok && leave.bot);
    const blank = parseWaitlistForm({ email: 'a@b.example', [HONEYPOT_FIELD]: '   ' });
    assert.ok(blank.ok && !blank.bot);
  });

  it('refuses a bad email or an unknown action', () => {
    assert.deepEqual(parseWaitlistForm({ email: 'not an email' }), { ok: false, error: 'invalid-email' });
    assert.deepEqual(parseWaitlistForm({}), { ok: false, error: 'invalid-email' });
    assert.deepEqual(parseWaitlistForm({ action: 'leave' }), { ok: false, error: 'invalid-email' });
    assert.deepEqual(parseWaitlistForm({ action: 'drop-table', email: 'a@b.example' }), { ok: false, error: 'invalid-action' });
    assert.deepEqual(parseWaitlistForm({ action: ['join'], email: 'a@b.example' }), { ok: false, error: 'invalid-action' });
  });
});

describe('sqlStore', () => {
  const signup = { email: 'owner@acme.example', role: 'owner', teamSize: '5-50', interview: true } as const;

  it('creates the table once, then inserts with parameters only', async () => {
    const { sql, calls } = fakeSql();
    const store = sqlStore(sql);
    await store.join(signup);
    await store.join({ ...signup, email: 'office@acme.example' });
    assert.deepEqual(
      calls.map((c) => c.text),
      [WAITLIST_SCHEMA, JOIN_SQL, JOIN_SQL],
    );
    assert.deepEqual(calls[1].params, ['owner@acme.example', 'owner', '5-50', true]);
    assert.deepEqual(calls[0].params, []);
  });

  it('never puts user text into the SQL string', async () => {
    const { sql, calls } = fakeSql();
    const hostile = "o'brien+x@acme.example";
    await sqlStore(sql).join({ email: hostile, role: null, teamSize: null, interview: false });
    await sqlStore(sql).leave(hostile);
    for (const call of calls) assert.ok(!call.text.includes('brien'), call.text);
    assert.deepEqual(calls.at(-1)?.params, [hostile]);
  });

  it('removes with a parameterised DELETE', async () => {
    const { sql, calls } = fakeSql();
    await sqlStore(sql).leave('owner@acme.example');
    assert.deepEqual(calls.map((c) => c.text), [WAITLIST_SCHEMA, LEAVE_SQL]);
    assert.match(LEAVE_SQL, /^DELETE FROM waitlist WHERE email = \$1$/);
  });

  it('retries creating the table after a failure instead of remembering it', async () => {
    const { sql, calls } = fakeSql((_text, call) => call === 1);
    const store = sqlStore(sql);
    await assert.rejects(store.join(signup), /connection reset/);
    await store.join(signup);
    assert.deepEqual(calls.map((c) => c.text), [WAITLIST_SCHEMA, WAITLIST_SCHEMA, JOIN_SQL]);
  });

  it('shares one table-creation between concurrent sign-ups', async () => {
    const { sql, calls } = fakeSql();
    const store = sqlStore(sql);
    await Promise.all([store.join(signup), store.join({ ...signup, email: 'b@acme.example' }), store.leave('c@acme.example')]);
    assert.equal(calls.filter((c) => c.text === WAITLIST_SCHEMA).length, 1);
  });

  it('passes a failed insert on to the caller', async () => {
    const { sql } = fakeSql((text) => text === JOIN_SQL);
    await assert.rejects(sqlStore(sql).join(signup), /connection reset/);
  });

  it('keeps existing answers on a repeat sign-up and can only switch the call opt-in on', () => {
    assert.match(JOIN_SQL, /ON CONFLICT \(email\) DO UPDATE SET/);
    assert.match(JOIN_SQL, /interview = waitlist\.interview OR EXCLUDED\.interview/);
    assert.match(JOIN_SQL, /role = COALESCE\(waitlist\.role, EXCLUDED\.role\)/);
    assert.match(JOIN_SQL, /team_size = COALESCE\(waitlist\.team_size, EXCLUDED\.team_size\)/);
  });

  it('keeps the table small and the email unique', () => {
    assert.match(WAITLIST_SCHEMA, /^CREATE TABLE IF NOT EXISTS waitlist \(/);
    assert.match(WAITLIST_SCHEMA, /email text PRIMARY KEY/);
    assert.match(WAITLIST_SCHEMA, /interview boolean NOT NULL DEFAULT false/);
    assert.match(WAITLIST_SCHEMA, /joined_at timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it('reads interview volunteers oldest first, with no user input in the query', () => {
    assert.match(INTERVIEW_QUERY, /^SELECT .+ FROM waitlist WHERE interview ORDER BY joined_at$/);
    assert.doesNotMatch(INTERVIEW_QUERY, /\$\d/);
  });
});

describe('memoryStore', () => {
  it('behaves like the SQL store: one row per email, blanks filled, opt-in only switched on', async () => {
    const store = memoryStore();
    await store.join({ email: 'owner@acme.example', role: 'owner', teamSize: null, interview: true });
    await store.join({ email: 'owner@acme.example', role: 'other', teamSize: '5-50', interview: false });
    assert.equal(store.rows.size, 1);
    const row = store.rows.get('owner@acme.example');
    assert.equal(row?.role, 'owner');
    assert.equal(row?.teamSize, '5-50');
    assert.equal(row?.interview, true);
    assert.ok(row?.joinedAt instanceof Date);
  });

  it('removes an address, and ignores one that is not there', async () => {
    const store = memoryStore();
    await store.join({ email: 'owner@acme.example', role: null, teamSize: null, interview: false });
    await store.leave('nobody@acme.example');
    assert.equal(store.rows.size, 1);
    await store.leave('owner@acme.example');
    assert.equal(store.rows.size, 0);
  });

  it('lists interview volunteers oldest first', async () => {
    const store = memoryStore();
    await store.join({ email: 'a@acme.example', role: null, teamSize: null, interview: true });
    await store.join({ email: 'b@acme.example', role: null, teamSize: null, interview: false });
    await store.join({ email: 'c@acme.example', role: 'it-provider', teamSize: null, interview: true });
    assert.deepEqual(store.interviewVolunteers().map((r) => r.email), ['a@acme.example', 'c@acme.example']);
  });
});
