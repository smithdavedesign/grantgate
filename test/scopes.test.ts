import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_SCOPES, scopeRisk } from '../src/scopes.ts';

const API = 'https://www.googleapis.com/auth/';

function ratingOf(scope: string) {
  return scopeRisk([scope]).rating;
}

describe('scopeRisk: M1 exit criteria', () => {
  it('rates plain sign-in (openid, email, profile) low', () => {
    assert.equal(scopeRisk(['openid', 'email', 'profile']).rating, 'low');
  });

  it('rates full Gmail access high with a label that mentions email', () => {
    const risk = scopeRisk(['https://mail.google.com/']);
    assert.equal(risk.rating, 'high');
    assert.equal(risk.labels.length, 1);
    assert.match(risk.labels[0].label, /email/);
  });
});

describe('scopeRisk: overall rating', () => {
  it('is the highest rating among the requested scopes, whatever the order', () => {
    assert.equal(scopeRisk(['openid', `${API}calendar.readonly`]).rating, 'medium');
    assert.equal(scopeRisk([`${API}calendar.readonly`, 'openid']).rating, 'medium');
    assert.equal(scopeRisk(['openid', `${API}calendar`, `${API}drive`]).rating, 'high');
    assert.equal(scopeRisk([`${API}drive`, `${API}calendar`, 'openid']).rating, 'high');
  });

  it('is low with no labels when nothing is requested', () => {
    assert.deepEqual(scopeRisk([]), { rating: 'low', labels: [] });
  });
});

describe('scopeRisk: labels', () => {
  it('gives one label per distinct scope, in request order, naming the scope as requested', () => {
    const risk = scopeRisk(['openid', `${API}gmail.send`, 'openid', '']);
    assert.deepEqual(
      risk.labels.map(({ scope, rating, known }) => ({ scope, rating, known })),
      [
        { scope: 'openid', rating: 'low', known: true },
        { scope: `${API}gmail.send`, rating: 'high', known: true },
      ],
    );
  });

  it('recognises spelling variants of a scope and counts them once', () => {
    const variants = ['https://mail.google.com', 'HTTPS://MAIL.GOOGLE.COM/', 'http://mail.google.com/', ' https://mail.google.com/ '];
    for (const variant of variants) {
      const [label] = scopeRisk([variant]).labels;
      assert.equal(label.known, true, variant);
      assert.equal(label.rating, 'high', variant);
    }
    assert.equal(scopeRisk(['https://mail.google.com/', 'https://mail.google.com']).labels.length, 1);
    assert.equal(ratingOf(`${API.toUpperCase()}DRIVE`), 'high');
  });

  it('rates an unrecognised scope medium and says it is unrecognised', () => {
    const [label] = scopeRisk(['https://www.googleapis.com/auth/some.new.api']).labels;
    assert.equal(label.rating, 'medium');
    assert.equal(label.known, false);
    assert.match(label.label, /recogni[sz]e/);
    assert.ok(label.label.includes('https://www.googleapis.com/auth/some.new.api'));
  });

  it('rates unrecognised Gmail, Drive and Workspace admin scopes high', () => {
    for (const scope of [`${API}gmail.future`, `${API}drive.future`, `${API}admin.future.readonly`]) {
      const [label] = scopeRisk([scope]).labels;
      assert.equal(label.rating, 'high', scope);
      assert.equal(label.known, false, scope);
    }
  });

  it('rates the scopes behind known consent-phishing patterns high', () => {
    for (const scope of [
      `${API}gmail.readonly`,
      `${API}gmail.send`,
      `${API}gmail.settings.basic`,
      `${API}drive`,
      `${API}drive.readonly`,
      `${API}chromewebstore`,
      `${API}admin.directory.user`,
      `${API}cloud-platform`,
      `${API}spreadsheets`,
    ]) {
      assert.equal(ratingOf(scope), 'high', scope);
    }
  });

  it('rates personal-data scopes medium and narrow scopes low', () => {
    for (const scope of [`${API}calendar`, `${API}contacts.readonly`, `${API}tasks`, `${API}youtube.readonly`]) {
      assert.equal(ratingOf(scope), 'medium', scope);
    }
    for (const scope of [`${API}drive.file`, `${API}drive.appdata`, `${API}gmail.labels`, `${API}userinfo.email`]) {
      assert.equal(ratingOf(scope), 'low', scope);
    }
  });

  it('labels the legacy feed-style scopes', () => {
    assert.equal(ratingOf('https://www.google.com/m8/feeds'), 'medium');
    assert.equal(ratingOf('https://docs.google.com/feeds/'), 'high');
  });

  it('rejects input that is not an array of strings', () => {
    assert.throws(() => scopeRisk('openid' as unknown as string[]), TypeError);
    assert.throws(() => scopeRisk([42] as unknown as string[]), TypeError);
  });
});

describe('KNOWN_SCOPES table', () => {
  it('lists each scope once, with a valid rating and a plain-English label', () => {
    const seen = new Set<string>();
    for (const { scope, rating, label } of KNOWN_SCOPES) {
      // Same normalisation scopeRisk applies, so two spellings can't both be listed.
      const key = scope.toLowerCase().replace(/^http:\/\//, 'https://').replace(/\/+$/, '');
      assert.ok(!seen.has(key), `duplicate entry ${scope}`);
      seen.add(key);
      assert.ok(['low', 'medium', 'high'].includes(rating), scope);
      assert.match(label, /^[a-z]/, `${scope}: label should read as "This app wants to …"`);
      assert.doesNotMatch(label, /https?:|googleapis|\.readonly/, `${scope}: label should not repeat the scope`);
    }
    assert.ok(KNOWN_SCOPES.length >= 40);
  });

  it('is what scopeRisk uses for every entry', () => {
    for (const { scope, rating, label } of KNOWN_SCOPES) {
      assert.deepEqual(scopeRisk([scope]).labels, [{ scope, rating, label, known: true }]);
    }
  });
});
