# grantgate — launch readiness

Date: 2026-10-26. This pass makes the website ready for a public launch. What grantgate does is unchanged: the extension, the gate, the ledger, the waitlist and the API all work as before. Nobody was available to ask, so every decision is written down below.

**Status:**
- `npm test`: 489 of 489 pass (419 before this pass).
- `npm run typecheck`: clean.
- `npm run screenshots`: 6 PNGs, each opened and checked.

## What I did

1. **Search and sharing.**
   - **Every public page** (`/`, `/privacy`, `/terms`) gets these from one table, `PUBLIC_PAGES` in `scripts/site-pages.ts`:
     - its own `<title>` and meta description;
     - a canonical URL;
     - Open Graph and Twitter `summary_large_image` tags;
     - the 1200×630 share image;
     - JSON-LD for a `SoftwareApplication` with an `Offer` of $49.00 USD, and a `UnitPriceSpecification` with `billingDuration: P1Y`.
   - **How it gets there:** the build writes it into each page at a `<!-- grantgate:head -->` marker.
   - **robots.txt** allows everything except `/api/` and points at the sitemap.
   - **sitemap.xml** lists the three pages.
   - **The share image** (`og.png`) is drawn in code at build time by `scripts/share-image.ts`, with a small PNG encoder on `node:zlib`. It shows the logo, a stroke-drawn "grantgate" wordmark, and a card like the interstitial with a no-entry sign. No image was copied, and no font or package is needed.
   - **Why no framework helpers:** this isn't Next.js. The site is static files built by `scripts/build-site.ts` into Vercel's Build Output API, so the build script is the convention used here.
2. **Privacy (`/privacy`) and terms (`/terms`)**, both linked from every footer.
   - **Privacy page** says:
     - the extension collects nothing;
     - what the waitlist stores, and where;
     - no cookies;
     - the visit beacon and its three events (`visit`, `activate`, `checkout`), what each message holds, and how to switch it off;
     - Stripe handles payment;
     - contact is through GitHub issues.
   - **Terms page** says:
     - $49 a year for one business of up to 50 people;
     - a full refund within 30 days of any payment, no questions asked;
     - no warranty;
     - GitHub issues for contact.
   - **Old addresses:** `/privacy.html` and `/terms.html` now redirect there with a 308.
3. **Buy button.**
   - **When `STRIPE_PAYMENT_LINK` is set** at build time, the pricing card shows **Buy for $49/year**. It links straight to that URL, which must be `https:` with no credentials.
   - **When it's unset or invalid,** the button is left out of the HTML entirely, and the card offers the waitlist instead. An invalid value is logged by name only.
   - **`/api/checkout`** reads the same variable. It used to read `CHECKOUT_URL`.
   - **The price on the page** is now $49/year, from REVENUE.md. It used to be $5/month.
4. **Visit beacon** (`src/site/page.ts`, served as `/page.js` on every page).
   - **What it sends:** a POST of `{"slug":"grantgate","kind":…,"referrer":…}` to `https://repohq.vercel.app/api/ideas/signal`, with `keepalive`, `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`. It's fire-and-forget: errors are swallowed.
   - **The three events:**
     - `visit`: once per browser session (sessionStorage);
     - `activate`: once per browser (localStorage);
     - `checkout`: each click on Buy.
   - **The core action, for `activate`:** a successful waitlist **join** (not a removal, not a filled honeypot).
     - The extension is the real product, but it promises that nothing leaves the browser and has no server, so it stays silent.
     - Joining the waitlist is the website's core action.
   - **referrer** is `document.referrer` only when its origin differs from `location.origin`; otherwise it's `null`.
   - **When nothing is sent:**
     - when `navigator.webdriver` is true;
     - when the build wasn't production (the build writes `VERCEL_ENV` into `<meta name="vercel-env">`, so local runs, previews and screenshot runs count as non-production);
     - when localStorage `repohq:notrack` is set;
     - when storage can't be read or written.
   - **CSP:** `connect-src` now allows `https://repohq.vercel.app` as well as the site itself. Nothing else in the CSP changed.
5. **`.provision`** asks for the Vercel project and the Stripe payment link, exactly as the brief says.
6. **Tests:**
   - `test/site-launch.test.ts`: the metadata, JSON-LD, robots, sitemap, routes, and the Buy button with and without the variable;
   - `test/site-signal.test.ts`: the beacon;
   - `test/share-image.test.ts`: a decoded PNG at 1200×630, with valid CRCs and the same bytes every build;
   - updates to the page, build, server and API tests. These cover every page rendering at its clean URL, the redirects, robots.txt, sitemap.xml and og.png being served, and the build with and without `STRIPE_PAYMENT_LINK`.
   - To check that the tests bite, I injected three bugs one at a time and reverted each. All were caught: the beacon ignoring `navigator.webdriver`, a same-site referrer being sent, and the Buy button rendered with no link.
7. **Screenshots** (`npm run screenshots`): the home page, the gate, and the page after joining the waitlist, each at 1280×800 and on an iPhone 13.
   - The server it starts is given the placeholder `STRIPE_PAYMENT_LINK=https://example.com/pay`.
   - The script fails if the Buy button or the footer links are missing.
   - The desktop "joined" shot shows the Buy button, the reply and the footer's Privacy and Terms links together.
   - The README's Screenshots section was replaced.

## Decisions (no one to ask)

| Question | Decision | Why |
|---|---|---|
| $5/month (the site) or $49/year (REVENUE.md)? | **$49/year**, on the page, in the terms and in the JSON-LD. | REVENUE.md is newer and the brief asks for it. The price changed; the product didn't. |
| Clean URLs | `/privacy` and `/terms` are rewrites to the `.html` files, and the old addresses 308 there. The local server follows the same routes table. | The brief names `/privacy` and `/terms`, and old links keep working. |
| Which domain do canonical URLs use? | `VERCEL_PROJECT_PRODUCTION_URL` (Vercel sets it at build time, to the custom domain if there is one). Otherwise `https://grantgate.vercel.app`. | A custom domain then needs no code change. Preview builds still point at production. |
| How does the browser know it's production? | The build writes `VERCEL_ENV` into `<meta name="vercel-env">`. Only `production` is counted. | It's static HTML with a strict CSP (no inline script), so build-time is the only time to know. It's the same idea as `NEXT_PUBLIC_VERCEL_ENV`. |
| How is the payment link read? | `STRIPE_PAYMENT_LINK` at **build** time; the button is left out if it's missing. Changing it needs a redeploy. | Static pages; no endpoint to fetch config from. Vercel needs a redeploy for env changes anyway. |
| Keep `/api/checkout`? | Yes, now reading `STRIPE_PAYMENT_LINK`. `CHECKOUT_URL` is no longer read. | Removing a route is a bigger change than this pass needs, and one variable name is less confusing than two. `CHECKOUT_URL` was never set, because the Stripe link didn't exist yet. |
| Beacon `Content-Type` | The body is JSON, labelled `text/plain;charset=UTF-8`. | A CORS-simple request has no preflight. It arrives even if RepoHQ doesn't answer `OPTIONS`, and keepalive works in every browser. RepoHQ must parse the body as JSON whatever the header says (`req.json()` does). |
| Storage refused | Send nothing. | We can't check the owner's `repohq:notrack` flag or remember that we already counted, so sending could double-count or count the owner. |
| JSON-LD on every page | The same `SoftwareApplication` on all three pages. | The brief asks for it on every public page. `<` is escaped so the data can't close its script tag. JSON-LD is a data block, so the CSP's `script-src 'self'` still holds. |
| Share image | Drawn with signed-distance shapes and a stroke wordmark, about 25 KB. | No font is available at build time on Vercel, and the brief rules out copied images. |
| Contact | GitHub issues (`smithdavedesign/grantgate`). The pages warn that issues are public, and refunds are found by Stripe receipt number. | As the brief says. There's no mailbox yet. |

## How to check it

**Locally:**
```sh
npm ci && npm test                       # 489 tests, no browser or network
npm run site                             # http://localhost:4321/: no Buy button (no STRIPE_PAYMENT_LINK)
STRIPE_PAYMENT_LINK=https://example.com/pay npm run site   # Buy for $49/year appears in Pricing
npm run build:site                       # .vercel/output/static has robots.txt, sitemap.xml, og.png
npm run screenshots                      # needs CHROMIUM_PATH
```
Then:
- view the source of `/`, `/privacy` and `/terms`: each has its own title, description and canonical URL, the `og:*` and `twitter:*` tags, and one JSON-LD block;
- `/privacy.html` redirects to `/privacy`.

**After deploying:**
1. View the source of the live home page. It should have:
   - `<meta name="vercel-env" content="production">`;
   - the canonical URL on the production domain.

   If it says `development`, the project has "Automatically expose System Environment Variables" turned off. Turn it on and redeploy, or no visits will be counted.
2. Open `/robots.txt`, `/sitemap.xml` and `/og.png`. Paste the home URL into a share-card previewer (for example, LinkedIn's Post Inspector or the Twitter/X card preview) and check the image and title.
3. Paste the home URL into Google's Rich Results Test and check that the SoftwareApplication is read.
4. In a normal browser window, open the site, then DevTools › Network:
   - one `signal` POST (`visit`) on the first page;
   - none on the second;
   - one `activate` after joining the waitlist;
   - one `checkout` per Buy click.

   Then run `localStorage.setItem('repohq:notrack', '1')` in the console: nothing more is sent from that browser. Do this in your own browser so your visits aren't counted.
5. **Check RepoHQ's side:** the visits show up for `grantgate`. If none do, the endpoint may not accept a `text/plain` body; see "Remaining risks".
6. **The waitlist still saves sign-ups.** Join with a test address, then remove it on `/privacy`. A 503 means `DATABASE_URL` isn't set in the Vercel project, which M4's `.provision` asked for.

## What's left for David

1. **The Stripe payment link.** `.provision` requests it.
   - Create a $49/year recurring Payment Link in Stripe.
   - Paste its URL into the Vercel project's env as **`STRIPE_PAYMENT_LINK`** (Production).
   - Redeploy. The Buy button appears only after a redeploy, because the link is read at build time.
2. **A custom domain**, if you want one: add it in Vercel and redeploy. Canonical URLs, the sitemap, robots.txt and the share image follow `VERCEL_PROJECT_PRODUCTION_URL`, so no code change is needed.
3. **Mark your own browser** with `localStorage.setItem('repohq:notrack', '1')` on the live site.
4. **Before charging:**
   - give the privacy and terms pages a quick read (they name no jurisdiction);
   - make sure the GitHub repo is public, so the contact link works;
   - think about a free forwarding mailbox, since refunds shouldn't need a public issue.
5. Still open from earlier milestones: the 10 interviews, and the extension checked in a real browser (see BUILD.md › What's left). REVENUE.md's first step also still stands: try AppTotal against a real consent screen before spending on outreach.

## Self-review (gstack pre-landing checklist)

I reviewed `git status` and `git diff`, plus the new files (`scripts/site-pages.ts`, `scripts/share-image.ts`, three test files and `.provision`).

**Pass 1 — CRITICAL:** no open findings.
- **SQL & data safety, races:** no SQL changed.
  - The only new check-then-set is the storage mark for `visit` and `activate`. At worst, two tabs joining at the same moment count `activate` twice. That's an analytics count, not data, so it doesn't need to be atomic.
- **Unsafe HTML (XSS):** everything the build puts into HTML is either a constant or validated, and all of it is escaped:
  - the payment link must be an https URL, and is HTML-escaped (tested with `&` and `"`);
  - the deployment must be `[a-z]+`;
  - the origin must be a strict host name;
  - JSON-LD has `<` escaped (tested).

  `page.js` still renders only with `textContent`. The CSP's `script-src` is unchanged.
- **Open redirect:** both the Buy link and `/api/checkout` come only from the environment, https with no credentials. The new 308 redirects go to fixed paths.
- **Trust boundaries:**
  - The beacon sends three fields, none of them user input. The referrer is only another site's URL, never this site's (tested, and an injected bug was caught).
  - No cookies (`credentials: 'omit'`), and no referrer header.
  - A logged invalid payment link shows its name, never its value (tested).
- **Shell injection:** the screenshot script still spawns `node` with an argument array. It now passes the environment through to the server with a placeholder link and without `VERCEL_ENV`. Nothing is printed.
- **Enum completeness:**
  - **The three event kinds:** `SignalKind` is used by `sendSignal` and `signalOnce` (whose type only allows visit and activate). All three are named on the privacy page (tested).
  - **`PUBLIC_PAGES`:** read by the build, routes, sitemap, local server and tests. A test requires the pages in `PUBLIC_PAGES` to match the `.html` files in `site/`.
  - **`GENERATED_FILES`:** a test requires them to match what the build emits.
  - **`CHECKOUT_URL` → `STRIPE_PAYMENT_LINK`:** every reader was updated (the API, build, docs and tests). A test checks that the old name is no longer read.

**Pass 2 — INFORMATIONAL (fixed):**
- **The beacon's `Content-Type`** changed from `application/json` to `text/plain`, so there's no CORS preflight (decision above). Confidence 7/10 that preflight would have dropped some events.
- **Stale docs:**
  - BUILD.md's run, deploy, infrastructure and "what's left" sections;
  - the interview script's "pre-order" lines;
  - the README one-liner ("a few dollars a month");
  - the package description.
- **Hygiene:**
  - Version 0.4.0 → 0.5.0 in `package.json` and `package-lock.json`.
  - An existing test had a credential-shaped URL literal; it's now built at runtime.

**Remaining risks (not fixed, by decision):**
- **P2 (confidence 6/10) — unverified on Vercel:** the new `routes` entries (a 308 with `headers.Location`, and a `dest` rewrite) come from memory of the Build Output API. The local server follows the same table, and the deploy check covers it. If `/privacy` 404s on Vercel, the pages are still at `/privacy.html`.
- **P2 (confidence 5/10) — RepoHQ might want `Content-Type: application/json`:** if so, change one header in `sendSignal`. RepoHQ would then also need to answer CORS preflight.
- **P3 — the "visit" count is per tab:** sessionStorage belongs to one tab, as the brief specifies, so a visitor who opens three tabs counts three visits.
- **P3 — fonts in screenshots:** the sandbox's Chromium has only a monospace font, so the screenshots use it. Real browsers use the system sans-serif.
