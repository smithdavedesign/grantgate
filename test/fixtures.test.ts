import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthorizeUrl } from '../src/authorize.ts';
import { scopeRisk } from '../src/scopes.ts';
import { AUTHORIZE_FIXTURES } from './fixtures/authorize-urls.ts';

describe('fixture set of Google authorize URLs', () => {
  it('has 20 distinct fixtures covering every rating', () => {
    assert.equal(AUTHORIZE_FIXTURES.length, 20);
    assert.equal(new Set(AUTHORIZE_FIXTURES.map((f) => f.url)).size, 20);
    assert.equal(new Set(AUTHORIZE_FIXTURES.map((f) => f.name)).size, 20);
    for (const rating of ['low', 'medium', 'high']) {
      assert.ok(AUTHORIZE_FIXTURES.some((f) => f.rating === rating), `no ${rating} fixture`);
    }
  });

  for (const fixture of AUTHORIZE_FIXTURES) {
    describe(fixture.name, () => {
      it('parses with the expected client_id, scopes and redirect_uri', () => {
        assert.deepEqual(parseAuthorizeUrl(fixture.url), {
          client_id: fixture.client_id,
          scopes: fixture.scopes,
          redirect_uri: fixture.redirect_uri,
        });
      });

      it(`is rated ${fixture.rating} with a recognised label for every scope`, () => {
        const risk = scopeRisk(fixture.scopes);
        assert.equal(risk.rating, fixture.rating);
        assert.equal(risk.labels.length, fixture.scopes.length);
        for (const label of risk.labels) assert.equal(label.known, true, label.scope);
      });
    });
  }
});
