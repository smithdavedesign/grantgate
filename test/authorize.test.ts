import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthorizeUrl } from '../src/authorize.ts';

const ROADMAP_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20openid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code';

const V2 = 'https://accounts.google.com/o/oauth2/v2/auth';

// Builds an authorize URL so each test spells out only what it varies.
// An array value repeats the parameter.
function authorizeUrl(params: Record<string, string | string[]>, base = V2): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    for (const one of [value].flat()) url.searchParams.append(key, one);
  }
  return url.href;
}

const BASIC = { client_id: 'app.apps.googleusercontent.com', scope: 'openid email' };

describe('parseAuthorizeUrl: M1 exit criteria', () => {
  it('returns client_id, scopes and redirect_uri for the roadmap example', () => {
    assert.deepEqual(parseAuthorizeUrl(ROADMAP_URL), {
      client_id: 'abc.apps.googleusercontent.com',
      scopes: ['https://mail.google.com/', 'openid'],
      redirect_uri: 'https://app.example/cb',
    });
  });

  it('returns null for a non-Google URL', () => {
    assert.equal(parseAuthorizeUrl('https://app.example/cb'), null);
    assert.equal(
      parseAuthorizeUrl('https://example.com/o/oauth2/v2/auth?client_id=abc&scope=https%3A%2F%2Fmail.google.com%2F'),
      null,
    );
  });
});

describe('parseAuthorizeUrl: which URLs are Google authorize requests', () => {
  it('accepts the v2 and legacy endpoints', () => {
    assert.notEqual(parseAuthorizeUrl(authorizeUrl(BASIC)), null);
    assert.notEqual(parseAuthorizeUrl(authorizeUrl(BASIC, 'https://accounts.google.com/o/oauth2/auth')), null);
  });

  it('accepts later steps of the same flow under the endpoint path', () => {
    for (const path of ['/o/oauth2/auth/oauthchooseaccount', '/o/oauth2/v2/auth/identifier', '/o/oauth2/v2/auth/']) {
      assert.notEqual(parseAuthorizeUrl(authorizeUrl(BASIC, `https://accounts.google.com${path}`)), null, path);
    }
  });

  it('accepts a URL object as well as a string', () => {
    assert.deepEqual(parseAuthorizeUrl(new URL(ROADMAP_URL)), parseAuthorizeUrl(ROADMAP_URL));
  });

  it('accepts host and path spellings a browser would still send to Google', () => {
    const spellings = [
      'https://ACCOUNTS.Google.com/o/oauth2/v2/auth',
      'https://accounts.google.com./o/oauth2/v2/auth',
      'https://accounts.google.com:443/o/oauth2/v2/auth',
      'http://accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com/o/oauth2/v2/%61uth',
      'https://accounts.google.com//o//oauth2/v2/auth',
      'https://accounts.google.com/O/OAuth2/v2/auth',
    ];
    for (const base of spellings) {
      assert.deepEqual(
        parseAuthorizeUrl(authorizeUrl(BASIC, base)),
        { client_id: BASIC.client_id, scopes: ['openid', 'email'], redirect_uri: null },
        base,
      );
    }
  });

  it('rejects hosts that only look like Google accounts', () => {
    const hosts = [
      'https://accounts.google.com.evil.example/o/oauth2/v2/auth',
      'https://accounts-google.com/o/oauth2/v2/auth',
      'https://login.accounts.google.com/o/oauth2/v2/auth',
      'https://myaccount.google.com/o/oauth2/v2/auth',
      'https://google.com/o/oauth2/v2/auth',
    ];
    for (const base of hosts) assert.equal(parseAuthorizeUrl(authorizeUrl(BASIC, base)), null, base);
    assert.equal(
      parseAuthorizeUrl(`https://evil.example/accounts.google.com/o/oauth2/v2/auth?client_id=x&next=${encodeURIComponent(V2)}`),
      null,
    );
  });

  it('rejects other pages on accounts.google.com', () => {
    const paths = [
      '/',
      '/ServiceLogin',
      '/signin/oauth/consent',
      '/o/oauth2/token',
      '/o/oauth2/revoke',
      '/o/oauth2/v2/authorize',
      '/o/oauth2/v2/auth-x',
      '/o/oauth2',
    ];
    for (const path of paths) {
      assert.equal(parseAuthorizeUrl(authorizeUrl(BASIC, `https://accounts.google.com${path}`)), null, path);
    }
  });

  it('rejects other schemes and non-default ports', () => {
    for (const base of [
      'ftp://accounts.google.com/o/oauth2/v2/auth',
      'chrome-extension://accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com:8443/o/oauth2/v2/auth',
      'http://accounts.google.com:443/o/oauth2/v2/auth',
    ]) {
      assert.equal(parseAuthorizeUrl(authorizeUrl(BASIC, base)), null, base);
    }
  });

  it('returns null instead of throwing for input that is not an absolute URL', () => {
    for (const input of ['', 'not a url', '/o/oauth2/v2/auth?client_id=x', 'accounts.google.com/o/oauth2/v2/auth?client_id=x']) {
      assert.equal(parseAuthorizeUrl(input), null, JSON.stringify(input));
    }
    assert.equal(parseAuthorizeUrl(undefined as unknown as string), null);
    assert.equal(parseAuthorizeUrl(42 as unknown as string), null);
  });

  it('returns null when there is no client_id, because Google rejects such requests', () => {
    assert.equal(parseAuthorizeUrl(authorizeUrl({ scope: 'openid' })), null);
    assert.equal(parseAuthorizeUrl(authorizeUrl({ client_id: '   ', scope: 'openid' })), null);
  });
});

describe('parseAuthorizeUrl: reading the parameters', () => {
  it('splits scopes on spaces, plus signs and commas, dropping blanks and repeats in request order', () => {
    const plus = `${V2}?client_id=a&scope=openid+email+profile`;
    assert.deepEqual(parseAuthorizeUrl(plus)?.scopes, ['openid', 'email', 'profile']);
    const messy = authorizeUrl({ client_id: 'a', scope: '  email,profile \t openid  email ' });
    assert.deepEqual(parseAuthorizeUrl(messy)?.scopes, ['email', 'profile', 'openid']);
  });

  it('collects scopes from every scope parameter so none can hide in a second copy', () => {
    const url = authorizeUrl({ client_id: 'a', scope: ['openid', 'https://mail.google.com/ openid'] });
    assert.deepEqual(parseAuthorizeUrl(url)?.scopes, ['openid', 'https://mail.google.com/']);
  });

  it('returns an empty scope list when no scope is requested', () => {
    assert.deepEqual(parseAuthorizeUrl(authorizeUrl({ client_id: 'a' }))?.scopes, []);
  });

  it('returns redirect_uri null when it is missing', () => {
    assert.equal(parseAuthorizeUrl(authorizeUrl(BASIC))?.redirect_uri, null);
  });

  it('trims whitespace around client_id and redirect_uri', () => {
    const parsed = parseAuthorizeUrl(authorizeUrl({ client_id: ' a.apps.googleusercontent.com ', redirect_uri: ' https://app.example/cb ' }));
    assert.equal(parsed?.client_id, 'a.apps.googleusercontent.com');
    assert.equal(parsed?.redirect_uri, 'https://app.example/cb');
  });

  it('keeps a client_id or redirect_uri that is repeated with the same value', () => {
    const parsed = parseAuthorizeUrl(authorizeUrl({ client_id: ['a', 'a'], redirect_uri: ['https://app.example/cb', 'https://app.example/cb'] }));
    assert.equal(parsed?.client_id, 'a');
    assert.equal(parsed?.redirect_uri, 'https://app.example/cb');
  });

  it('reports client_id null when copies disagree, so a trusted app id cannot be borrowed', () => {
    const parsed = parseAuthorizeUrl(authorizeUrl({ client_id: ['trusted.apps.googleusercontent.com', 'evil.apps.googleusercontent.com'], scope: 'openid' }));
    assert.deepEqual(parsed, { client_id: null, scopes: ['openid'], redirect_uri: null });
  });

  it('reports redirect_uri null when copies disagree', () => {
    const parsed = parseAuthorizeUrl(authorizeUrl({ client_id: 'a', redirect_uri: ['https://app.example/cb', 'https://evil.example/cb'] }));
    assert.equal(parsed?.redirect_uri, null);
  });
});
