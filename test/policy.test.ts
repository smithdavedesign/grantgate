import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthorizeUrl, type AuthorizeRequest } from '../src/authorize.ts';
import {
  applyChoice,
  assess,
  choicesFor,
  coversRequest,
  decide,
  normalizePolicy,
  type Assessment,
  type Choice,
  type Reason,
} from '../src/policy.ts';
import { AUTHORIZE_FIXTURES } from './fixtures/authorize-urls.ts';

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

const LOW_URL = authorizeUrl({ client_id: 'notes.apps.googleusercontent.com', scope: 'openid email profile' });
const MEDIUM_URL = authorizeUrl({ client_id: 'cal.apps.googleusercontent.com', scope: `openid ${API}calendar.events` });
const EMPTY = { allow: [], deny: [] };

describe('decide: M2 exit criteria', () => {
  it('blocks a high-risk scope from a client_id that is on neither list', () => {
    assert.equal(decide(ROADMAP_URL, EMPTY), 'block');
    assert.equal(decide(ROADMAP_URL, { allow: ['other.apps.googleusercontent.com'], deny: [] }), 'block');
  });

  it('allows the same high-risk request once its client_id is allowlisted', () => {
    assert.equal(decide(ROADMAP_URL, { allow: [ROADMAP_APP], deny: [] }), 'allow');
  });

  it('allows low-risk scopes from an unknown client_id', () => {
    assert.equal(decide(LOW_URL, EMPTY), 'allow');
  });
});

describe('decide over the 20 fixtures', () => {
  for (const fixture of AUTHORIZE_FIXTURES) {
    const expected = fixture.rating === 'high' ? 'block' : 'allow';
    it(`${fixture.name}: ${expected} when unknown, allow when allowlisted, block when denylisted`, () => {
      assert.equal(decide(fixture.url, EMPTY), expected);
      assert.equal(decide(fixture.url, { allow: [fixture.client_id], deny: [] }), 'allow');
      assert.equal(decide(fixture.url, { allow: [], deny: [fixture.client_id] }), 'block');
    });
  }
});

describe('assess: which rule decides', () => {
  function reasonOf(url: string, policy: unknown = EMPTY): [string, Reason] {
    const a = assess(url, policy);
    return [a.decision, a.reason];
  }

  it('lets anything that is not a Google grant request through and parses nothing', () => {
    const a = assess('https://example.com/o/oauth2/v2/auth?client_id=x&scope=https%3A%2F%2Fmail.google.com%2F', EMPTY);
    assert.deepEqual(a, { decision: 'allow', reason: 'not-a-grant-request', request: null, risk: null });
    assert.deepEqual(reasonOf('https://accounts.google.com/ServiceLogin'), ['allow', 'not-a-grant-request']);
    assert.deepEqual(reasonOf('not a url'), ['allow', 'not-a-grant-request']);
  });

  it('returns M1’s parse and risk so the interstitial can explain the request', () => {
    const a = assess(ROADMAP_URL, EMPTY);
    assert.deepEqual(a.request, parseAuthorizeUrl(ROADMAP_URL));
    assert.equal(a.risk?.rating, 'high');
    assert.match(a.risk?.labels[0].label ?? '', /email/);
  });

  it('blocks a request whose client_id copies disagree, even for low-risk scopes and an allowlisted copy', () => {
    const url = authorizeUrl({ client_id: [ROADMAP_APP, 'decoy.apps.googleusercontent.com'], scope: 'openid' });
    assert.deepEqual(reasonOf(url), ['block', 'unidentified-app']);
    assert.deepEqual(reasonOf(url, { allow: [ROADMAP_APP], deny: [] }), ['block', 'unidentified-app']);
  });

  it('blocks a denylisted app whatever it asks for', () => {
    const lowFromDenied = authorizeUrl({ client_id: ROADMAP_APP, scope: 'openid' });
    assert.deepEqual(reasonOf(lowFromDenied, { allow: [], deny: [ROADMAP_APP] }), ['block', 'denylisted']);
    assert.deepEqual(reasonOf(ROADMAP_URL, { allow: [], deny: [ROADMAP_APP] }), ['block', 'denylisted']);
  });

  it('lets the denylist win when a policy lists an app on both', () => {
    assert.deepEqual(reasonOf(ROADMAP_URL, { allow: [ROADMAP_APP], deny: [ROADMAP_APP] }), ['block', 'denylisted']);
  });

  it('allows an allowlisted app and says so', () => {
    assert.deepEqual(reasonOf(ROADMAP_URL, { allow: [ROADMAP_APP], deny: [] }), ['allow', 'allowlisted']);
  });

  it('blocks a high rating, including a Gmail scope grantgate does not recognise', () => {
    assert.deepEqual(reasonOf(ROADMAP_URL), ['block', 'high-risk']);
    const unknownGmail = authorizeUrl({ client_id: 'x.apps.googleusercontent.com', scope: `${API}gmail.brand-new` });
    assert.deepEqual(reasonOf(unknownGmail), ['block', 'high-risk']);
  });

  it('allows medium and low ratings and a request with no scopes', () => {
    assert.deepEqual(reasonOf(MEDIUM_URL), ['allow', 'not-high-risk']);
    assert.deepEqual(reasonOf(LOW_URL), ['allow', 'not-high-risk']);
    assert.deepEqual(reasonOf(authorizeUrl({ client_id: 'x.apps.googleusercontent.com' })), ['allow', 'not-high-risk']);
  });

  it('matches list entries ignoring case and surrounding spaces', () => {
    assert.equal(decide(ROADMAP_URL, { allow: ['  ABC.Apps.GoogleUserContent.com '], deny: [] }), 'allow');
    const upper = authorizeUrl({ client_id: 'ABC.APPS.GOOGLEUSERCONTENT.COM', scope: 'openid' });
    assert.equal(decide(upper, { allow: [], deny: [ROADMAP_APP] }), 'block');
  });

  it('treats a missing or corrupt policy as empty lists instead of throwing', () => {
    for (const policy of [undefined, null, 42, 'abc', [], { allow: 'abc.apps.googleusercontent.com' }]) {
      assert.equal(decide(ROADMAP_URL, policy), 'block', JSON.stringify(policy));
      assert.equal(decide(LOW_URL, policy), 'allow', JSON.stringify(policy));
    }
  });
});

describe('normalizePolicy', () => {
  it('returns empty lists for anything that is not a policy object', () => {
    for (const input of [undefined, null, 0, 'x', [], [ROADMAP_APP], { allow: 'x', deny: 7 }]) {
      assert.deepEqual(normalizePolicy(input), { allow: [], deny: [] }, JSON.stringify(input));
    }
  });

  it('keeps only non-empty strings, trimmed, lower-cased and without repeats, in order', () => {
    const policy = normalizePolicy({ allow: [' B.apps ', 1, null, '', '  ', 'a.apps', 'b.APPS'], deny: [{}, 'C.apps'] });
    assert.deepEqual(policy, { allow: ['b.apps', 'a.apps'], deny: ['c.apps'] });
  });

  it('drops an allowlist entry that is also denylisted', () => {
    assert.deepEqual(normalizePolicy({ allow: ['a', 'b'], deny: ['B'] }), { allow: ['a'], deny: ['b'] });
  });

  it('returns fresh arrays and leaves its input alone', () => {
    const input = { allow: ['A'], deny: [] as string[] };
    const policy = normalizePolicy(input);
    policy.allow.push('z');
    assert.deepEqual(input, { allow: ['A'], deny: [] });
  });
});

describe('choicesFor: what the interstitial offers', () => {
  const table: Record<Reason, Choice[]> = {
    'not-a-grant-request': [],
    allowlisted: [],
    'not-high-risk': [],
    'high-risk': ['back', 'once', 'always-allow', 'always-block'],
    denylisted: ['back'],
    'unidentified-app': ['back', 'once'],
  };
  for (const [reason, choices] of Object.entries(table) as [Reason, Choice[]][]) {
    it(`${reason}: ${choices.join(', ') || 'nothing (no interstitial)'}`, () => {
      assert.deepEqual(choicesFor({ reason }), choices);
    });
  }

  it('returns a copy the caller cannot use to change the rules', () => {
    choicesFor({ reason: 'denylisted' }).push('once');
    assert.deepEqual(choicesFor({ reason: 'denylisted' }), ['back']);
  });
});

describe('applyChoice: M2 exit criterion — confirming adds nothing to the allowlist unless "always allow" is chosen', () => {
  const start = { allow: ['kept.apps.googleusercontent.com'], deny: ['other.apps.googleusercontent.com'] };
  const highRisk = assess(ROADMAP_URL, start);

  it('"continue once" proceeds and leaves both lists exactly as they were', () => {
    assert.deepEqual(applyChoice(start, highRisk, 'once'), { policy: start, proceed: true });
  });

  it('"go back" does not proceed and leaves both lists exactly as they were', () => {
    assert.deepEqual(applyChoice(start, highRisk, 'back'), { policy: start, proceed: false });
  });

  it('"always allow" proceeds and adds the client_id to the allowlist', () => {
    assert.deepEqual(applyChoice(start, highRisk, 'always-allow'), {
      policy: { allow: ['kept.apps.googleusercontent.com', ROADMAP_APP], deny: start.deny },
      proceed: true,
    });
  });

  it('"always block" does not proceed, adds the client_id to the denylist and nothing to the allowlist', () => {
    assert.deepEqual(applyChoice(start, highRisk, 'always-block'), {
      policy: { allow: start.allow, deny: ['other.apps.googleusercontent.com', ROADMAP_APP] },
      proceed: false,
    });
  });

  it('stores the client_id in lower case', () => {
    const upper = assess(authorizeUrl({ client_id: 'MiXeD.apps.googleusercontent.com', scope: `${API}drive` }), EMPTY);
    assert.deepEqual(applyChoice(EMPTY, upper, 'always-allow').policy.allow, ['mixed.apps.googleusercontent.com']);
  });

  it('does not change the policy object it was given', () => {
    const input = { allow: ['kept.apps.googleusercontent.com'], deny: [] as string[] };
    applyChoice(input, assess(ROADMAP_URL, input), 'always-allow');
    assert.deepEqual(input, { allow: ['kept.apps.googleusercontent.com'], deny: [] });
  });

  it('refuses a choice the interstitial does not offer for that request', () => {
    const denied = assess(ROADMAP_URL, { allow: [], deny: [ROADMAP_APP] });
    const unidentified = assess(authorizeUrl({ client_id: ['a', 'b'], scope: `${API}drive` }), EMPTY);
    const allowed = assess(LOW_URL, EMPTY);
    const refused: [Assessment, Choice][] = [
      [denied, 'once'],
      [denied, 'always-allow'],
      [unidentified, 'always-allow'],
      [unidentified, 'always-block'],
      [allowed, 'once'],
      [allowed, 'always-allow'],
      [highRisk, 'maybe' as Choice],
    ];
    for (const [assessment, choice] of refused) {
      assert.throws(() => applyChoice(EMPTY, assessment, choice), /not offered/, `${assessment.reason} / ${choice}`);
    }
  });

  it('accepts "once" for an app it cannot identify, without touching the lists', () => {
    const unidentified = assess(authorizeUrl({ client_id: ['a', 'b'], scope: `${API}drive` }), EMPTY);
    assert.deepEqual(applyChoice(EMPTY, unidentified, 'once'), { policy: EMPTY, proceed: true });
  });
});

describe('coversRequest: may a follow-up step reuse an approval?', () => {
  const approved: AuthorizeRequest = {
    client_id: ROADMAP_APP,
    scopes: ['https://mail.google.com/', 'openid'],
    redirect_uri: 'https://app.example/cb',
  };

  it('covers the same request and one asking for fewer scopes', () => {
    assert.equal(coversRequest(approved, { ...approved }), true);
    assert.equal(coversRequest(approved, { ...approved, scopes: ['openid'] }), true);
    assert.equal(coversRequest(approved, { ...approved, scopes: [] }), true);
    assert.equal(coversRequest(approved, { ...approved, client_id: ROADMAP_APP.toUpperCase() }), true);
  });

  it('does not cover more scopes, another app, another redirect or an unidentified app', () => {
    assert.equal(coversRequest(approved, { ...approved, scopes: [...approved.scopes, `${API}drive`] }), false);
    assert.equal(coversRequest(approved, { ...approved, client_id: 'evil.apps.googleusercontent.com' }), false);
    assert.equal(coversRequest(approved, { ...approved, redirect_uri: 'https://evil.example/cb' }), false);
    assert.equal(coversRequest(approved, { ...approved, redirect_uri: null }), false);
    assert.equal(coversRequest(approved, { ...approved, client_id: null }), false);
    assert.equal(coversRequest({ ...approved, client_id: null }, { ...approved, client_id: null }), false);
  });
});
