import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../src/policy.ts';
import { KNOWN_SCOPES, scopeRisk, type Rating } from '../src/scopes.ts';
import { GOOGLE_PERMISSIONS_URL } from '../src/extension/options.ts';
import { HONEYPOT_FIELD, MAX_EMAIL_LENGTH, ROLES, TEAM_SIZES } from '../src/site/waitlist.ts';
import { API_ROUTES } from '../src/site/api.ts';
import { CHECKOUT_SOON, NETWORK_ERROR, SENDING, UNEXPECTED_REPLY, enhanceForm, showCheckoutNotice } from '../src/site/page.ts';
import { FakeElement } from './helpers/fake-dom.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const PAGES = ['index.html', 'privacy.html', 'terms.html'];
const read = (file: string) => readFileSync(join(SITE, file), 'utf8');
const INDEX = read('index.html');

// --- A few regex helpers for our own static HTML (no nesting of the same tag). ---

type Attrs = Record<string, string>;

function parseAttrs(source: string): Attrs {
  const attrs: Attrs = {};
  for (const [, name, dq, sq, bare] of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[name.toLowerCase()] = decode(dq ?? sq ?? bare ?? '');
  }
  return attrs;
}

/** Every <tag …> opening tag, with its attributes. */
function openTags(html: string, tag: string): Attrs[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map((m) => parseAttrs(m[1]));
}

/** Every <tag …>…</tag> element (the tag must not nest), with its attributes and inner HTML. */
function elements(html: string, tag: string): { attrs: Attrs; inner: string }[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => ({ attrs: parseAttrs(m[1]), inner: m[2] }));
}

function decode(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const textOf = (inner: string) => decode(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function formWith(html: string, action: string): { attrs: Attrs; inner: string } {
  const forms = elements(html, 'form').filter((f) => /name="action" value="([^"]+)"/.exec(f.inner)?.[1] === action);
  assert.equal(forms.length, 1, `one ${action} form`);
  return forms[0];
}

function grantUrl(scope: string): string {
  const params = new URLSearchParams({
    client_id: 'unknown-app.apps.googleusercontent.com',
    scope,
    redirect_uri: 'https://app.example/cb',
    response_type: 'code',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

const LABEL_BY_SCOPE = new Map(KNOWN_SCOPES.map((s) => [s.scope, s]));

describe('the landing page', () => {
  it('M4 exit criterion: the landing page lists the three risk labels', () => {
    const levels = elements(INDEX, 'article').filter((a) => a.attrs['data-rating']);
    assert.deepEqual(
      levels.map((l) => l.attrs['data-rating']),
      ['high', 'medium', 'low'],
    );
    const titles: Record<Rating, string> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };
    const gate: Record<Rating, 'allow' | 'block'> = { high: 'block', medium: 'allow', low: 'allow' };
    for (const level of levels) {
      const rating = level.attrs['data-rating'] as Rating;
      assert.equal(textOf(elements(level.inner, 'h3')[0]?.inner ?? ''), titles[rating]);

      const verdicts = elements(level.inner, 'p').filter((p) => p.attrs['data-decision']);
      assert.equal(verdicts.length, 1, `${rating} says what the gate does`);
      assert.equal(verdicts[0].attrs['data-decision'], gate[rating]);

      const examples = elements(level.inner, 'li');
      assert.ok(examples.length >= 2, `${rating} has at least two examples`);
      for (const example of examples) {
        const scope = example.attrs['data-scope'];
        const known = LABEL_BY_SCOPE.get(scope);
        assert.ok(known, `${scope} is a known scope`);
        // The words on the page are the product's own words…
        assert.equal(textOf(example.inner), known.label);
        assert.equal(known.rating, rating, `${scope} is rated ${rating}`);
        assert.equal(scopeRisk([scope]).rating, rating);
        // …and the promise matches what the gate does with an unknown app.
        assert.equal(decide(grantUrl(scope), { allow: [], deny: [] }), gate[rating], scope);
      }
    }
  });

  it('quotes the product exactly wherever else it names a permission', () => {
    const quoted = [...INDEX.matchAll(/<(\w+)\b([^>]*\bdata-scope="[^"]*"[^>]*)>([\s\S]*?)<\/\1>/g)];
    assert.ok(quoted.length >= 7);
    for (const [, , attrs, inner] of quoted) {
      const { 'data-scope': scope, 'data-rating': rating } = parseAttrs(attrs);
      const known = LABEL_BY_SCOPE.get(scope);
      assert.ok(known, scope);
      assert.ok(textOf(inner).endsWith(known.label), `${scope}: ${textOf(inner)}`);
      if (rating) assert.equal(rating, known.rating, scope);
    }
  });

  it('has a waitlist form that posts the fields the API reads', () => {
    const form = formWith(INDEX, 'join');
    assert.equal(form.attrs.action, '/api/waitlist');
    assert.equal(form.attrs.method, 'post');
    assert.ok('data-waitlist' in form.attrs);
    assert.ok(INDEX.includes(`id="${form.attrs['data-status']}"`), 'the status element exists');
    assert.match(INDEX, /<section\b[^>]*\bid="join"/);

    const inputs = openTags(form.inner, 'input');
    const email = inputs.find((i) => i.name === 'email');
    assert.ok(email);
    assert.equal(email.type, 'email');
    assert.ok('required' in email);
    assert.equal(email.maxlength, String(MAX_EMAIL_LENGTH));
    assert.equal(email.autocomplete, 'email');

    const selects = Object.fromEntries(elements(form.inner, 'select').map((s) => [s.attrs.name, openTags(s.inner, 'option').map((o) => o.value)]));
    assert.deepEqual(selects.role, ['', ...ROLES]);
    assert.deepEqual(selects.team_size, ['', ...TEAM_SIZES]);

    const interview = inputs.find((i) => i.name === 'interview');
    assert.equal(interview?.type, 'checkbox');
    assert.equal(interview?.value, 'yes');

    for (const field of [email, interview, ...elements(form.inner, 'select').map((s) => s.attrs)]) {
      assert.ok(field?.id && form.inner.includes(`for="${field.id}"`), `${field?.name} has a label`);
    }

    assert.match(form.inner, /<button\b[^>]*type="submit"[^>]*>\s*Join the waitlist\s*<\/button>/);
  });

  it('hides the honeypot from people and screen readers, but not from bots', () => {
    const form = formWith(INDEX, 'join');
    const wrapper = /<div\b([^>]*)>(?:(?!<\/div>)[\s\S])*name="website"/.exec(form.inner);
    assert.ok(wrapper, 'the honeypot sits in its own wrapper');
    const attrs = parseAttrs(wrapper[1]);
    assert.equal(attrs.class, 'hp');
    assert.equal(attrs['aria-hidden'], 'true');
    const input = openTags(form.inner, 'input').find((i) => i.name === HONEYPOT_FIELD);
    assert.equal(input?.tabindex, '-1');
    assert.equal(input?.autocomplete, 'off');
    assert.ok(!('hidden' in (input ?? {})) && input?.type !== 'hidden', 'type=hidden is skipped by bots');
    assert.match(read('styles.css'), /\.hp\s*\{[^}]*position:\s*absolute;[^}]*left:\s*-10000px;/);
  });

  it('offers the founding plan at $5/month through the checkout route', () => {
    const pricing = /<section\b[^>]*id="pricing"[^>]*>([\s\S]*?)<\/section>/.exec(INDEX)?.[1] ?? '';
    const text = textOf(pricing);
    assert.match(text, /\$5\s*\/\s*month/);
    assert.match(text, /up to 50 people/);
    assert.match(text, /[Cc]ancel any time/);
    assert.match(text, /30 days/);
    const preorder = openTags(pricing, 'a').find((a) => a.href === '/api/checkout');
    assert.ok(preorder, 'a Pre-order link to /api/checkout');
    assert.match(pricing, /href="\/terms.html"/);
    const notice = openTags(INDEX, 'p').find((p) => p.id === 'checkout-notice');
    assert.ok(notice && 'hidden' in notice, 'a hidden notice for "pre-orders open soon"');
  });

  it("links to Google's own permissions page, as the extension does", () => {
    assert.ok(openTags(INDEX, 'a').some((a) => a.href === GOOGLE_PERMISSIONS_URL));
  });
});

describe('every site page', () => {
  for (const page of PAGES) {
    const html = read(page);

    it(`${page}: is a complete, mobile-ready page`, () => {
      assert.match(html, /^<!doctype html>/i);
      assert.match(html, /<html lang="en">/);
      assert.match(html, /<meta charset="utf-8">/);
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
      assert.ok(textOf(elements(html, 'title')[0]?.inner ?? '').includes('grantgate'));
      assert.match(html, /<meta name="description" content="[^"]{40,}">/);
      assert.equal(elements(html, 'h1').length, 1);
    });

    it(`${page}: loads only its own stylesheet and script, with nothing inline`, () => {
      assert.deepEqual(openTags(html, 'link').filter((l) => l.rel === 'stylesheet').map((l) => l.href), ['/styles.css']);
      const scripts = elements(html, 'script');
      assert.equal(scripts.length, 1);
      assert.equal(scripts[0].attrs.src, '/page.js');
      assert.equal(scripts[0].attrs.type, 'module');
      assert.equal(scripts[0].inner.trim(), '');
      assert.doesNotMatch(html, /<style\b/i);
      assert.doesNotMatch(html, /\sstyle\s*=/i);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
      assert.doesNotMatch(html, /javascript:/i);
    });

    it(`${page}: links only to files that exist, API routes, ids on the page, or https`, () => {
      const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
      const indexIds = new Set([...INDEX.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
      const targets = [
        ...openTags(html, 'a').map((a) => a.href),
        ...openTags(html, 'link').map((l) => l.href),
        ...openTags(html, 'script').map((s) => s.src),
        ...openTags(html, 'form').map((f) => f.action),
      ];
      for (const target of targets) {
        assert.ok(target, `${page}: an empty link`);
        if (target.startsWith('data:')) continue;
        if (/^https:\/\//.test(target)) continue;
        assert.doesNotMatch(target, /^[a-z]+:/i, `${page}: ${target}`);
        const [path, hash] = target.split('#');
        const file = path.split('?')[0];
        if (file === '') {
          assert.ok(ids.has(hash), `${page}: #${hash}`);
          continue;
        }
        assert.ok(file.startsWith('/'), `${page}: ${target} should be root-relative`);
        if (API_ROUTES.includes(file)) continue;
        if (file === '/page.js') continue; // built from src/site/page.ts
        const onDisk = file === '/' ? 'index.html' : file.slice(1);
        assert.ok(existsSync(join(SITE, onDisk)), `${page}: ${target}`);
        if (hash && onDisk === 'index.html') assert.ok(indexIds.has(hash), `${page}: ${target}`);
      }
      for (const a of openTags(html, 'a').filter((x) => /^https:/.test(x.href) && x.target === '_blank')) {
        assert.match(a.rel ?? '', /noopener/, a.href);
      }
    });

    it(`${page}: links to the privacy policy and the terms in its footer`, () => {
      const footer = elements(html, 'footer')[0]?.inner ?? '';
      assert.match(footer, /href="\/privacy.html"/);
      assert.match(footer, /href="\/terms.html"/);
    });
  }

  it('privacy.html says what is stored, where, and offers self-service removal', () => {
    const html = read('privacy.html');
    const text = textOf(html);
    for (const words of [/email address/, /role/, /team size/, /call/, /Neon/, /Vercel/, /Stripe/, /no analytics|No analytics/, /never leaves your browser|nothing leaves your browser/i]) {
      assert.match(text, words);
    }
    const form = formWith(html, 'leave');
    assert.equal(form.attrs.action, '/api/waitlist');
    assert.equal(form.attrs.method, 'post');
    assert.ok('data-waitlist' in form.attrs);
    assert.ok(html.includes(`id="${form.attrs['data-status']}"`));
    const email = openTags(form.inner, 'input').find((i) => i.name === 'email');
    assert.equal(email?.type, 'email');
    assert.ok(email && 'required' in email);
  });

  it('terms.html sets out the price, cancellation and refunds', () => {
    const text = textOf(read('terms.html'));
    assert.match(text, /\$5\s*\/\s*month/);
    assert.match(text, /30 days/);
    assert.match(text, /[Cc]ancel any time/);
    assert.match(text, /Stripe/);
  });
});

// --- The page script, on a fake DOM ---

interface Sent {
  url: string;
  init: RequestInit;
}

function setup(reply: () => Promise<Response>) {
  const form = new FakeElement('form');
  form.setAttribute('action', '/api/waitlist');
  const button = new FakeElement('button');
  button.type = 'submit';
  form.append(button);
  const status = new FakeElement('p');
  const sent: Sent[] = [];
  const values = { action: 'join', email: 'owner@acme.example', role: 'owner', team_size: '5-50', interview: 'yes', website: '' };
  enhanceForm({
    form: form as unknown as HTMLFormElement,
    status: status as unknown as HTMLElement,
    values: () => ({ ...values }),
    fetch: (url, init) => {
      sent.push({ url, init });
      return reply();
    },
  });
  return { form, button, status, sent, values };
}

const jsonReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('page.ts: the waitlist form with JS', () => {
  it('posts the form as JSON and shows the reply in place of the form', async () => {
    const { form, status, sent, values } = setup(async () => jsonReply({ ok: true, message: "You're on the list." }));
    const event = await form.dispatch('submit');
    assert.equal(event.defaultPrevented, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, '/api/waitlist');
    assert.equal(sent[0].init.method, 'POST');
    assert.deepEqual(sent[0].init.headers, { 'content-type': 'application/json', accept: 'application/json' });
    assert.deepEqual(JSON.parse(String(sent[0].init.body)), values);
    assert.equal(status.textContent, "You're on the list.");
    assert.equal(status.className, 'form-status success');
    assert.equal((form as unknown as { hidden: boolean }).hidden, true);
  });

  it('disables the button while sending and ignores a second submit', async () => {
    let release: (r: Response) => void = () => {};
    const { form, button, status, sent } = setup(() => new Promise<Response>((r) => (release = r)));
    const first = form.dispatch('submit');
    await new Promise((r) => setImmediate(r));
    assert.equal(button.disabled, true);
    assert.equal(status.textContent, SENDING);
    await form.dispatch('submit');
    assert.equal(sent.length, 1);
    release(jsonReply({ ok: true, message: 'Done.' }));
    await first;
    assert.equal(status.textContent, 'Done.');
  });

  it("shows the server's error and lets the person try again", async () => {
    let attempt = 0;
    const { form, button, status, sent } = setup(async () =>
      ++attempt === 1 ? jsonReply({ ok: false, error: "That email address doesn't look right." }, 400) : jsonReply({ ok: true, message: 'Joined.' }),
    );
    await form.dispatch('submit');
    assert.equal(status.textContent, "That email address doesn't look right.");
    assert.equal(status.className, 'form-status error');
    assert.equal(button.disabled, false);
    assert.notEqual((form as unknown as { hidden?: boolean }).hidden, true);
    await form.dispatch('submit');
    assert.equal(sent.length, 2);
    assert.equal(status.textContent, 'Joined.');
  });

  it('says the server could not be reached when the request fails', async () => {
    const { form, button, status } = setup(async () => {
      throw new TypeError('Failed to fetch');
    });
    await form.dispatch('submit');
    assert.equal(status.textContent, NETWORK_ERROR);
    assert.equal(status.className, 'form-status error');
    assert.equal(button.disabled, false);
  });

  it('copes with a reply that is not the JSON it expects', async () => {
    for (const reply of [
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
      () => jsonReply({ ok: true }),
      () => jsonReply({ ok: false, error: 42 }),
      () => jsonReply(['ok']),
    ]) {
      const { form, status } = setup(async () => reply());
      await form.dispatch('submit');
      assert.equal(status.textContent, UNEXPECTED_REPLY);
    }
  });

  it('renders server text as text, never as HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { form, status } = setup(async () => jsonReply({ ok: true, message: hostile }));
    await form.dispatch('submit');
    assert.equal(status.textContent, hostile);
    assert.deepEqual(status.children, [hostile]);
  });
});

describe('page.ts: the "pre-orders open soon" notice', () => {
  it('shows after a pre-order click while checkout is not open yet', () => {
    const notice = new FakeElement('p');
    (notice as unknown as { hidden: boolean }).hidden = true;
    assert.equal(showCheckoutNotice(notice as unknown as HTMLElement, '?checkout=soon'), true);
    assert.equal(notice.textContent, CHECKOUT_SOON);
    assert.equal((notice as unknown as { hidden: boolean }).hidden, false);
  });

  it('stays hidden otherwise', () => {
    for (const search of ['', '?checkout=open', '?ref=newsletter', '?checkout=soonish']) {
      const notice = new FakeElement('p');
      (notice as unknown as { hidden: boolean }).hidden = true;
      assert.equal(showCheckoutNotice(notice as unknown as HTMLElement, search), false, search);
      assert.equal((notice as unknown as { hidden: boolean }).hidden, true);
    }
    assert.equal(showCheckoutNotice(null, '?checkout=soon'), false);
  });
});
