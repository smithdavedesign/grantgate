import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_POLICY_ENTRIES,
  MAX_POLICY_FILE_CHARS,
  POLICY_FILE_FORMAT,
  decide,
  mergePolicies,
  parsePolicyFile,
  policyFile,
  removeFromPolicy,
  type Policy,
} from '../src/policy.ts';

const V2 = 'https://accounts.google.com/o/oauth2/v2/auth';
const ONE = 'one.apps.googleusercontent.com';
const TWO = 'two.apps.googleusercontent.com';
const THREE = 'three.apps.googleusercontent.com';

// A full-Gmail request from `clientId`: blocked unless that app is allowlisted.
function mailRequest(clientId: string): string {
  const url = new URL(V2);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'https://mail.google.com/');
  url.searchParams.set('redirect_uri', 'https://app.example/cb');
  return url.href;
}

function parsed(text: string): Policy {
  const result = parsePolicyFile(text);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.policy;
}

function rejected(text: string): string {
  const result = parsePolicyFile(text);
  assert.equal(result.ok, false, text.slice(0, 200));
  return result.ok ? '' : result.error;
}

// ---------------------------------------------------------------------------

describe('M3 exit criterion: importing a policy JSON with 2 client_ids makes decide() allow those', () => {
  it('blocks both apps before the import and allows both after, and nothing else', () => {
    const before: Policy = { allow: [], deny: [] };
    assert.equal(decide(mailRequest(ONE), before), 'block');
    assert.equal(decide(mailRequest(TWO), before), 'block');

    const after = mergePolicies(before, parsed(JSON.stringify({ allow: [ONE, TWO] })));
    assert.equal(decide(mailRequest(ONE), after), 'allow');
    assert.equal(decide(mailRequest(TWO), after), 'allow');
    assert.equal(decide(mailRequest(THREE), after), 'block');
  });

  it('works the same with a file exported from someone else’s grantgate', () => {
    const owner: Policy = { allow: [ONE, TWO], deny: [THREE] };
    const staff = mergePolicies({ allow: [], deny: [] }, parsed(policyFile(owner)));
    assert.deepEqual(staff, owner);
    assert.equal(decide(mailRequest(ONE), staff), 'allow');
    assert.equal(decide(mailRequest(TWO), staff), 'allow');
    assert.equal(decide(mailRequest(THREE), staff), 'block');
  });
});

describe('policyFile: exporting the lists', () => {
  it('writes a self-describing, readable JSON file', () => {
    const text = policyFile({ allow: [ONE], deny: [TWO] });
    assert.deepEqual(JSON.parse(text), { format: POLICY_FILE_FORMAT, version: 1, allow: [ONE], deny: [TWO] });
    assert.equal(POLICY_FILE_FORMAT, 'grantgate-policy');
    assert.match(text, /\n {2}"allow"/, 'indented for people who open it');
    assert.ok(text.endsWith('\n'));
  });

  it('cleans what it writes and round-trips through parsePolicyFile', () => {
    const messy = { allow: [' ONE.apps.googleusercontent.com ', ONE, 7, TWO], deny: [TWO] };
    const text = policyFile(messy);
    assert.deepEqual(JSON.parse(text).allow, [ONE]);
    assert.deepEqual(parsed(text), { allow: [ONE], deny: [TWO] });
    assert.deepEqual(JSON.parse(policyFile(undefined)), { format: POLICY_FILE_FORMAT, version: 1, allow: [], deny: [] });
  });
});

describe('parsePolicyFile: importing a file', () => {
  it('accepts a bare { allow, deny } object, or just one of the lists', () => {
    assert.deepEqual(parsed(JSON.stringify({ allow: [ONE], deny: [TWO] })), { allow: [ONE], deny: [TWO] });
    assert.deepEqual(parsed(JSON.stringify({ deny: [TWO] })), { allow: [], deny: [TWO] });
    assert.deepEqual(parsed(JSON.stringify({ allow: [] })), { allow: [], deny: [] });
  });

  it('normalises like the stored lists: trimmed, lower-case, no repeats, a block wins', () => {
    const text = JSON.stringify({ allow: [' One.Apps.GoogleUserContent.com', ONE, TWO], deny: [TWO.toUpperCase()] });
    assert.deepEqual(parsed(text), { allow: [ONE], deny: [TWO] });
  });

  it('ignores fields it does not know', () => {
    assert.deepEqual(parsed(JSON.stringify({ allow: [ONE], note: 'from the office manager' })), { allow: [ONE], deny: [] });
  });

  it('rejects text that is not JSON', () => {
    for (const text of ['', 'allow: one', '{"allow": [', '<html>']) assert.match(rejected(text), /isn't valid JSON/);
  });

  it('rejects JSON that is not a policy', () => {
    for (const value of [null, 42, 'policy', [ONE, TWO]]) assert.match(rejected(JSON.stringify(value)), /isn't a grantgate policy file/);
    assert.match(rejected(JSON.stringify({ format: 'something-else', allow: [ONE] })), /isn't a grantgate policy file/);
    assert.match(rejected(JSON.stringify({ name: 'x' })), /no allow or deny list/);
  });

  it('rejects a version it cannot read', () => {
    assert.match(rejected(JSON.stringify({ format: POLICY_FILE_FORMAT, version: 2, allow: [ONE] })), /version/);
    assert.match(rejected(JSON.stringify({ version: '1', allow: [ONE] })), /version/);
  });

  it('rejects a list that is not a list of client IDs, saying where', () => {
    assert.match(rejected(JSON.stringify({ allow: ONE })), /"allow" must be a list/);
    assert.match(rejected(JSON.stringify({ allow: [ONE], deny: { id: TWO } })), /"deny" must be a list/);
    for (const bad of [42, null, '', '   ', 'two words', 'tab\there', 'x'.repeat(257), 'naïve.apps.googleusercontent.com']) {
      assert.match(rejected(JSON.stringify({ allow: [ONE], deny: [TWO, bad] })), /Entry 2 in "deny" isn't a client ID/, String(bad));
    }
  });

  it(`rejects more than ${MAX_POLICY_ENTRIES} apps, or a file over ${MAX_POLICY_FILE_CHARS} characters`, () => {
    const many = Array.from({ length: MAX_POLICY_ENTRIES }, (_, i) => `app${i}.apps.googleusercontent.com`);
    assert.ok(parsePolicyFile(JSON.stringify({ allow: many })).ok, 'exactly the limit is fine');
    assert.match(rejected(JSON.stringify({ allow: many, deny: [ONE] })), /more than 10000 apps/);
    assert.match(rejected(`{"allow":[],"pad":"${'x'.repeat(MAX_POLICY_FILE_CHARS)}"}`), /too big/);
  });

  it('never throws, whatever it is given', () => {
    for (const value of [undefined, null, 42, {}] as unknown as string[]) assert.equal(parsePolicyFile(value).ok, false);
  });
});

describe('mergePolicies: what an import does to the lists you have', () => {
  it('adds the file’s apps to yours, keeping your own', () => {
    assert.deepEqual(mergePolicies({ allow: [ONE], deny: [] }, { allow: [TWO], deny: [THREE] }), { allow: [ONE, TWO], deny: [THREE] });
  });

  it('lets a block win either way round', () => {
    assert.deepEqual(mergePolicies({ allow: [], deny: [ONE] }, { allow: [ONE], deny: [] }), { allow: [], deny: [ONE] });
    assert.deepEqual(mergePolicies({ allow: [ONE], deny: [] }, { allow: [], deny: [ONE] }), { allow: [], deny: [ONE] });
  });

  it('does not change its inputs and copes with garbage', () => {
    const mine: Policy = { allow: [ONE], deny: [] };
    const theirs: Policy = { allow: [TWO], deny: [] };
    mergePolicies(mine, theirs);
    assert.deepEqual(mine, { allow: [ONE], deny: [] });
    assert.deepEqual(theirs, { allow: [TWO], deny: [] });
    assert.deepEqual(mergePolicies('garbage', theirs), { allow: [TWO], deny: [] });
    assert.deepEqual(mergePolicies(mine, null), mine);
  });
});

describe('removeFromPolicy: the Remove button', () => {
  it('removes the app from the named list only, whatever its case', () => {
    const policy: Policy = { allow: [ONE, TWO], deny: [THREE] };
    assert.deepEqual(removeFromPolicy(policy, 'allow', ONE.toUpperCase()), { allow: [TWO], deny: [THREE] });
    assert.deepEqual(removeFromPolicy(policy, 'deny', THREE), { allow: [ONE, TWO], deny: [] });
    assert.deepEqual(removeFromPolicy(policy, 'deny', ONE), policy, 'ONE is not on the block list');
    assert.deepEqual(policy, { allow: [ONE, TWO], deny: [THREE] }, 'input unchanged');
  });
});
