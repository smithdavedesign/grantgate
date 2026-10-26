// The website's public pages, and what the build adds to each one for search and sharing:
//
//   <!-- grantgate:head -->   title, description, canonical URL, Open Graph and Twitter
//                             tags with the share image, the deployment, and JSON-LD
//                             (a SoftwareApplication with its $49/year offer)
//   <!-- grantgate:buy -->    the Buy button, linking to STRIPE_PAYMENT_LINK; when that
//                             isn't set, the waitlist button instead (index.html only)
//
// plus robots.txt, sitemap.xml and the Vercel routes that serve /privacy and /terms.
// Everything here is decided at build time: the pages stay static files.

import { checkoutTarget, escapeHtml } from '../src/site/api.ts';
import { DEPLOYMENT_META } from '../src/site/page.ts';

/** The <meta name> that tells page.js which deployment it is on (only "production" is counted). */
export { DEPLOYMENT_META };

type Env = Readonly<Record<string, string | undefined>>;

/** Where the site lives when Vercel doesn't say: the project's own vercel.app domain. */
export const DEFAULT_ORIGIN = 'https://grantgate.vercel.app';

export const HEAD_MARKER = '<!-- grantgate:head -->';
export const BUY_MARKER = '<!-- grantgate:buy -->';

/** The one plan, as REVENUE.md prices it. */
export const PRICE = Object.freeze({ amount: '49.00', currency: 'USD', label: '$49/year' });

/** Drawn by scripts/share-image.ts at build time. */
export const SHARE_IMAGE = Object.freeze({
  file: 'og.png',
  width: 1200,
  height: 630,
  alt: 'grantgate: a gate that stops risky “Sign in with Google” grants until you have checked them',
});

export interface PublicPage {
  /** The URL path it is served at. */
  path: string;
  /** Its source in site/, and its file in the build. */
  file: string;
  title: string;
  description: string;
}

export const PUBLIC_PAGES: readonly PublicPage[] = Object.freeze([
  {
    path: '/',
    file: 'index.html',
    title: 'grantgate — stop risky “Sign in with Google” grants',
    description:
      "A browser extension that stops risky “Sign in with Google” grants until you've checked them, explains each permission in plain English, and logs every sign-in.",
  },
  {
    path: '/privacy',
    file: 'privacy.html',
    title: 'Privacy — grantgate',
    description:
      'What grantgate collects: nothing from the extension, your answers if you join the waitlist, and an anonymous count of visits. No cookies.',
  },
  {
    path: '/terms',
    file: 'terms.html',
    title: 'Terms — grantgate',
    description: "grantgate's terms: $49 a year for one business of up to 50 people, a full refund within 30 days with no questions asked, and no warranty.",
  },
]);

export interface BuildConfig {
  /** https://host, no trailing slash. */
  origin: string;
  /** The Stripe Payment Link, or null to leave the Buy button out. */
  paymentLink: string | null;
  /** Vercel's VERCEL_ENV: production, preview or development. */
  deployment: string;
}

export function buildConfig(env: Env): BuildConfig {
  const deployment = env.VERCEL_ENV ?? '';
  return {
    origin: siteOrigin(env),
    paymentLink: paymentLink(env),
    deployment: /^[a-z]+$/.test(deployment) ? deployment : 'development',
  };
}

/** The payment link from STRIPE_PAYMENT_LINK, when it is https with no credentials; otherwise null. */
export function paymentLink(env: Env): string | null {
  return checkoutTarget(env.STRIPE_PAYMENT_LINK);
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The production origin. Vercel sets VERCEL_PROJECT_PRODUCTION_URL (a bare host name) in
 * every build, previews included, to the custom domain if there is one; canonical URLs
 * always point there.
 */
export function siteOrigin(env: Env): string {
  const host = (env.VERCEL_PROJECT_PRODUCTION_URL ?? '').trim().toLowerCase();
  return HOSTNAME.test(host) ? `https://${host}` : DEFAULT_ORIGIN;
}

const pageUrl = (origin: string, path: string) => `${origin}${path}`;

/** The page's source with its head tags and (on the landing page) the Buy button filled in. */
export function renderPage(source: string, page: PublicPage, config: BuildConfig): string {
  const count = (marker: string) => source.split(marker).length - 1;
  if (count(HEAD_MARKER) !== 1) throw new Error(`${page.file} needs exactly one ${HEAD_MARKER}, on a line of its own`);
  if (count(BUY_MARKER) > 1) throw new Error(`${page.file} has more than one ${BUY_MARKER}`);
  // Replacer functions, so a "$" in the payment link is never read as a replacement pattern.
  const html = source
    .replace(ownLine(HEAD_MARKER), (_, indent: string) => indented(headTags(page, config), indent))
    .replace(ownLine(BUY_MARKER), (_, indent: string) => indented(buyBlock(config.paymentLink), indent));
  if (html.includes('<!-- grantgate:')) throw new Error(`${page.file}: a grantgate marker must be on a line of its own`);
  return html;
}

function ownLine(marker: string): RegExp {
  return new RegExp(`^([ \\t]*)${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
}

const indented = (lines: string[], indent: string) => lines.map((line) => indent + line).join('\n');

function headTags(page: PublicPage, config: BuildConfig): string[] {
  const url = pageUrl(config.origin, page.path);
  const image = pageUrl(config.origin, `/${SHARE_IMAGE.file}`);
  const meta = (kind: 'name' | 'property', key: string, value: string) => `<meta ${kind}="${key}" content="${escapeHtml(value)}">`;
  return [
    `<title>${escapeHtml(page.title)}</title>`,
    meta('name', 'description', page.description),
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', 'grantgate'),
    meta('property', 'og:title', page.title),
    meta('property', 'og:description', page.description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', image),
    meta('property', 'og:image:type', 'image/png'),
    meta('property', 'og:image:width', String(SHARE_IMAGE.width)),
    meta('property', 'og:image:height', String(SHARE_IMAGE.height)),
    meta('property', 'og:image:alt', SHARE_IMAGE.alt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', page.title),
    meta('name', 'twitter:description', page.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', SHARE_IMAGE.alt),
    meta('name', DEPLOYMENT_META, config.deployment),
    // "<" is escaped so nothing in the data can close the script element.
    `<script type="application/ld+json">${JSON.stringify(structuredData(config)).replace(/</g, '\\u003c')}</script>`,
  ];
}

function buyBlock(link: string | null): string[] {
  if (link === null) {
    return [
      '<a class="button primary wide" href="#join">Join the waitlist</a>',
      `<p class="fineprint">Checkout opens soon. Join the waitlist and you'll hear first.</p>`,
    ];
  }
  return [
    `<a class="button primary wide" href="${escapeHtml(link)}" data-buy>Buy for ${PRICE.label}</a>`,
    '<p class="fineprint">Not ready to pay? <a href="#join">Join the waitlist</a> for free.</p>',
  ];
}

/** schema.org data for search engines: the same on every page. */
export function structuredData(config: BuildConfig): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'grantgate',
    description: PUBLIC_PAGES[0].description,
    url: pageUrl(config.origin, '/'),
    image: pageUrl(config.origin, `/${SHARE_IMAGE.file}`),
    applicationCategory: 'SecurityApplication',
    operatingSystem: 'Chrome and other Chromium browsers',
    offers: {
      '@type': 'Offer',
      price: PRICE.amount,
      priceCurrency: PRICE.currency,
      url: pageUrl(config.origin, '/#pricing'),
      description: 'One business of up to 50 people, billed yearly. Full refund within 30 days, no questions asked.',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: PRICE.amount,
        priceCurrency: PRICE.currency,
        billingDuration: 'P1Y',
        unitText: 'year',
      },
    },
  };
}

export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`;
}

export function sitemapXml(origin: string): string {
  const urls = PUBLIC_PAGES.map((page) => `  <url><loc>${escapeHtml(pageUrl(origin, page.path))}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

export type PageRoute = { src: string; status: number; headers: { Location: string } } | { src: string; dest: string };

/**
 * Build Output API routes for the clean page URLs: /privacy is served from privacy.html,
 * and the old /privacy.html address moves there permanently. The local server follows them too.
 */
export function pageRoutes(): PageRoute[] {
  return PUBLIC_PAGES.filter((page) => page.path !== '/').flatMap((page): PageRoute[] => {
    const name = page.path.slice(1);
    return [
      { src: `^/${name}\\.html$`, status: 308, headers: { Location: page.path } },
      { src: `^/${name}$`, dest: `/${page.file}` },
    ];
  });
}
