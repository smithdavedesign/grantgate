import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUY_MARKER,
  DEFAULT_ORIGIN,
  DEPLOYMENT_META,
  HEAD_MARKER,
  PRICE,
  PUBLIC_PAGES,
  SHARE_IMAGE,
  buildConfig,
  pageRoutes,
  paymentLink,
  renderPage,
  robotsTxt,
  siteOrigin,
  sitemapXml,
  structuredData,
  type BuildConfig,
} from '../scripts/site-pages.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = (file: string) => readFileSync(join(ROOT, 'site', file), 'utf8');
const PAY = 'https://example.com/pay';
const BASE: BuildConfig = { origin: DEFAULT_ORIGIN, paymentLink: null, deployment: 'production' };
const render = (file: string, config: Partial<BuildConfig> = {}) => {
  const page = PUBLIC_PAGES.find((p) => p.file === file);
  assert.ok(page, file);
  return renderPage(source(file), page, { ...BASE, ...config });
};

/** The content of <meta name|property="key" content="…">, decoded; undefined when absent, and fails when repeated. */
function meta(html: string, key: string): string | undefined {
  const found = [...html.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)">/g)].filter((m) => m[1] === key);
  assert.ok(found.length <= 1, `${key} appears ${found.length} times`);
  return found[0]?.[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const title = (html: string) => [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
const canonical = (html: string) => [...html.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]);

function jsonLd(html: string): Record<string, any> {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, 'one JSON-LD block');
  return JSON.parse(blocks[0][1]);
}

const buyLinks = (html: string) => [...html.matchAll(/<a\b([^>]*\bdata-buy\b[^>]*)>([\s\S]*?)<\/a>/g)];

describe('the public pages', () => {
  it('are the landing page, privacy and terms, each with its own file', () => {
    assert.deepEqual(PUBLIC_PAGES.map((p) => p.path), ['/', '/privacy', '/terms']);
    for (const page of PUBLIC_PAGES) assert.ok(existsSync(join(ROOT, 'site', page.file)), page.file);
  });

  it('each have a unique title and description of a useful length', () => {
    assert.equal(new Set(PUBLIC_PAGES.map((p) => p.title)).size, PUBLIC_PAGES.length);
    assert.equal(new Set(PUBLIC_PAGES.map((p) => p.description)).size, PUBLIC_PAGES.length);
    for (const page of PUBLIC_PAGES) {
      assert.match(page.title, /grantgate/);
      assert.ok(page.title.length <= 65, `${page.path}: title is ${page.title.length} characters`);
      assert.ok(page.description.length >= 70 && page.description.length <= 170, `${page.path}: description is ${page.description.length} characters`);
    }
  });

  it('only the landing page sells: the Buy marker is on index.html alone', () => {
    for (const page of PUBLIC_PAGES) {
      assert.equal(source(page.file).split(HEAD_MARKER).length, 2, `${page.file} has one head marker`);
      assert.equal(source(page.file).split(BUY_MARKER).length, page.file === 'index.html' ? 2 : 1, page.file);
      assert.doesNotMatch(source(page.file), /<title>|name="description"/, `${page.file}: the title and description come from PUBLIC_PAGES`);
    }
  });
});

describe('renderPage: search and sharing tags', () => {
  for (const page of PUBLIC_PAGES) {
    const html = render(page.file);
    const url = page.path === '/' ? `${DEFAULT_ORIGIN}/` : `${DEFAULT_ORIGIN}${page.path}`;

    it(`${page.path}: has its title, description and canonical URL, once each`, () => {
      assert.deepEqual(title(html), [page.title.replace(/&/g, '&amp;')]);
      assert.equal(meta(html, 'description'), page.description);
      assert.deepEqual(canonical(html), [url]);
      assert.doesNotMatch(html, /<!-- grantgate:/, 'no marker is left behind');
    });

    it(`${page.path}: has Open Graph tags with the 1200×630 share image`, () => {
      assert.equal(meta(html, 'og:type'), 'website');
      assert.equal(meta(html, 'og:site_name'), 'grantgate');
      assert.equal(meta(html, 'og:title'), page.title);
      assert.equal(meta(html, 'og:description'), page.description);
      assert.equal(meta(html, 'og:url'), url);
      assert.equal(meta(html, 'og:image'), `${DEFAULT_ORIGIN}/${SHARE_IMAGE.file}`);
      assert.equal(meta(html, 'og:image:type'), 'image/png');
      assert.equal(meta(html, 'og:image:width'), '1200');
      assert.equal(meta(html, 'og:image:height'), '630');
      assert.ok((meta(html, 'og:image:alt') ?? '').length > 20);
    });

    it(`${page.path}: has a large-image Twitter card`, () => {
      assert.equal(meta(html, 'twitter:card'), 'summary_large_image');
      assert.equal(meta(html, 'twitter:title'), page.title);
      assert.equal(meta(html, 'twitter:description'), page.description);
      assert.equal(meta(html, 'twitter:image'), `${DEFAULT_ORIGIN}/${SHARE_IMAGE.file}`);
      assert.equal(meta(html, 'twitter:image:alt'), meta(html, 'og:image:alt'));
    });

    it(`${page.path}: describes grantgate as a SoftwareApplication with a $49/year offer`, () => {
      const data = jsonLd(html);
      assert.equal(data['@context'], 'https://schema.org');
      assert.equal(data['@type'], 'SoftwareApplication');
      assert.equal(data.name, 'grantgate');
      assert.equal(data.url, `${DEFAULT_ORIGIN}/`);
      assert.equal(data.image, `${DEFAULT_ORIGIN}/${SHARE_IMAGE.file}`);
      assert.equal(typeof data.applicationCategory, 'string');
      assert.equal(typeof data.operatingSystem, 'string');
      assert.equal(data.offers['@type'], 'Offer');
      assert.equal(data.offers.price, '49.00');
      assert.equal(data.offers.priceCurrency, 'USD');
      assert.equal(data.offers.priceSpecification['@type'], 'UnitPriceSpecification');
      assert.equal(data.offers.priceSpecification.price, '49.00');
      assert.equal(data.offers.priceSpecification.billingDuration, 'P1Y');
      assert.deepEqual(data, structuredData(BASE));
    });

    it(`${page.path}: says which deployment it was built for`, () => {
      assert.equal(meta(html, DEPLOYMENT_META), 'production');
      assert.equal(meta(render(page.file, { deployment: 'preview' }), DEPLOYMENT_META), 'preview');
    });
  }

  it('uses the configured origin everywhere', () => {
    const html = render('privacy.html', { origin: 'https://grantgate.example' });
    assert.deepEqual(canonical(html), ['https://grantgate.example/privacy']);
    assert.equal(meta(html, 'og:image'), 'https://grantgate.example/og.png');
    assert.equal(jsonLd(html).url, 'https://grantgate.example/');
    assert.ok(!html.includes(DEFAULT_ORIGIN));
  });

  it('keeps the JSON-LD from closing its script element', () => {
    const data = JSON.stringify(structuredData(BASE));
    const html = render('index.html');
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    assert.doesNotMatch(block, /</);
    assert.deepEqual(JSON.parse(block), JSON.parse(data));
  });

  it('refuses a page without its head marker', () => {
    assert.throws(() => renderPage('<!doctype html><head></head>', PUBLIC_PAGES[1], BASE), /grantgate:head/);
  });

  it('the price in the structured data is the price on the page', () => {
    assert.deepEqual(PRICE, { amount: '49.00', currency: 'USD', label: '$49/year' });
    const text = render('index.html').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /\$49 \/ year/);
  });
});

describe('the Buy button', () => {
  it('is left out of the page when STRIPE_PAYMENT_LINK is unset', () => {
    const html = render('index.html');
    assert.equal(buyLinks(html).length, 0);
    assert.doesNotMatch(html, /\bBuy\b/);
    assert.doesNotMatch(html, /stripe\.com|example\.com\/pay/);
    // The pricing card still has somewhere to go.
    const pricing = /<section\b[^>]*id="pricing"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    assert.match(pricing, /<a class="button primary wide" href="#join">Join the waitlist<\/a>/);
  });

  it('links straight to the payment link when it is set', () => {
    const html = render('index.html', { paymentLink: PAY });
    const links = buyLinks(html);
    assert.equal(links.length, 1);
    assert.match(links[0][1], new RegExp(`href="${PAY}"`));
    assert.match(links[0][1], /class="button primary wide"/);
    assert.match(links[0][2], /Buy/);
    assert.match(links[0][2], /\$49\/year/);
    const pricing = /<section\b[^>]*id="pricing"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    assert.ok(pricing.includes(links[0][0]), 'in the pricing card');
    assert.match(pricing, /href="#join"/, 'with the waitlist as the free alternative');
  });

  it('escapes the link it puts in the page', () => {
    const html = render('index.html', { paymentLink: 'https://buy.stripe.example/x?a=1&b="2"' });
    assert.match(buyLinks(html)[0][1], /href="https:\/\/buy\.stripe\.example\/x\?a=1&amp;b=&quot;2&quot;"/);
  });

  it('never appears on the privacy or terms page', () => {
    for (const file of ['privacy.html', 'terms.html']) assert.equal(buyLinks(render(file, { paymentLink: PAY })).length, 0, file);
  });
});

describe('buildConfig: what the build reads from the environment', () => {
  it('takes the payment link from STRIPE_PAYMENT_LINK only, when it is plain https', () => {
    assert.equal(paymentLink({}), null);
    assert.equal(paymentLink({ STRIPE_PAYMENT_LINK: '' }), null);
    assert.equal(paymentLink({ STRIPE_PAYMENT_LINK: PAY }), PAY);
    assert.equal(paymentLink({ STRIPE_PAYMENT_LINK: `  ${PAY}  ` }), PAY);
    assert.equal(paymentLink({ CHECKOUT_URL: PAY, NEXT_PUBLIC_STRIPE_PAYMENT_LINK: PAY }), null);
    const withCredentials = ['https://', 'user', ':', 'Pw9'.repeat(4), '@example.com/pay'].join('');
    for (const bad of ['http://example.com/pay', withCredentials, 'javascript:alert(1)', 'not a url', '/pay']) {
      assert.equal(paymentLink({ STRIPE_PAYMENT_LINK: bad }), null, bad);
    }
  });

  it("uses the project's production domain from Vercel, or grantgate.vercel.app", () => {
    assert.equal(DEFAULT_ORIGIN, 'https://grantgate.vercel.app');
    assert.equal(siteOrigin({}), DEFAULT_ORIGIN);
    assert.equal(siteOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'grantgate.example' }), 'https://grantgate.example');
    assert.equal(siteOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'GrantGate-x1.vercel.app' }), 'https://grantgate-x1.vercel.app');
    for (const bad of ['', 'https://grantgate.example', 'grantgate.example/path', 'evil.example@grantgate.example', 'a b', 'grantgate.example:8080']) {
      assert.equal(siteOrigin({ VERCEL_PROJECT_PRODUCTION_URL: bad }), DEFAULT_ORIGIN, bad);
    }
  });

  it("bakes in VERCEL_ENV, and anything that isn't a plain word counts as development", () => {
    assert.equal(buildConfig({}).deployment, 'development');
    assert.equal(buildConfig({ VERCEL_ENV: 'production' }).deployment, 'production');
    assert.equal(buildConfig({ VERCEL_ENV: 'preview' }).deployment, 'preview');
    assert.equal(buildConfig({ VERCEL_ENV: '"><script>' }).deployment, 'development');
    assert.deepEqual(buildConfig({ STRIPE_PAYMENT_LINK: PAY, VERCEL_ENV: 'production' }), {
      origin: DEFAULT_ORIGIN,
      paymentLink: PAY,
      deployment: 'production',
    });
  });
});

describe('robots.txt and sitemap.xml', () => {
  it('robots.txt allows indexing and points at the sitemap', () => {
    const robots = robotsTxt(DEFAULT_ORIGIN);
    assert.match(robots, /^User-agent: \*$/m);
    assert.match(robots, /^Allow: \/$/m);
    assert.doesNotMatch(robots, /^Disallow: \/$/m);
    assert.match(robots, /^Disallow: \/api\/$/m);
    assert.match(robots, new RegExp(`^Sitemap: ${DEFAULT_ORIGIN}/sitemap\\.xml$`, 'm'));
    assert.ok(robots.endsWith('\n'));
  });

  it('sitemap.xml lists every public page, and nothing else', () => {
    const xml = sitemapXml(DEFAULT_ORIGIN);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.ok(xml.trimEnd().endsWith('</urlset>'));
    const locs = [...xml.matchAll(/<url><loc>([^<]+)<\/loc><\/url>/g)].map((m) => m[1]);
    assert.deepEqual(locs, [`${DEFAULT_ORIGIN}/`, `${DEFAULT_ORIGIN}/privacy`, `${DEFAULT_ORIGIN}/terms`]);
    assert.equal([...xml.matchAll(/<loc>/g)].length, PUBLIC_PAGES.length);
  });
});

describe('pageRoutes: clean URLs on Vercel', () => {
  it('serves /privacy and /terms from their files, and moves the old .html addresses there', () => {
    assert.deepEqual(pageRoutes(), [
      { src: '^/privacy\\.html$', status: 308, headers: { Location: '/privacy' } },
      { src: '^/privacy$', dest: '/privacy.html' },
      { src: '^/terms\\.html$', status: 308, headers: { Location: '/terms' } },
      { src: '^/terms$', dest: '/terms.html' },
    ]);
    for (const route of pageRoutes()) assert.doesNotThrow(() => new RegExp(route.src));
  });
});
