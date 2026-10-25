import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERVIEW_QUERY, WAITLIST_SCHEMA, sqlStore, type SqlClient } from '../src/site/waitlist.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = readFileSync(join(ROOT, 'docs', 'interview-script.md'), 'utf8');
const STATUSES = ['to invite', 'invited', 'scheduled', 'done', 'no-show', 'declined'];

/** The rows of the markdown table under "## Tracker". */
function trackerRows(): string[][] {
  const section = /^## Tracker\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(DOC)?.[1] ?? '';
  const lines = section.split('\n').filter((l) => l.startsWith('|'));
  assert.ok(lines.length >= 2, 'the tracker is a table');
  const cells = (line: string) => line.slice(1, -1).split('|').map((c) => c.trim());
  const [header, divider, ...rows] = lines.map(cells);
  assert.ok(divider.every((c) => /^:?-{3,}:?$/.test(c)), 'a markdown table divider');
  return [header, ...rows];
}

function schemaColumns(): string[] {
  const body = /\(([\s\S]*)\)/.exec(WAITLIST_SCHEMA)?.[1] ?? '';
  return body
    .split(',')
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);
}

describe('docs/interview-script.md', () => {
  it('M4 exit criterion (what code can do): it schedules and scores 10 interviews, fed by the waitlist opt-in', async () => {
    const [header, ...rows] = trackerRows();
    assert.deepEqual(header.slice(0, 3), ['#', 'When', 'Who (initials only)']);
    assert.ok(header.includes('Status'));
    assert.ok(header.includes('Would pay $5/month?'));
    assert.ok(header.includes('Would pay $9/month?'));
    assert.deepEqual(rows.map((r) => r[0]), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    const status = header.indexOf('Status');
    for (const row of rows) {
      assert.equal(row.length, header.length, `row ${row[0]} has every column`);
      assert.ok(STATUSES.includes(row[status]), `row ${row[0]} status "${row[status]}"`);
    }

    // The query David runs to find volunteers is the one the code knows about…
    const sql = [...DOC.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1].trim());
    assert.deepEqual(sql, [INTERVIEW_QUERY]);
    // …its columns exist in the table the API creates…
    const selected = /^SELECT (.+) FROM/.exec(INTERVIEW_QUERY)?.[1].split(',').map((c) => c.trim()) ?? [];
    const columns = schemaColumns();
    for (const column of [...selected, 'interview', 'joined_at']) assert.ok(columns.includes(column), column);
    // …and ticking "happy to do a call" is what that query selects on.
    const calls: unknown[][] = [];
    const fake: SqlClient = { query: async (_text, params) => void calls.push(params) };
    await sqlStore(fake).join({ email: 'owner@acme.example', role: 'owner', teamSize: '5-50', interview: true });
    assert.deepEqual(calls.at(-1), ['owner@acme.example', 'owner', '5-50', true]);
  });

  it("states the PRD's decision rule, including the in-between case", () => {
    assert.match(DOC, /3 of 10/);
    assert.match(DOC, /fewer than 2/i);
    assert.match(DOC, /exactly 2/i);
    assert.match(DOC, /\$5[–-]9\/month/);
  });

  it('asks the pricing question at $5 and at $9, after past behaviour', () => {
    const script = /^## The interview[\s\S]*?(?=^## Tracker)/m.exec(DOC)?.[0] ?? '';
    assert.ok(script, 'an interview section before the tracker');
    const pastBehaviour = script.search(/last time/i);
    const price = script.search(/\$5 a month/);
    assert.ok(pastBehaviour >= 0, 'asks about the last time something happened');
    assert.ok(price > pastBehaviour, 'asks about price after past behaviour');
    assert.match(script, /\$9 a month/);
  });

  it('numbers its questions from 1 with no gaps', () => {
    const script = /^## The interview[\s\S]*?(?=^## Tracker)/m.exec(DOC)?.[0] ?? '';
    const numbers = [...script.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    assert.ok(numbers.length >= 10, `${numbers.length} questions`);
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
  });

  it('targets the PRD buyer and screens for them', () => {
    for (const who of [/owner/i, /office manager/i, /IT provider/i, /5[–-]50/]) assert.match(DOC, who);
    assert.match(DOC, /^## Screener/m);
    assert.match(DOC, /Google Workspace/);
  });

  it('keeps real people out of the repo', () => {
    assert.match(DOC, /initials only/i);
    assert.match(DOC, /never .*(names|email addresses).* in this file|don't put .*(names|email addresses)/i);
    assert.doesNotMatch(DOC, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, 'no email address in the doc');
  });
});
