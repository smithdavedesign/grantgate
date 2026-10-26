# grantgate — build notes

> **Go-live pass (2026-10-26):** see [LAUNCH-READY.md](LAUNCH-READY.md). It added search and sharing tags, robots.txt, the sitemap, a share image, a visit beacon for RepoHQ, rewritten privacy and terms pages, and a Buy button. Where the M4 notes below disagree with it, the go-live pass wins:
> - The price is **$49/year** (REVENUE.md), not $5/month.
> - The payment link comes from **`STRIPE_PAYMENT_LINK`**, not `CHECKOUT_URL`.
> - The pages are at **`/privacy`** and **`/terms`**, and the old `.html` addresses redirect there.
> - The site now counts visits for RepoHQ, with no cookies.
>
> The sections "What the product does now" through "What's left" are up to date.

## Plan

Milestone: **M4 — Landing page and demand test** (MVP run, 4 of 4). M1 (parser, scope labels), M2 (gate, allowlist) and M3 (encrypted ledger, policy files) are built, and their 304 tests stay green. There is still no REVIEW.md, REVENUE.md or TODOS.md, so this plan comes from PRD.md, ROADMAP.md, the run's brief ("usable and can take money at the end") and the M3 notes below. Nobody was available to ask, so every open question was decided here and written down.

Exit criteria (ROADMAP.md): *the page lists the three risk labels and has working email capture; 10 interviews scheduled.*

### Step 0: Scope challenge

1. **What already solves part of this?**
   - **M1's `KNOWN_SCOPES` and `scopeRisk`, and M2's `decide()`**, are the source of truth for what the page says about risk. The page's three risk levels quote those labels word for word, and a test checks each quote against the table and checks that each level's promise ("stopped", "allowed") matches what `decide()` does. So the page can't drift from the product.
   - **M2's build script** already strips types with Node's `stripTypeScriptTypes` **[Layer 1]** and rewrites `.ts` imports (`rewriteImports`). The site build reuses both, so there's still no bundler.
   - **Vercel's Build Output API v3** **[Layer 1]**: a build step that writes `.vercel/output/` (static files, `functions/*.func`, `config.json`) is deployed as-is. That avoids guessing how Vercel's zero-config TypeScript would treat our `.ts` import specifiers.
   - **Neon's `@neondatabase/serverless`** **[Layer 1]**: Neon's own driver, which sends each query as one HTTPS request. That suits a function that may cold-start on every sign-up: there's no pool to manage. It's one ESM file with no runtime dependencies and no install scripts.
   - **The WHATWG `input type=email` rule** **[Layer 1]**: the server checks addresses with the HTML spec's own rule, so the browser and the server agree. On top of that, the domain must contain a dot.
   - **Stripe Payment Links** **[Layer 1]**: a hosted checkout that is only a URL. It costs nothing until someone pays, and there's no checkout code or webhook to write. Its URL arrives as `CHECKOUT_URL` through the credential broker.
   - **Fetch `Request`/`Response`** **[Layer 1]** in Node 22: the API is written as `Request → Response`, which is easy to test. A ~40-line adapter serves it to Node's `(req, res)` for Vercel and for the local server.
2. **Minimum change for the exit criteria:**
   - `site/index.html`, `site/styles.css`: the landing page, with hero, how it works, **the three risk levels**, privacy, pricing and the **waitlist form**.
   - `src/site/waitlist.ts`: parses a sign-up; the store interface; the SQL store (schema, join, leave); an in-memory store for local runs and tests; the interview query.
   - `src/site/api.ts`: `handleApi` (`POST /api/waitlist`, `GET /api/checkout`), the Node adapter, the security headers, and the Neon store from `DATABASE_URL`.
   - `src/site/page.ts`: progressive enhancement. It submits the form with `fetch` and shows the reply in place. Without JS, the form still posts and gets a plain HTML reply.
   - `scripts/build-site.ts` (writes `.vercel/output/`), `scripts/serve-site.ts` (`npm run site`, local), `vercel.json`.
   - `docs/interview-script.md`: who to talk to, $0 outreach, the script, the pricing question, the decision rule and a 10-slot tracker.
   - **Taking money:** a pricing section with a "Pre-order" button that goes to `/api/checkout`. Also `site/privacy.html` (required as soon as we store emails; it includes a self-service "remove me" form) and `site/terms.html` (required before charging).
   - `scripts/screenshots.mjs` (`npm run screenshots`, not part of `npm test`).
   - `scripts/build.ts`: one-line change to keep `src/site/` out of the extension.

   **Deliberately not in M4:**
   - Checkout code, webhooks or accounts: a Payment Link does the charging, and David's Stripe dashboard is the record.
   - Sending email (confirmation or double opt-in): that needs a mail provider. David emails people by hand for interviews and launch.
   - Analytics, cookies and a captcha: each needs a third party, and the privacy page promises none.
   - Rate limiting per IP: it needs a shared store. A honeypot field handles naive bots (see Review).
   - An admin page for the list: the Neon console's SQL editor is free and already authenticated. The interview query is written in the script.
   - Tracking the outreach source (`?ref=`), a custom domain (paid), and a Chrome Web Store listing (registration fee; David's call).
   - Delivering the product after payment: David sends the build and the setup help by hand, as the terms say.
3. **Complexity check: triggers.**
   - **Files:**
     - New, source: `site/` (4 files), `src/site/` (3), `scripts/` (3), plus `vercel.json`, `docs/interview-script.md` and `.provision`.
     - New, tests: 6 files (`site-store`, `site-api`, `site-page`, `site-build`, `site-server`, `interview-script`).
     - Edited: `scripts/build.ts`, `test/build.test.ts`, package files, README and BUILD.md.
   - **Classes:** none. The stores are plain objects behind an interface.
   - **Why not fewer:**
     - Each static page is a page users need (landing, privacy, terms).
     - The three `src/site` files run in three places: the browser, the function, and both.
     - Each script is a separate job: deploy build, local server, screenshots.
   - **Reductions taken:**
     - One stylesheet for every page.
     - One API module serves both routes.
     - One store interface for Postgres and memory.
     - No thank-you page: the reply renders in place, or as a fixed-text HTML reply without JS.
     - No migration tool: the schema is `CREATE TABLE IF NOT EXISTS`, run once per function instance.

   Decision: proceed at this size; there's nobody to ask.
4. **Search check:** search unavailable, so I proceeded with in-distribution knowledge only. Known footguns this plan handles:
   - Two cold starts running `CREATE TABLE IF NOT EXISTS` at the same moment can fail in Postgres. The schema promise is forgotten on failure, so the next request retries, and that request answers 503 "try again".
   - String-built SQL: every query uses `$1…$n` parameters through `sql.query(text, params)`. A test checks that no user text reaches the query string.
   - A secret leaking into logs: errors are logged with any `scheme://…` URL and any email address redacted. A test feeds in a connection string built at runtime.
   - Vercel's 4.5 MB body limit is far above what a sign-up needs, so the adapter caps bodies at 4 KB itself.
   - Strict CSP needs no inline script or style. The pages load `/styles.css` and `/page.js`. The honeypot is hidden by a CSS class, not a `style` attribute.
   - Account enumeration: joining twice and removing an unknown address get the same reply as success.
   - Echoing user input into HTML: the no-JS replies use fixed strings only. The page renders server text with `textContent`.
   - An open redirect via `/api/checkout`: the target is only ever `CHECKOUT_URL` from the environment, must be `https:` with no credentials, and otherwise falls back to `/#join`.
5. **TODOS:** no TODOS.md. New follow-ups go under "What's left".
6. **Completeness:**
   - The API is the one internet-facing part of grantgate, so every branch has a test: each method, content type, size, honeypot, invalid email, unknown action, missing store, failing store and redaction.
   - The page's claims about risk are tested against M1 and M2, and every local link is tested to resolve.
7. **Distribution:**
   - `npm run build:site` writes the Vercel deploy. `vercel.json` makes Vercel run it on every push. A test runs the build and serves the emitted function.
   - The extension's distribution is unchanged (unpacked build, policy file). The landing page's "Pre-order" and waitlist are how people reach it until a store listing exists.

### Decisions (no one to ask)

| Question | Decision | Why |
|---|---|---|
| Where do waitlist emails live? | A Neon Postgres table, `waitlist(email PK, role, team_size, interview, joined_at)`, provisioned by the broker (`neon db grantgate` → `DATABASE_URL`). | The run's prescribed free-tier store. One table, no ORM. |
| What does the form ask? | The email (required). Optional: role (owner, office manager, IT provider, individual, other) and team size (1, 2–4, 5–50, 51+). Optional checkbox: "I'm happy to do a 15-minute call". | Role answers the PRD's open question "is the buyer the owner or an outsourced IT provider?". The checkbox is where the 10 interviews come from. |
| Unknown role or team-size values | Stored as empty, not rejected. | Only the email matters; a stale cached form shouldn't lose a sign-up. |
| The same email twice | Same "you're on the list" reply. The row is kept, blank answers are filled in, and the call opt-in can only be switched on. | No enumeration of who's on the list, and nobody can overwrite someone else's answers. |
| Removal | A "remove me" form on the privacy page. It deletes the row at once and gives the same reply whether or not the address was there. | Without a mailbox to ask, this is how someone exercises their right to be removed. The worst abuse is removing a stranger from a waitlist. |
| Without JS | The forms post `application/x-www-form-urlencoded` and get a small HTML page in reply, built from fixed strings. | Email capture keeps working with JS off or blocked. |
| Spam | A hidden honeypot field. Bots that fill it get the success reply, and nothing is stored. | $0, no third party, no captcha. Real rate limiting is deferred. |
| What happens without `DATABASE_URL` | The function answers 503 "not taking sign-ups right now" and logs the missing variable's **name**. The local server uses an in-memory store and says so. | Never silently drop sign-ups in production. Local runs and screenshots use sample data only. |
| Price and checkout | **Founding plan: $5/month, flat, for one business of up to 50 people; cancel any time; full refund within 30 days.** "Pre-order" → `/api/checkout` → 303 to `CHECKOUT_URL` (a Stripe Payment Link, requested from David). Until that's set, it goes to the waitlist with "Pre-orders open soon". | The PRD tests $5–9/month and its gap is "flat-price". $5 is the bottom of the tested range, and a real payment is the strongest demand signal there is. Taking the URL from env keeps it out of the repo and lets the broker set it. |
| Interviews | The opt-in checkbox, plus `INTERVIEW_QUERY` to run in Neon's SQL editor, plus `docs/interview-script.md` with a 10-slot tracker. **Scheduling the 10 is David's job.** | Booking calls with real people can't happen in a sandbox. M4 builds what feeds it. |
| Decision rule for the demand test | ≥3 of 10 would pay $5–9/month → continue. Fewer than 2 → kill. Exactly 2 → five more interviews, then decide. | The PRD gives 3 and 2. The middle case needed a rule. |
| Analytics | None. | Privacy, the CSP and $0. Signups, call opt-ins and Stripe payments are the demand signals. |
| Deploy shape | Vercel hobby: static files plus two Node 22 functions (`/api/waitlist`, `/api/checkout`) built into `.vercel/output/` by our own script. | $0, and the deploy is exactly what the tests ran. |
| Test runner | Still `node:test`. Playwright runs only in `npm run screenshots`. | Same reasoning as M1: tests need no install and no browser. |

### Architecture

```
 visitor ──► https://grantgate.vercel.app/   (Vercel hobby, deployed from .vercel/output/ written by scripts/build-site.ts)
   static/index.html  hero · how it works · the three risk levels · privacy · pricing · waitlist form
          privacy.html (+ "remove me" form) · terms.html · styles.css · page.js (src/site/page.ts)
   headers on every response: strict CSP (self only, no inline), frame-ancestors none, nosniff, no-referrer
   │
   │ POST /api/waitlist   JSON from page.js, or urlencoded with no JS
   ▼
 functions/api/waitlist.func ─ index.mjs → nodeHandler(handleApi)                    src/site/api.ts
   405 not POST · 415 not json/form · 413 over 4 KB
   honeypot filled → "joined" reply, nothing stored
   parseSignup: email (WHATWG rule, ≤254, lower-cased) · role · team size · interview   src/site/waitlist.ts
   store = DATABASE_URL ? sqlStore(Neon HTTP driver, imported lazily) : null → 503, logs "DATABASE_URL is not set"
   store error → 503 "try again", logged with URLs and emails redacted
   ▼
 Neon Postgres (free tier)
   CREATE TABLE IF NOT EXISTS waitlist (…)    once per instance; retried after a failure
   join:  INSERT … ON CONFLICT (email) DO UPDATE  fill blanks, interview = old OR new   ($1…$4 parameters)
   leave: DELETE … WHERE email = $1
   ▲ David runs INTERVIEW_QUERY in Neon's SQL editor → invites → docs/interview-script.md tracker (10 slots)

 "Pre-order $5/month" ── GET /api/checkout ── 303 → CHECKOUT_URL (Stripe Payment Link; https, no credentials)
                                            └─ unset or invalid → 303 /?checkout=soon#join ("Pre-orders open soon")

 local: npm run site ── scripts/serve-site.ts ── the same static files + the same handleApi, in-memory store
```

**Failure scenarios:**

| Scenario | Handling |
|---|---|
| `DATABASE_URL` isn't set on Vercel yet | 503 with "not taking sign-ups right now"; the log names the variable, never a value. Covered by tests and by `.provision`. |
| Neon is down or slow | 503 "try again in a few minutes", logged (redacted). The page re-enables the button. |
| Two cold starts create the table at once | One may fail. Its promise is forgotten, so the next request retries; that request says "try again". |
| A bot fills every field | The honeypot is filled, so it gets success and nothing is stored. |
| A bot posts real-looking emails without filling the honeypot | They are stored. Mitigation deferred (see Review). Rows are tiny, and Neon's free tier holds millions. |
| Someone posts 10 MB | 413 from the `Content-Length` check, or after 4 KB of streaming. |
| A stranger signs up someone else's address | It's stored with blank answers. They can't change existing answers. The owner can remove it. Without confirmation email, this is an accepted risk. |
| JS is blocked | The form posts natively; the reply is a fixed-text HTML page with a link back. |
| `CHECKOUT_URL` is a typo, or `http:` | Treated as unset: the button goes to the waitlist and the log says so (no value logged). |
| A query string tries to pick the redirect (`/api/checkout?to=…`) | Ignored: the target only comes from the environment. |
| An error message contains the connection string or an email | Both are redacted before logging. |
| The page's risk copy drifts from the product | A test compares it with `KNOWN_SCOPES` and `decide()`. |

### Test plan

| Exit criterion | Tests |
|---|---|
| The page lists the three risk labels | `test/site-page.test.ts` › "M4 exit criterion: the landing page lists the three risk labels". Checks:<br>• high, medium and low appear in that order, titled as on the interstitial;<br>• each has examples whose text is exactly `KNOWN_SCOPES`' label at that rating;<br>• each level's promise matches `decide()` (high → block, medium and low → allow). |
| …and has working email capture | `test/site-server.test.ts` › "M4 exit criterion: the waitlist form captures an email end to end": the form's own fields are posted to the local server as a browser would without JS, and the address lands in the store. Also:<br>• `test/site-page.test.ts`: the JS submit path;<br>• `test/site-build.test.ts`: the **emitted** function stores a sign-up and answers 503 with no database;<br>• `test/site-api.test.ts`: every API branch. |
| 10 interviews scheduled | `test/interview-script.test.ts` › "M4 exit criterion (what code can do): …". Checks:<br>• the script has a 10-slot tracker, the screener, the $5/$9 question and the decision rule;<br>• the opt-in query it tells David to run is `INTERVIEW_QUERY`, and its columns exist in `WAITLIST_SCHEMA`;<br>• `test/site-store.test.ts` checks that opting in is stored.<br>Booking the 10 calls is a human step; BUILD.md reports it as **not done**. |

Other paths covered:
- **`waitlist`:**
  - Email rule: trims and lower-cases; rejects empty, too long, no dot, spaces, two `@`, `<`, control characters.
  - Role and team-size enums; each truthy checkbox spelling; actions.
  - SQL store: parameters only, the schema created once and retried after a failure, the upsert keeps answers, leave.
  - Memory store with the same semantics.
- **`api`:**
  - Routes: 404, 405 (with `Allow`), 415, 413 (header and length).
  - JSON vs form replies, honeypot, invalid email, unknown action, the interview reply.
  - Store missing and store throwing, both answering 503 with redacted logs.
  - Checkout: valid, missing, `http:`, credentials, garbage; query strings ignored.
  - Headers: `no-store` on API replies, CSP on HTML.
  - `nodeHandler`: real HTTP, the streaming body cap, adapter errors.
- **`page`:**
  - Every local link and asset resolves; no inline script, style or `style=` attribute.
  - The form's field names match what the parser reads; the honeypot is hidden.
  - Privacy and terms are linked from the footer; pricing says $5.
  - JS path: success replaces the form; errors re-enable it; network failure; double submit ignored; the "pre-orders open soon" notice; server text rendered as text.
- **build:**
  - `config.json` v3 with the header route.
  - Both `.func` directories have the right `.vc-config.json`, `package.json` and a vendored driver.
  - Emitted imports resolve; the static files match their sources.
  - The extension build no longer contains `src/site`.
- **server:** static types, `/` → index, 404s, path traversal (plain and encoded), the API mounted, headers on every reply.

## What the product does now

grantgate has two parts:
- **The extension** (M1–M3), which is the product. It's a Chrome MV3 extension that also works in other Chromium browsers. It has no server and no runtime dependencies, and nothing leaves the browser.
- **The website** (M4, made launch-ready in the go-live pass): a landing page with a waitlist and a $49/year Buy button, which runs on Vercel's free tier.

**The extension**
- **The gate (M2):**
  - Every main-frame navigation to Google's OAuth authorize endpoint (`accounts.google.com/o/oauth2/…`) is redirected to grantgate's own page before the request leaves the browser. The worker then decides with `decide()`.
  - Plain sign-ins and medium-risk requests (calendar, contacts…) continue at once.
  - A high-risk request from an app you haven't allowed stops. So do apps you blocked, and links that name more than one app.
- **The interstitial (M2):**
  - It shows the app's client ID, where access would go, and each permission in plain English with a high/medium/low badge.
  - Choices: **Go back** (the default), **Continue to Google, just this once**, **Always allow this app** and **Always block this app**.
  - Continuing doesn't grant anything: Google still shows its own consent screen.
- **Sign-in ledger (M3):**
  - Setup: on first install, grantgate opens its settings page and asks for a passphrase. Until one is set, nothing is recorded.
  - Every sign-in the gate decides is encrypted the moment it's recorded: the worker can add entries but can't read them.
  - The settings page unlocks it with the passphrase. From there you can export CSV, lock it again, or erase it.
  - It keeps the newest 2,000 entries within 3 MB.
- **Allowed and blocked apps (M2, M3):**
  - The lists live in `chrome.storage.local`, unencrypted, because the gate reads them at every sign-in.
  - The settings page lists them with **Remove** buttons.
  - Policy files: **Export** writes `grantgate-policy.json`. **Import** confirms first and merges, and a block always wins. This is how an owner hands the same lists to staff.
- **Review grants at Google:** the settings page links to `https://myaccount.google.com/permissions`.

**The website (M4, plus the go-live pass)**
- **Landing page** (`site/index.html`) covers:
  - the problem, and how grantgate works;
  - **the three risk levels**, quoting the extension's own labels. High is stopped until you confirm; medium is allowed and recorded; low goes straight through;
  - privacy, pricing, and the waitlist form.
- **Waitlist** (`POST /api/waitlist`):
  - It asks for an email (required), plus an optional role, team size, and "I'm happy to do a 15-minute call".
  - Sign-ups go to a Neon Postgres table, `waitlist`, created on first use.
  - With JS, the reply appears in place. Without JS, the form posts natively and gets a plain reply page.
  - Repeat sign-ups get the same reply and can't overwrite earlier answers. A hidden honeypot field quietly drops naive bots.
  - Without `DATABASE_URL`, it refuses with 503 rather than losing sign-ups.
- **Remove me:** a form on the privacy page deletes an address at once.
- **Buying:**
  - **Buy for $49/year** (one business, up to 50 people; billed yearly; full refund within 30 days, no questions asked) links straight to the Stripe Payment Link in `STRIPE_PAYMENT_LINK`. The link is read at build time.
  - Without it, the button isn't in the page at all, and the pricing card offers the waitlist instead.
  - `GET /api/checkout` still redirects (303) to the same link, or to the waitlist with "Checkout opens soon".
- **Privacy (`/privacy`) and terms (`/terms`)**, linked from every footer. The old `.html` addresses redirect there with a 308.
- **Search and sharing:**
  - Every page gets its own title, description and canonical URL, Open Graph and Twitter tags, a 1200×630 share image (`og.png`, drawn in code at build time), and JSON-LD for a SoftwareApplication with a $49/year Offer.
  - The site also serves `robots.txt` and `sitemap.xml`.
- **Visit beacon:** `page.js` tells RepoHQ about `visit` (once per session), `activate` (the first waitlist join in this browser) and `checkout` (each Buy click).
  - It doesn't send from automated browsers, from builds other than production, or when localStorage `repohq:notrack` is set.
  - See LAUNCH-READY.md.
- **Hardening:**
  - Strict CSP: only the site's own script and stylesheet, no inline code, no framing. Also `nosniff` and `no-referrer`. The one connection allowed beyond the site itself is RepoHQ's beacon.
  - A 4 KB request cap.
  - No cookies and no third-party scripts.
  - Logs redact URLs and email addresses.

**Demand test**
- `docs/interview-script.md` covers:
  - who to talk to, and $0 ways to find them, including the Neon query that lists people who offered a call;
  - a screener, and 14 questions, with the $5/$9 price question asked after the past-behaviour ones;
  - the decision rule (≥3 of 10 continue, fewer than 2 kill, exactly 2 means five more);
  - a 10-slot tracker that holds initials only.

**Code**
- **Library (M1–M3):** `src/authorize.ts`, `src/scopes.ts`, `src/policy.ts`, `src/ledger.ts` (unchanged in M4).
- **Website (M4):**
  - `src/site/waitlist.ts`: parsing, the SQL and memory stores, schema and queries;
  - `src/site/api.ts`: `handleApi`, the Node adapter, headers, the Neon wiring;
  - `src/site/page.ts`: the browser script;
  - `site/`: pages and CSS;
  - `scripts/build-site.ts` and `scripts/serve-site.ts`.

## Run it locally

Requires Node 22.18+ (or 23.6+), which runs `.ts` files directly. Since M4, run `npm ci` once before the tests: the site build copies the Neon driver out of `node_modules`. No package needs an install script.

```sh
npm ci               # the Neon driver (runtime), plus typescript, @types/node and playwright-core (dev)
npm test             # node:test, 489 tests (M1–M4 plus the go-live pass); no browser, no network, no database
npm run typecheck    # tsc over src, test and scripts
npm run build        # the extension → dist/extension/
npm run site         # the website at http://localhost:4321/ (waitlist in memory; add -- --port N to change)
npm run build:site   # the Vercel deploy → .vercel/output/
npm run screenshots  # PNGs → docs/screenshots/ (needs CHROMIUM_PATH; never downloads a browser)
```

**The website, by hand** (`npm run site`):
1. Open `http://localhost:4321/`. Check that the three risk levels are listed and that the links resolve.
2. Join the waitlist with an address like `owner@acme.example` and tick the call box. The reply appears in place, and the server keeps the sign-up in memory until it stops.
3. Turn JS off and join again. You get a plain reply page saying the same thing.
4. The pricing card has no Buy button, because `STRIPE_PAYMENT_LINK` isn't set; it offers the waitlist instead. Start the server with `STRIPE_PAYMENT_LINK=https://example.com/pay npm run site` and the button appears. `/api/checkout` still lands on the waitlist with "Checkout opens soon".
5. On `/privacy`, remove the address. `/privacy.html` should redirect there.
6. `/robots.txt`, `/sitemap.xml` and `/og.png` are served too. Nothing is sent to RepoHQ locally, because this isn't a production build.

**Load the extension in Chrome:**
1. Run `npm run build`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `dist/extension/`. The settings page opens by itself on first install.
3. To reopen the settings later: `chrome://extensions` › grantgate › **Details** › **Extension options**.
4. To gate incognito windows too, turn on "Allow in Incognito" under **Details**.

**Manual check of the extension in a real browser** (unchanged since M3; the sandbox has no way to load an extension, so this is still to do):
1. On the settings page that opened at install, set a passphrase.
2. Paste the roadmap URL into the address bar: `https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20openid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code`. The interstitial should appear, rating "read, send, delete and manage all your email" as High risk.
3. Click **Continue … just this once**. Google should load and then show an error, because the client ID is invented.
4. Paste the URL again in a new tab: grantgate should ask again. Click **Always allow this app**. In another new tab, the URL should now go straight to Google.
5. Use a real "Sign in with Google" button on any site. It should pass after a brief flash.
6. **Ledger:**
   - Unlock with a wrong passphrase: it should refuse.
   - Unlock with the right one: steps 2–5 should be listed, newest first.
   - **Export CSV** should give a header plus one row per sign-in.
7. **Policy file:**
   - Export it.
   - Remove `abc.apps.googleusercontent.com` from "Always allowed".
   - Import the file again: it should ask you to confirm, then put the app back.
8. **Erase:** **Lock**, then **Erase the ledger**: the page should ask for a new passphrase.
9. **Worker DevTools:**
   - `await chrome.declarativeNetRequest.getDynamicRules()` should show rule 1.
   - `await chrome.storage.local.get(null)` should show `policy`, `ledgerKey` and sealed `ledger` records, with no app names in them.

## Deploy (free tier)

**Website: Vercel Hobby, with Neon's free tier ($0)**
1. The pipeline runs `.provision` through the credential broker:
   - a Neon database, which gives `DATABASE_URL`;
   - the Vercel project `grantgate`, with `DATABASE_URL` in its env.
2. Deploy with either:
   - Vercel's Git integration: connect the repo to the project; or
   - the CLI, from a linked checkout: `npx vercel deploy --prod`.

   `vercel.json` makes Vercel run `npm ci` and then `npm run build:site`. That writes `.vercel/output/` (Build Output API v3), which Vercel deploys as-is: the static pages, and two Node 22 functions (`/api/waitlist`, `/api/checkout`). No framework preset and no Vercel-side TypeScript build are involved.
3. **Smoke test the live site:**
   - Open `https://<project>.vercel.app/` and join with a test address.
   - In Neon's SQL editor, `SELECT * FROM waitlist` should show it. The table is created by the first sign-up.
   - Remove it with the privacy page's form.
   - Check that the page's response headers include the CSP.
   - Then the go-live checks in LAUNCH-READY.md.
4. **Taking money:** once David has created the Stripe Payment Link (requested in `.provision`), set it in the project's env (Production) as `STRIPE_PAYMENT_LINK` and redeploy.
   - The link is read at build time, so it only appears after a redeploy.
   - The **Buy for $49/year** button then appears, and `/api/checkout` goes to Stripe as well.
   - A value that isn't a plain `https:` URL is ignored, and the build log says so by name only.
5. **Interview volunteers:** run the query in `docs/interview-script.md` in Neon's SQL editor.

**Extension ($0):** unchanged.
- Load `dist/extension/` unpacked. To hand it to staff, zip that folder, and send them your exported policy file to import.
- The Microsoft Edge Add-ons store runs the same MV3 build; as far as I know, registration there is free.
- The Chrome Web Store has a one-time registration fee, so publishing there is David's call.
- Customers get the build and setup help by email after paying, as the terms say.

## Exit criteria

| Exit criterion | Status |
|---|---|
| **M4:** the page lists the three risk labels | ✅ pass: `test/site-page.test.ts` › "M4 exit criterion: the landing page lists the three risk labels". It checks:<br>• high, medium and low appear in order, titled as on the interstitial;<br>• every example is `KNOWN_SCOPES`' exact label at that rating;<br>• each level's promise matches `decide()`.<br>Also visible in the screenshots. |
| **M4:** …and has working email capture | ✅ pass, against the in-memory store:<br>• `test/site-server.test.ts` › "M4 exit criterion: the waitlist form captures an email end to end": the served page's own form fields, posted as a no-JS browser would, land in the store;<br>• `test/site-build.test.ts` › the **emitted** Vercel function captures an email;<br>• `test/site-page.test.ts`: the JS path;<br>• the `waitlist-joined-*` screenshots, taken through the real form and API.<br>⚠️ Not yet run against the real Neon database: the sandbox has no `DATABASE_URL`. Deploy step 3 covers it. |
| **M4:** 10 interviews scheduled | ❌ **Not met: this is a human step.** What code can do passes: `test/interview-script.test.ts` › "M4 exit criterion (what code can do)…" checks the script, its 10-slot tracker and its decision rule, that the call opt-in is stored, and that the query to find volunteers matches the schema. Booking 10 calls needs the site live and David's outreach (see "What's left"). |
| M3: a ledger written with passphrase A decrypts with A and fails with B | ✅ pass |
| M3: exporting 3 entries yields a CSV with a header plus 3 rows | ✅ pass |
| M3: importing a policy JSON with 2 client_ids makes `decide()` allow those | ✅ pass |
| M2: `decide()` blocks high-risk with an unknown client_id, allows when allowlisted, allows low risk | ✅ pass |
| M2: confirming the interstitial adds nothing to the allowlist unless "always allow" is chosen | ✅ pass |
| M1: parser on the roadmap URL; `scopeRisk` examples; non-Google URL returns null; all 20 fixtures | ✅ pass |

- `npm test`: 489 tests, 489 passing (419 at M4; the go-live pass added the rest).
- `npm run typecheck`: clean.
- `npm run build:site`: writes the static pages, `page.js`, `robots.txt`, `sitemap.xml`, `og.png`, two functions and `config.json`.
- `npm run screenshots`: 6 PNGs, each opened and checked.

I injected three deliberate bugs by hand, one at a time, and reverted each. All three were caught:
- the honeypot ignored;
- `/api/checkout` honouring a `?to=` parameter (an open redirect);
- a risk label on the page reworded so it no longer matched the extension.

## Infrastructure

Requested through `.provision`, for the pipeline to run through the credential broker after the build.

M4 asked for:
- `neon db grantgate` → `DATABASE_URL`, a Postgres database on Neon's free tier, for the waitlist;
- `vercel project grantgate` → the Vercel Hobby project that hosts the website;
- `vercel env grantgate DATABASE_URL` → puts the database URL in that project's env.

The go-live pass's `.provision` asks for:
- `vercel project grantgate`;
- `request "Stripe payment link for grantgate: $49/year, per REVENUE.md"` → for David. A $49/year Payment Link, with its URL stored as `STRIPE_PAYMENT_LINK` in the Vercel env. Stripe has no monthly fee: it charges per payment, so it's $0 until someone pays.

Environment variables the code reads:
- `DATABASE_URL`, in the function;
- `STRIPE_PAYMENT_LINK` (optional), at build time for the Buy button, and in the function for `/api/checkout`;
- `VERCEL_ENV` and `VERCEL_PROJECT_PRODUCTION_URL`, at build time; Vercel sets both. The first decides whether visits are counted; the second is the domain used in canonical URLs, the sitemap and the share image;
- `PORT` (optional), for the local server;
- `CHROMIUM_PATH`, for screenshots only.

No secret is in the repo, and tests build any fake values at runtime.

## What's left

- **The 10 interviews (M4 exit criterion):**
  - deploy;
  - run the Deploy smoke test;
  - follow `docs/interview-script.md`: find volunteers, invite them, book the calls and fill in the tracker.
- **Stripe Payment Link** → `STRIPE_PAYMENT_LINK` (requested from David), then redeploy. Until then there's no Buy button.
- **Contact:** the privacy and terms pages send people to GitHub issues, and removal is self-service. A free forwarding mailbox would be kinder for refunds, which shouldn't need a public issue.
- **A quick legal read** of `site/privacy.html` and `site/terms.html` before charging. They're plain-language drafts and name no jurisdiction.
- **Manual checks:**
  - the extension in a real browser (above);
  - the live website (Deploy step 3).
- **Delete two scratch files** the sandbox wouldn't let me remove (`rm` is blocked). Both are git-ignored and won't be committed:
  - `test/ledger-nfc.tmp`, left over from M3;
  - `dist/old-current.tmp.md`, a copy of M3's old sections that I made while reorganising this file.
- **Later:**
  - Rate limiting on `/api/waitlist` (Vercel firewall rules), or double opt-in by email.
  - Tracking which outreach channel each sign-up came from (`?ref=`).
  - A Chrome Web Store listing (fee; David's call) and a custom domain (paid; canonical URLs follow it automatically).
  - Automatic delivery after payment.
  - M3's list: change the passphrase, live refresh of the settings page, adding an ID by hand, a stricter mode for `medium`, `access_type=offline`, icons and a popup, re-checking `KNOWN_SCOPES` against Google's docs, and merging the two fake DOMs.

## Review

M4 self-review against gstack's pre-landing checklist. `git status` still shows every file except README.md as untracked: nothing after the idea commit has been committed. So `git diff` covers only README.md, and I reviewed the M4 files directly:
- **New:**
  - `site/{index,privacy,terms}.html`, `site/styles.css`;
  - `src/site/{waitlist,api,page}.ts`;
  - `scripts/{build-site,serve-site}.ts`, `scripts/screenshots.mjs`;
  - `vercel.json`, `.provision`, `docs/interview-script.md`, `docs/screenshots/*.png`;
  - tests: `test/{site-store,site-api,site-page,site-build,site-server,interview-script}.test.ts`.
- **Edited:** `scripts/build.ts`, `test/build.test.ts`, `package.json`, `package-lock.json`, `README.md`, `BUILD.md`.

**Pass 1 — CRITICAL**
- **SQL & data safety:**
  - All three statements take their values as `$1…$4` through `sql.query(text, params)`. A test checks that no user text reaches a SQL string, and that removal is a parameterised `DELETE`.
  - A sign-up is one atomic `INSERT … ON CONFLICT (email) DO UPDATE`, with no check-then-insert.
  - The schema is `CREATE TABLE IF NOT EXISTS`. Within an instance it runs once (tested with concurrent calls), and it is retried after a failure (tested). That handles two cold starts racing to create the table.
- **Race conditions:** two sign-ups for the same address meet at the primary key. The upsert only fills blanks and can only switch the call opt-in on, so the order doesn't matter.
- **Unsafe HTML (XSS):** none.
  - `page.ts` renders server text with `textContent`. A test feeds it `<img onerror>`, and the fake DOM throws on `innerHTML`.
  - The no-JS reply uses fixed messages, HTML-escaped. A test checks that the address is never echoed.
  - The static pages have no inline script, style or `on*=` handlers. A test enforces this, and so does the CSP (`script-src 'self'`, `style-src 'self'`).
- **Open redirect:** `/api/checkout` only ever redirects to `CHECKOUT_URL` from the environment, which must be `https:` with no credentials. Otherwise it falls back to `/#join`. Tested, and caught by an injected bug.
- **Trust boundaries** (standing in for the LLM item, which doesn't apply):
  - Bodies are capped at 4 KB, by the header and while streaming.
  - Only JSON or form posts are accepted, and JSON must be an object.
  - Optional answers must be values from the form's own lists.
  - Logs redact URLs (connection strings included) and email addresses. A test uses a fake connection string built at runtime.
  - The Host header is never used.
- **Shell injection:** the screenshot script spawns `node` with an argument array, and nothing else runs a shell.
- **Enum completeness:** I read every consumer of the new values.
  - `ROLES` and `TEAM_SIZES`: the form's `<option>` values are tested to equal them. Unknown values are stored as blank.
  - `join | leave`: handled in the parser and the API. The parser's two error kinds both map to a message.
  - `API_ROUTES` vs `FUNCTION_ROUTES`: tested equal.
  - `SITE_STATIC_FILES` vs `site/`: found in this review (below).
- **Found in this review and fixed:**
  - **P2, confidence 7/10** (`src/site/api.ts` `readBody`): a client that hung up mid-upload settled the body on `'close'` with whatever had arrived. A form cut off after `email=owner%40acme.example` (when it was really `…example.co`) would have stored the wrong address. Only Node's current event order (`'error'` before `'close'`) prevented it, and every abort was also logged as an API error. Now an incomplete body is `'aborted'`: never used, never logged. I wrote the test first and watched it fail on the log.
  - **P3, confidence 9/10** (`scripts/build-site.ts`): a page added to `site/` but not to `SITE_STATIC_FILES` would pass the link tests and then 404 on Vercel. A test now requires the two to match.
  - Under Fix-First, the first is a trust-boundary change that would normally be asked about. Nobody was available, and it only refuses more, so I applied it.

**Pass 2 — INFORMATIONAL**
- **Auto-fixed:**
  - Version 0.3.0 → 0.4.0 in `package.json` and `package-lock.json`; the manifest follows.
  - During the build, the vendored driver was cut to its runtime files (no `.d.ts`, README or CJS build). A test pins the list.
- **Column/field names:** a test checks the interview query's columns against `WAITLIST_SCHEMA`, and the query in the doc is the constant itself.
- **Type coercion:** the call opt-in is true only for `yes`, `on`, `true` or `true`; team sizes are strings; JSON that isn't an object is refused.
- **View/frontend:** one shared stylesheet with no inline styles; no O(n·m) work.
- **Distribution:**
  - `vercel.json` plus `build:site`, tested down to the emitted function, which a test serves.
  - The extension's distribution is unchanged.
- **Time windows:** none in M4.

**Remaining (not fixed, by decision):**
- **P2 (confidence 6/10): no rate limiting.** A script could fill the waitlist with fake addresses, or remove real ones by guessing them. Removal shows the same reply either way, so it can't confirm a guess.
  - Mitigations: the honeypot, and rows that are tiny.
  - Fix with Vercel's firewall rules or double opt-in once there's traffic.
- **P2 (confidence 5/10), unverified on Vercel:** the Build Output API details come from memory:
  - `.vc-config.json` with `launcherType: "Nodejs"` and an ESM `index.mjs` whose default export is `(req, res)`;
  - route `headers` with `continue: true`;
  - a build command that writes `.vercel/output/` being deployed as-is.

  The emitted function is exercised in tests through Node's own `http`, and the Deploy smoke test covers the rest.
- **P2 (confidence 5/10): the Neon driver's HTTP query from Vercel is unverified here.** A test proves the vendored driver loads inside the function and sends its query over https to the database's domain.
- **P3:** anyone can sign up someone else's address, since there's no confirmation email. They can't change existing answers, and the owner can remove it.
- **P3:** the 503 for a missing `DATABASE_URL` is logged on every request until it's set.
- **P3:** the page says medium-risk sign-ins are "written to your ledger", which is true once a passphrase is set. The extension asks for one at install.
- **P3:** the screenshots render in a monospace fallback, because it's the only font in the sandbox's Chromium.
- `npm test` now needs `npm ci` first, and still doesn't run the type-check; `npm run typecheck` is clean.
- M3's and M2's remaining items still apply (see their reviews below).

## M3 plan (built)

Milestone: **M3 — Local encrypted ledger** (MVP run, 3 of 4). M1 (parser, scope labels) and M2 (gate, allowlist) are built; their 195 tests stay green. There is still no REVIEW.md, REVENUE.md or TODOS.md, so this plan comes from PRD.md, ROADMAP.md and the M2 notes below. Nobody was available to ask, so every open question was decided here and written down.

### Step 0: Scope challenge

1. **What already solves part of this?**
   - **WebCrypto** `crypto.subtle` **[Layer 1]** has everything the ledger needs: PBKDF2, HKDF, ECDH P-256, AES-GCM and `wrapKey`/`unwrapKey`. It is identical in Chrome and Node 22, so the same code runs in the extension and the tests. No crypto dependency.
   - **M2's worker** already knows every decision at a single point (`check` for automatic passes, `choose` for interstitial choices). It already has a write queue for storage read-modify-write. The ledger reuses both: there is no second recording path and no second queue.
   - **M2's `normalizePolicy`** already validates and cleans the `{ allow, deny }` shape (dedupe, lower case, deny wins). Policy import is a stricter parser in front of it plus a merge.
   - **Downloads:** `<a download>` with a Blob URL **[Layer 1]**, so no `downloads` permission. **File picking:** `<input type=file>` plus `File.text()`, so no permission. The manifest's permissions stay exactly as in M2.
2. **Minimum change for the exit criteria:**
   - `src/ledger.ts` (new, pure): build an entry from a decision; create the passphrase-protected key; seal entries; open the ledger; bound its size; CSV export.
   - `src/policy.ts`: `policyFile` (export), `parsePolicyFile` (strict import), `mergePolicies`, `removeFromPolicy`.
   - `src/extension/background.ts`:
     - records each decision;
     - answers four messages from the options page (import, remove, set up the ledger, erase it);
     - opens the options page on first install.
   - `src/extension/options.ts` plus `extension/options.html` (new): the one page where the user sets the passphrase, unlocks, reads and exports the ledger, sees and edits the lists, and imports or exports policy files. It also holds the PRD's "Review grants" link to Google's permissions page. M2 deferred this page to M3 because import and export need it.
   - `extension/manifest.json` (`options_ui`), `scripts/build.ts` (copy `options.html`) and `src/extension/interstitial.ts` (a compile-forced guard for the new reply type).

   **Deliberately not in M3:**
   - Changing the passphrase. Erasing and starting again is the only recovery, and the page says so.
   - A live refresh of the options page when a decision happens in another tab: it re-reads after each of its own actions.
   - Typing a client ID in by hand: importing a file covers the owner-to-staff case.
   - Encrypting the allow and block lists: the gate must read them with no passphrase (see the decisions below).
   - A toolbar popup and icons; the landing page and waitlist (M4); Chrome Web Store packaging (David's call: there is a registration fee).
3. **Complexity check: triggers.**
   - **Files:** 7 new and 11 edited, so well past 8.
     - New, source: `ledger.ts`, `options.ts`, `options.html`.
     - New, tests: `ledger`, `policy-file`, `options` and a shared `helpers/fake-dom.ts`.
     - Edited: `policy.ts`, `background.ts`, `interstitial.ts`, the manifest, the build script, three existing test files, `package.json`, `package-lock.json` and `.gitignore`. (Counted after the build.)
   - **Classes:** one new, `WrongPassphraseError` in `ledger.ts`, plus a page-local `Problem` like M2's `GateError`. No services.
   - **Why not fewer:** an MV3 options page is necessarily an HTML file plus a module script. The ledger is one module. The other edits are one-line wiring (manifest, build, interstitial guard).
   - **Reductions taken:**
     - CSV lives in `ledger.ts`, not its own module.
     - Policy-file parsing returns a result instead of a new error class.
     - No `downloads`/`unlimitedStorage` permission.
     - No change-passphrase flow and no storage listener.
     - The worker reuses M2's queue, coverage check and approval window.

   Decision: proceed at this size; there's nobody to ask, and each remaining file is a separate browser context or test surface.
4. **Search check:** search unavailable, so I proceeded with in-distribution knowledge only. Known footguns this plan handles:
   - `CryptoKey` objects can't go in `chrome.storage` (JSON only), so keys are stored as base64 strings.
   - PBKDF2-HMAC-SHA-256 needs about 600,000 iterations (OWASP 2023).
   - An AES-GCM IV must never repeat under one key. Every entry gets its own derived key and a random IV. The wrapping key is used once, with a fresh salt per setup.
   - A raw ECDH shared secret must go through a KDF (HKDF here) before use as a key.
   - Unicode passphrases are NFC-normalised, so the same words typed on another OS still open the ledger.
   - CSV cells that start with `= + - @` are run as formulas by spreadsheets, so they get a leading `'`.
   - `chrome.storage.local` is capped at 10 MB without `unlimitedStorage`, so the ledger is bounded.
   - An MV3 worker can be killed at any moment, so it holds no key in memory.
   - The options page must **not** import `background.ts` for real: that module starts a gate wherever `chrome.runtime.id` exists. Type-only imports, and a build test checks it.
5. **TODOS:** no TODOS.md. New follow-ups go under "What's left".
6. **Completeness:**
   - The crypto and the import parser are trust boundaries, so every failure path has a test: wrong passphrase, tampered entry, damaged key, malformed file and oversize file.
   - Feature scope stays at the exit criteria plus the page that makes them usable.
7. **Distribution:** no new artifact type. The options page ships inside the M2 extension build (`npm run build` → `dist/extension/`, Load unpacked). A build test checks the emitted page and scripts.

### Decisions (no one to ask)

| Question | Decision | Why |
|---|---|---|
| How does the worker write an encrypted ledger without the passphrase? | Each entry is sealed to the ledger's **public key**: ephemeral ECDH P-256 → HKDF-SHA-256 → AES-GCM-256. The private key is stored **wrapped** with an AES-GCM key derived from the passphrase (PBKDF2-SHA-256, 600k iterations, random 16-byte salt). | The worker can append but can't read; only the passphrase reads. There's no unlock state in the worker and nothing is lost while locked. The passphrase never leaves the options page. It is still "AES-GCM keyed from a passphrase (PBKDF2)", as the roadmap asks. |
| What gets recorded? | Every grant request the gate decides, once per sign-in: automatic passes (`allowed`, `allowlisted`) and every interstitial choice. Not Google's follow-up steps in the same tab within a minute; not `oauth2` URLs that aren't grant requests. | The PRD's "listing grants recorded locally" means medium-risk grants that pass silently (calendar, contacts) matter as much as the ones that were asked about. |
| Before a passphrase is set | Nothing is recorded. The options page opens on first install and asks for one. | There's no key to seal to. The PRD's "5 users who finish setup" metric counts exactly this step. |
| Are the allow and block lists encrypted? | No; only the ledger is. | The gate reads the lists on every sign-in with no passphrase. A client ID on a list is a setting, not a history. Documented on the page. |
| Importing a policy file | **Merge**; a block always wins. A confirm dialog shows the counts first. Rejected outright: not JSON, wrong shape, non-string or space-containing IDs, over 10,000 IDs or over 1 MB. | An owner's file shouldn't wipe a staff member's own choices. Fail closed: an imported allow can't undo a local block. Strict parsing tells the owner their file is broken rather than half-applying it. |
| Policy file format | `{ "format": "grantgate-policy", "version": 1, "allow": [...], "deny": [...] }`. Import also accepts a bare `{ "allow": [...], "deny": [...] }`. | Self-describing, and hand-writable by an owner. |
| Forgotten passphrase | "Erase the ledger" (after a confirm), then set a new passphrase. The lists are unaffected. | There's no recovery by design. Erasing only loses history nobody can read anyway. |
| Ledger size | At most 2,000 entries and 3 MB of sealed text; the oldest go first. Text fields are clipped to 300 characters; requests with over 40 scopes keep the riskiest 40. The rating is computed from the full request before clipping. | Stays well inside the 10 MB storage cap, so a site flooding sign-ins can't break list writes. |
| A ledger write fails | Logged; the gate's decision still goes through. | The record must never stand in the way of the gate. |
| CSV | Columns `date (UTC), app, decision, risk, permissions, scopes, redirect_uri`. RFC 4180 quoting, CRLF line endings, formula guard, oldest first. | Opens cleanly in Sheets and Excel for a non-technical owner. The plain-English permissions sit next to the raw scopes. |
| Test runner | Still `node:test`. | Same reasoning as M1: no install needed to run the tests. |

### Architecture

```
 interstitial ─ check / choose ─► background.ts (service worker, M2)
                                   │ assess / applyChoice (M2)
                                   │ record(entry) ── inside M2's write queue, errors logged, never thrown
                                   │   ledgerEntry(now, request, decision)              src/ledger.ts
                                   │   sealEntry(publicKey): ephemeral ECDH P-256 → HKDF-SHA-256 → AES-GCM
                                   │   appendSealed: oldest dropped past 2,000 entries / 3 MB
                                   ▼
                       chrome.storage.local
                         policy     { allow[], deny[] }                       plain: the gate needs it
                         ledgerKey  { kdf: PBKDF2 salt+iterations, publicKey,
                                      wrappedPrivateKey, iv }                  no passphrase, no plain private key
                         ledger     [ { epk, iv, ct }, … ]                    sealed entries, oldest first
                          ▲ reads only                       ▲ every write goes through the worker's queue
 options.html / options.ts ─┘                                 │
   set passphrase ── createLedgerKey(p) in the page ── ledger-setup {key} ──┤ refused if a ledger exists
   unlock ── PBKDF2(p) → unwrapKey (a wrong p fails the GCM tag) → open each entry (bad ones counted)
   export CSV ── ledgerCsv(entries) → <a download>
   lists ── remove ── remove-app {list, client_id} ─────────────────────────┤
   import file ── parsePolicyFile → confirm(counts) ── import-policy {text} ┤ re-parsed, merged, deny wins
   export file ── policyFile(policy) → <a download>
   erase ── confirm ── ledger-reset ────────────────────────────────────────┘
   link ── https://myaccount.google.com/permissions (Google's own list, to revoke)
```

- **Message trust:** the worker checks the sender's page (`interstitial.html` in a tab, or `options.html`) and accepts only that page's own message types. The web-accessible interstitial can't send import, remove, setup or erase messages, and the options page can't send check or choose.
- **What the worker validates:** it re-parses the policy file text itself (the same `parsePolicyFile`) and re-validates the ledger key's shape. It never receives the passphrase.
- **Dedupe:** the worker remembers the last recorded request per tab for 60 s (`APPROVAL_TTL_MS`). A later request in the same tab that M2's `coversRequest` matches (same app, same redirect, subset of scopes) is not recorded again. That covers Google's follow-up steps. A new choice on the interstitial is always recorded.
- **Rendering:** app IDs, scopes and redirect URIs from the ledger are rendered with `textContent` only, like M2's interstitial.

**Failure scenarios:**

| Scenario | Handling |
|---|---|
| No passphrase set yet | Nothing recorded; the page shows the setup form (and opened itself on install). |
| Wrong passphrase | `unwrapKey` fails the GCM tag check → "That passphrase doesn't open this ledger." Nothing is shown. |
| One sealed entry is corrupt or tampered with | Skipped and counted ("1 entry couldn't be read"); the rest still open. |
| Entries sealed to an older, erased key | Can't happen: setup and erase both write `ledger: []` in the same storage call as the key. |
| The stored key is damaged | Treated as "not set up"; setting a new passphrase replaces it. |
| Storage is full or the ledger write fails | Logged; the sign-in still goes through. |
| A site floods auto-allowed sign-ins to bloat storage | Fields clipped, ledger bounded by count and size, oldest dropped. Residual: old entries can be pushed out (see Review). |
| The policy file isn't JSON, has the wrong shape, or is huge | Rejected with a plain message before any confirm; nothing changes. |
| A policy file allows an app the user blocked | Stays blocked (deny wins); the user can remove it from the block list. |
| An import and an "Always allow" happen at the same moment | Both go through the worker's write queue; neither is lost. |
| A hostile app ID or scope ends up in the ledger | Rendered as text. CSV cells are quoted and formula-guarded. |
| The worker is asleep when the options page sends a message | Chrome wakes it; the handler awaits start-up first (M2 behaviour). |
| The options page imports `background.ts` by mistake | Would start a second gate in the page. Type-only imports; a build test fails if the emitted `options.js` imports `background.js`. |

### Test plan

| Exit criterion | Tests |
|---|---|
| A ledger written with passphrase A decrypts with A and fails with B | `test/ledger.test.ts` › M3 exit criterion: 3 entries sealed under a real 600k-iteration key open with A and reject B with `WrongPassphraseError`. `test/background.test.ts` › decisions recorded through the worker open with A, fail with B, and no plaintext app ID is in storage. `test/options.test.ts` › unlock with B shows the error and no entries; with A shows them. |
| Exporting 3 entries yields a CSV with a header plus 3 rows | `test/ledger.test.ts` › `ledgerCsv` of 3 entries parses to header + 3 rows. `test/options.test.ts` › "Export CSV" after unlocking downloads that file. |
| Importing a policy JSON with 2 client_ids makes `decide()` allow those | `test/policy-file.test.ts` › `parsePolicyFile` + `mergePolicies` then `decide` (both blocked before, allowed after, a third app still blocked). `test/background.test.ts` › the `import-policy` message, then both apps go straight through the gate. `test/options.test.ts` › choosing the file, confirming, and the message sent. |

Other paths covered:
- **`ledger`:**
  - Key shape and defaults; random salt and key per setup; the passphrase never stored.
  - `parseLedgerKey` rejects every malformed field.
  - NFC passphrases; short passphrases refused.
  - Sealed entries hold no plaintext and differ every time.
  - Entries sealed to another key are unreadable; tampered and malformed records are counted; decrypted non-entries are rejected.
  - `ledgerEntry` clipping keeps the riskiest scopes and rates the full request.
  - `appendSealed` bounds (count, size, garbage input).
  - CSV quoting round trip, formula guard, unidentified app, empty ledger, every decision with text.
- **`policy`:**
  - The policy file round trip, the bare format, normalisation.
  - Every rejection (not JSON, array, no lists, non-array list, bad entry, wrong format or version, too many IDs, too big).
  - Merge (union, deny wins both ways, no mutation, garbage input).
  - Remove (named list only, case-insensitive, unknown ID).
- **`background`:**
  - Nothing recorded before setup.
  - Dedupe of follow-ups, a new tab, and the window expiring.
  - Non-grant `oauth2` URLs aren't recorded.
  - A ledger write failure doesn't block.
  - Concurrent decisions are all recorded.
  - Import merge and deny-wins; a broken file changes nothing.
  - Remove, setup once, setup over a damaged key, a damaged key in a message, erase.
  - An import racing an "Always allow".
  - Per-page message types; the options page with or without a tab; malformed options messages.
  - Opening the options page on install but not on update.
- **`options`:**
  - Setup (sends a key that opens with the passphrase, never the passphrase itself), mismatch, too short.
  - Locked count; wrong and right passphrase; newest first in plain English; unreadable count; lock.
  - Erase only after confirm.
  - Lists and Remove, empty lists, policy export.
  - Import confirm, cancel, broken file, oversize file (never read).
  - A worker error; storage or worker unreachable.
  - The Google link, hostile text rendered as text, double submit ignored.
- **`interstitial`:** an unexpected reply type shows an error.
- **build:**
  - `options_ui` is in the manifest and the page exists, but the page isn't web-accessible.
  - The options page loads its module script with no inline script.
  - The emitted `options.js` doesn't import the worker.
  - The emitted `ledger.js` runs in Node.

### M3 exit criteria and review

- **Exit criteria:** all three passed when M3 was built (304/304 tests) and still pass (see "Exit criteria" above).
- **Injected bugs:** three, all caught:
  - the interstitial allowed to send settings messages;
  - the CSV formula guard reduced to `=` only;
  - follow-up deduplication removed.

M3 self-review against gstack's pre-landing checklist. `git status` still shows every file as untracked (M1 and M2 haven't been committed), so `git diff` is empty. I reviewed the M3 changes directly:
- **New:** `src/ledger.ts`, `src/extension/options.ts`, `extension/options.html`, and tests `test/{ledger,policy-file,options}.test.ts` plus `test/helpers/fake-dom.ts`.
- **Edited:** `src/policy.ts`, `src/extension/background.ts`, `src/extension/interstitial.ts`, `extension/manifest.json`, `scripts/build.ts`, `test/{background,interstitial,build}.test.ts`, `package.json`, `package-lock.json`, `.gitignore`.

**Pass 1 — CRITICAL**
- **SQL & data safety:** not applicable (no database).
- **Race conditions:**
  - Every write (lists, ledger key, ledger entries) goes through the worker's single queue.
  - The "already recorded in this tab?" check runs inside the queue. So does "refuse setup over a working key".
  - Tests cover concurrent decisions in three tabs and an import racing an "Always allow".
  - The settings page only reads storage. A stale view can't do harm, because the worker re-parses the policy file and re-checks the ledger key.
- **Unsafe HTML (XSS):** none.
  - The settings page renders only with `createElement` and `textContent`. The shared test DOM throws on `innerHTML`, and a test feeds `<img onerror>` and `<script>` through the app ID, scope and redirect into the ledger table and the lists.
  - **CSV injection** is the spreadsheet equivalent: cells starting with `= + - @`, tab or CR get a leading `'`. Tested, and caught by an injected bug.
- **Trust boundaries** (standing in for the LLM item, which doesn't apply):
  - The passphrase never leaves the settings page; a test checks the sent message.
  - The worker re-validates the key's shape.
  - A wrong passphrase fails the AES-GCM tag, so nothing is shown.
  - Each page may send only its own message types, so the web-accessible interstitial can't import, remove, set up or erase. Tested, and caught by an injected bug.
  - The settings page is not web-accessible; a build test checks it.
- **Shell injection:** not applicable.
- **Enum completeness:** I read every consumer of the new values.
  - `Reply`'s `saved`: the interstitial now fails closed on any non-`ask` reply. This is compile-forced and tested.
  - `OptionsMessage`: the worker's switch ends in a `never` check; its parser rejects unknown types.
  - `LedgerDecision`: `DECISION_TEXT` is a `Record`, and `parseEntry` checks against it.
  - `ListName`: `LIST_TEXT` is a `Record`.
  - The sender's page union: a third page wouldn't compile, because the interstitial path reads `tabId`.
- **Found in this review and fixed:**
  - **P2, confidence 9/10** (`background.ts` `record`): deduplication swallowed a narrower retry after "Go back". A site that asks for Gmail, gets refused, then retries with `openid` only (incremental auth) passed silently without a ledger entry. Now only decisions that let a sign-in continue cover follow-ups. I wrote the test first and watched it fail.
    - Under Fix-First this changes what is recorded, which is user-visible, so it would normally be asked about. Nobody was available, and the fix only records more, so I applied it.
  - **P3:** the worker's generic error for a failed settings change said "could not check this sign-in". It now says "could not save that change". Tested.

**Pass 2 — INFORMATIONAL**
- **Auto-fixed:**
  - Version mismatch: `package-lock.json` still said 0.1.0 while `package.json` said 0.2.0. Both now say 0.3.0, which the manifest picks up.
  - The manifest and package descriptions now mention the ledger.
- **Time windows:** deduplication reuses M2's `APPROVAL_TTL_MS` (60 s) with the same injected clock, and has an expiry test.
- **Type coercion:** CSV dates are re-normalised through `toISOString`. PBKDF2 iteration counts must be integers in range. Policy-file entries must be strings.
- **View/frontend:** the inline `<style>` in `options.html` is a static extension page, not a re-rendered partial, so it's fine. The table is built in one pass with no O(n·m) lookups.
- **Distribution:** unchanged from M2. The settings page ships in the same unpacked build, and a test imports the emitted `options.js` and `ledger.js`.

**Remaining (not fixed, by decision):**
- **P2 (confidence 6/10):** the ledger is bounded, so a site that keeps triggering automatically allowed sign-ins (varying the scopes each time) can push older entries out. Possible fixes: a per-app cap, or rate-limiting automatic entries. Not worth the complexity before real users.
- **P2 (confidence 5/10), unverified in a real Chrome:**
  - `openOptionsPage()` from `onInstalled`.
  - `<a download>` with a Blob URL from an extension page.
  - WebCrypto ECDH, HKDF and `wrapKey` inside the MV3 service worker. These are standard WebCrypto, and the Node tests use the same API.

  The manual check covers all three.
- **P3 (confidence 8/10):** each automatically allowed sign-in now waits for its ledger write (one ECDH plus a storage write of the whole ledger, up to 3 MB) before continuing. If that's noticeable, reply first and record afterwards.
- **P3 (confidence 7/10):** the allow and block lists are not encrypted, by design: the gate reads them with no passphrase.
- **P3 (confidence 6/10):** someone with access to the browser profile can erase the ledger, or swap its key so that future entries are sealed to theirs. The passphrase protects reading what was recorded. An attacker who controls the profile is outside this extension's reach.
- **P3:** the settings page doesn't refresh live while a decision is recorded in another tab; it re-reads after each of its own actions.
- **P3:** a stored key with as few as 1,000 PBKDF2 iterations is accepted when reading (the tests use that to stay fast). The page always creates keys at 600,000.
- `npm test` still doesn't run the type-check; run `npm run typecheck` separately (it is clean).
- M2's remaining items still apply (see "M2 exit criteria and review" below), except the "can't undo Always allow/block" item, which the Remove buttons fix.

## M2 plan (built)

Milestone: **M2 — Gate and allowlist** (MVP run, 2 of 4). M1 (parser and scope labels) is built and its tests stay green. There is no REVIEW.md, REVENUE.md or TODOS.md, so this plan comes from PRD.md, ROADMAP.md and M1's notes. Nobody was available to ask, so every open question was decided here and written down.

### Step 0: Scope challenge

1. **What already solves part of this?**
   - M1's `parseAuthorizeUrl` and `scopeRisk` give the gate everything it needs to know about a request. `decide()` is a thin layer over them and does no parsing of its own.
   - Chrome's `declarativeNetRequest` (DNR) can redirect a navigation *before* it is sent **[Layer 1]**. That is the only way an MV3 extension can actually hold a request back: blocking `webRequest` is gone in MV3, and `webNavigation` + `tabs.update` fires after the request has already left, so it is a race, not a gate. RESEARCH.md says the same.
   - `chrome.storage.local` holds the lists **[Layer 1]**. No IndexedDB and no server.
   - Node's `module.stripTypeScriptTypes` turns `src/*.ts` into browser JS **[Layer 1]**. There's no bundler: the service worker and the page both load native ES modules. The npm registry isn't reachable from this sandbox anyway, so M2 adds **no dependencies**.
2. **Minimum change for the exit criteria:**
   - `src/policy.ts`: pure `decide()`, `assess()`, the interstitial's choices and `applyChoice()`.
   - `src/extension/background.ts`: the service worker. It installs the DNR gate rule, answers the interstitial, writes the lists and adds one-shot pass rules.
   - `src/extension/interstitial.ts` plus `extension/interstitial.html`: the page that explains the request and offers the choices.
   - `extension/manifest.json` and `scripts/build.ts`, which emits `dist/extension/`, loadable unpacked.

   **Deliberately not in M2:**
   - An options page for viewing or removing list entries. It goes in M3 with policy import/export, which needs that page anyway. Until then the interstitial's "Always allow" and "Always block" buttons are the only way to edit the lists.
   - The ledger and CSV export (M3); the landing page and waitlist (M4); a toolbar popup and icons.
   - Raising the rating for `access_type=offline` (see the decisions below).
   - Chrome Web Store packaging: the store's one-time registration fee breaks the $0 rule, so that is David's call.
3. **Complexity check: triggers.** M2 adds 10 new files: 4 code (`policy`, `background`, `interstitial`, `build`), 2 static (manifest, page) and 4 test files. An MV3 extension has a floor of manifest + service worker + page + page script + build step. Each one is a separate browser context or artifact, so none can be merged. **No services or stateful classes**: the only class is a one-line `GateError` that marks errors safe to show the user (the fake DOM is test-only). Reductions I took: no CSS file (one `<style>` in the page), no options page, no bundler, no shared "messages" module (types live in `background.ts` and are imported with `import type`, which is erased). Decision: proceed at this size.
4. **Search check:** search unavailable, so I proceeded with in-distribution knowledge only. Known DNR footguns this plan handles:
   - `redirect` needs host permissions for the request URL.
   - A redirect to an extension page needs that page listed in `web_accessible_resources`.
   - Allow rules beat redirect rules.
   - Regex filters use RE2 and must stay small.
   - `urlFilter` treats `*`, `^` and `|` as special characters.
   - The service worker is killed when idle, so in-memory state is a cache, never the source of truth.
5. **TODOS:** no TODOS.md. New follow-ups go under "What's left".
6. **Completeness:** the gate is the security boundary, so every message handler validates its sender and input, and every way past the gate (pass rules, approvals, list writes) has a test. Feature scope stays at the exit criteria.
7. **Distribution:** `npm run build` produces `dist/extension/`, which loads with "Load unpacked" at `chrome://extensions` for $0. A test runs the build and imports its output. A store listing and CI are out of scope and flagged above.

### Decisions (no one to ask)

| Question | Decision | Why |
|---|---|---|
| What does `medium` do? | `allow`. Only `high` is blocked. | PRD: "blocks high-risk grants". The roadmap fixes only high→block and low→allow. Prompting for calendar and contacts would add friction, and the PRD's metric is under 5% of users disabling the gate. |
| `access_type=offline` | Ignored in M2. | Almost every server-side app asks for it, so it says little about risk. Revisit with real users. |
| client_id conflicts (`client_id` given twice with different values; M1 returns `null`) | `block` ("can't tell which app"). Choices: go back or continue once. Nothing can be remembered for it. | Otherwise a denylisted app could add a decoy `client_id` and dodge the denylist. |
| Denylisted app | `block`, and "Go back" is the only choice. | That is what a denylist means. The owner's M3 policy file relies on it. |
| Allowlist vs denylist | Deny wins. "Always allow" and "Always block" move the ID between the lists, so they never overlap. | Fail closed. |
| client_id case | Stored and compared in lower case. | Real IDs are lower case. A case variant can't dodge the denylist; at worst it matches the allowlist for the same app. |
| URLs that aren't grant requests (`parseAuthorizeUrl` returns null) | `allow`. | The gate stays out of the way. |

### Architecture

```
 page / link / popup ──navigates──► https://accounts.google.com/o/oauth2/v2/auth?…
                                            │  DNR dynamic rule #1 (priority 1, main_frame)
                                            │  regex ^https?://accounts\.google\.com\.?/[^?#]*(oauth2|%)
                                            ▼  redirect ► chrome-extension://<id>/interstitial.html#<original URL>
 interstitial.ts ── {type:'check', url} ──► background.ts (service worker)
   (refuses to run framed)                    validate sender (our page, in a tab) and URL (http(s), accounts.google.com)
                                              assess(url, policy from storage)  ◄── src/policy.ts ◄── M1 parse + scopeRisk
                                              ├─ allow, or covered by this tab's approval ─► add pass rule, reply proceed
                                              └─ block ─► reply ask {assessment, choices}
   renders labels with textContent
   user clicks ── {type:'choose', url, choice} ─► re-assess; reject choices not offered
                                              applyChoice: once / always-allow / always-block / back
                                              list write (serialised queue) ─► chrome.storage.local "policy"
                                              proceed? ─► remember approval for this tab (60 s), add pass rule
   location.replace(url) ◄── proceed ─────────┘
                                            │  session rule (priority 2, allow): exact URL, this tab only, 10 s
                                            ▼
                                     Google's own consent screen (the user still has to click Allow there)
```

- **Pass rules match one exact URL in one tab.** I first considered "let this tab through for N seconds" and rejected it as a real bypass. A site opens a popup to a low-risk sign-in, which is auto-allowed, then points the same popup at a high-risk URL before the pass expires. Instead the pass is a `urlFilter` of `|<exact URL>|` (case-sensitive), with `*`, `^` and `|` percent-encoded first so the filter has no wildcards. Expired passes are removed on a timer and on every message. All session rules are cleared each time the worker starts.
- **Google's own redirects.** For example, `/o/oauth2/v2/auth` redirects to `/o/oauth2/auth/oauthchooseaccount?…`, which hits the gate again. The worker keeps the request the user just approved for that tab, for 60 seconds. A follow-up is let through without asking only if it has the same client_id and redirect_uri and a subset of the approved scopes. A denylisted app, or one that can't be identified, is never covered. So the approval can't be widened.
- **The worker owns every list write.** A promise queue serialises read-modify-write, so two tabs choosing "Always …" at the same moment can't lose an entry.
- **Trust boundaries:**
  - The only attacker-controlled input is the URL in the page's `#` fragment. Any site can open a web-accessible page.
  - The worker navigates only to validated `http(s)://accounts.google.com` URLs, which rules out `javascript:` and open redirects.
  - The page refuses to render inside a frame (JS check plus CSP `frame-ancestors 'none'`), which stops clickjacking of "Always allow".
  - *Added in review:* a new prompt's buttons ignore clicks for 600 ms. A site that opened the page could otherwise reload it with another app's prompt just before the user's click lands.
  - Scope labels can contain raw text from the URL, so they are rendered with `textContent`, never HTML. A test checks this.
- **Permissions:** `declarativeNetRequest` and `storage`, plus host access to `accounts.google.com` (needed for redirect). No `tabs`, `webNavigation`, content scripts or `<all_urls>` host access.

**Failure scenarios:**

| Scenario | Handling |
|---|---|
| The worker is asleep when the page asks | Chrome wakes it for the message. The handler awaits startup (gate rule installed, stale passes cleared) before answering. |
| The worker dies between "Continue" and Google's follow-up redirect | Its approval memory is lost, so the user is asked again (fails closed). |
| Storage holds a corrupt policy | `normalizePolicy` keeps only non-empty strings and treats the rest as empty lists. It never throws. |
| The gate rule fails to install | Logged. There is no gate until the next worker start retries. Noted as a residual risk. |
| A site opens `interstitial.html#javascript:…` or `#https://evil.example` | The worker rejects the URL as "not a Google sign-in address". The page shows an error and never navigates. |
| A site iframes the page to clickjack "Always allow" | The page renders nothing and sends no message when framed. |
| A sign-in popup has no history to go back to | "Go back" closes the window instead. If the browser won't allow that, the page says so. |
| An attacker adds a second `client_id` to dodge the denylist | Blocked as an unidentifiable app. |
| A URL path spelled with `%` escapes | The regex also matches any path containing `%`, so the parser makes the call. |
| Chrome spells the URL differently from the pass, so the pass never matches | Chrome would send the same URL back to the gate, again and again. If a live pass for that exact URL and tab already exists, the worker answers with an error instead of looping. |
| A site reloads its popup with a different prompt right before a click | The new prompt's buttons ignore clicks for 600 ms. |

### Test plan

| Exit criterion | Tests |
|---|---|
| `decide` returns `block` for a high-risk scope with an unknown client_id | `test/policy.test.ts` › M2 exit criteria (roadmap URL with an empty policy); every high fixture blocks |
| …`allow` when the client_id is allowlisted | same suite (roadmap URL with `abc…` allowlisted); every high fixture is allowed once allowlisted; case-insensitive match |
| …`allow` for low-risk scopes | same suite; every low and medium fixture is allowed |
| Confirming the interstitial adds nothing to the allowlist unless "always allow" is chosen | `test/policy.test.ts` › `applyChoice` for every choice. `test/background.test.ts` › the full check → choose flow through the worker against fake `chrome.storage`: "once" leaves storage untouched and the next tab is asked again; "always allow" stores the ID and the next tab proceeds. `test/interstitial.test.ts` › each button sends its own choice. |

Other paths covered:
- **`policy`:**
  - The precedence order: not a grant, unidentified, deny, allow, high, not high.
  - `normalizePolicy` on garbage input, with dedupe, trimming, lower-casing and deny winning.
  - `choicesFor` for every reason (compiler-checked `Record`).
  - `applyChoice` rejects choices that weren't offered and doesn't mutate its input.
  - `coversRequest` with subset, superset, a different app or redirect, and null IDs.
- **`background`:**
  - The gate regex matches every URL the M1 parser accepts (all 20 fixtures and every spelling variant, canonicalised as Chrome would) and none of the lookalike hosts.
  - Gate and pass rule shapes, and pass URL escaping.
  - `isGateTarget` rejections.
  - Sender checks: other extension, other page, no tab.
  - Malformed messages.
  - Approval coverage and expiry, and that a denylisted app is never covered.
  - Pass expiry sweep, the concurrent "Always …" race, and startup (rule install, stale session rules cleared).
  - A storage failure reports an error.
- **`interstitial`:**
  - `targetFromHash`.
  - The prompt for each block reason, including which buttons appear.
  - A malicious label stays text.
  - Framed page, missing target, proceed, back and close fallback, error replies, and buttons disabled while a choice is pending.
  - The 600 ms arming delay: clicks before it send nothing.
- **build:** the emitted manifest is MV3 and its version matches package.json. Every file the manifest or page references exists. No `.ts` import specifiers remain. The emitted `policy.js` runs in Node and blocks the roadmap URL. The emitted worker imports cleanly without `chrome`.

### M2 exit criteria and review

- **Exit criteria:** all four passed when M2 was built (195/195 tests) and still pass (see "Exit criteria" above).
- **Injected bugs:** six deliberate bugs, all caught:
  - "once" writing the lists;
  - no write queue;
  - pass rules not scoped to a tab;
  - labels rendered as HTML;
  - an approval covering a denylisted app;
  - the frame check removed.

**M2 self-review against gstack's pre-landing checklist.** `git status` shows every file as untracked, because M1 hasn't been committed yet either, so `git diff` is empty. I reviewed the new files directly: `src/policy.ts`, `src/extension/*`, `extension/*`, `scripts/build.ts`, `test/{policy,background,interstitial,build}.test.ts`, plus the edits to `package.json` and `tsconfig.json`.

**Pass 1 — CRITICAL**
- **SQL & data safety:** not applicable (no database).
- **Race conditions:**
  - List read-modify-write is serialised through the worker's queue, and a test runs two concurrent "Always allow" choices. Checking a request re-reads the policy and choosing re-assesses under the lock, so the interstitial's view can't be used to apply a stale choice.
  - *Remaining, harmless:* the loop guard is check-then-add across an `await`. Two simultaneous checks for the same tab and URL can add two identical passes. Both match only that exact URL. P3, confidence 8/10, `src/extension/background.ts` `letThrough`.
- **Unsafe HTML (XSS):** none.
  - The page renders only with `createElement` and `textContent`. The test DOM throws on `innerHTML`, and a test feeds `<script>` and `<img onerror>` through the client_id and scope.
  - Navigation targets are validated by the worker (`isGateTarget`) and again by the page (`isGoogleAccountsUrl`).
- **UI redress (found in this review, fixed):** a site can open the web-accessible interstitial in a popup and reload it with another app's prompt just before the user's click lands. Fix: buttons ignore clicks for 600 ms after each prompt appears (`ARM_DELAY_MS`, tested). It was P2, confidence 6/10, `src/extension/interstitial.ts` `runInterstitial`. Under Fix-First this is a security finding, which would normally be asked about. Nobody was available, and the fix was small and only adds safety, so I applied it.
- **LLM trust boundary, shell injection:** not applicable.
- **Enum completeness:** I read every consumer of the new `Reason`, `Choice` and `Decision` values and of M1's `Rating`.
  - `CHOICES_BY_REASON`, `COPY`, `BUTTONS`, `RATING_TEXT` and `RATING_ORDER` are all `Record`s, so the compiler enforces every value.
  - *Fixed in review:* `CHOICES`, the list the worker validates messages against, was a hand-written array. It is now derived from a `Record<Choice, true>`.
  - `applyChoice` and `choose` treat any choice other than the two "always" ones as "change nothing". `check` treats any decision other than `allow` as "ask". Both fail closed.
  - The page's reply handling is narrowed by the compiler, so a new reply `action` would not compile until it is handled.

**Pass 2 — INFORMATIONAL**
- **Auto-fixed:**
  - The `CHOICES` derivation above.
  - Two plan statements that didn't match the code: the "no classes" claim (there is a one-line `GateError`) and the file count.
  - A stray duplicate button-disabling loop in the page, replaced with one `querySelectorAll('button')`.
- **Distribution:** the extension is a new artifact with no CI or publish workflow. Flagged rather than built, because the only paid step (the Chrome Web Store fee) is David's call. `npm run build` is the whole pipeline, and a test runs it.
- **Time windows:** the 10 s pass and 60 s approval lifetimes are named constants (`PASS_TTL_MS`, `APPROVAL_TTL_MS`) and use a single injected clock.

**Remaining (not fixed, by decision):**
- **P2 (confidence 5/10), unverified in a real Chrome.** There is no browser in this sandbox. The design relies on these DNR and MV3 behaviours, from memory:
  - A main-frame redirect to a `web_accessible_resources` page with `<all_urls>` matches works for navigations started by any site.
  - `\0` in `regexSubstitution` inserts the whole URL.
  - `frame-ancestors` is accepted in MV3 `extension_pages` CSP.
  - A session `allow` rule with `tabIds` and an exact `urlFilter` matches the page's own `location.replace` navigation. If it doesn't, the loop guard shows an error instead of looping.

  The manual check above covers all of these.
- **P2 (confidence 5/10):** a host spelled with a trailing dot (`accounts.google.com.`) is caught by the regex, but the host permission `accounts.google.com/*` may not cover it. If Chrome then skips the redirect and Google serves that spelling, it is a way around the gate. Check by hand; the fix would be an extra host permission.
- **P3 (confidence 7/10):** a POST form sent to the authorize endpoint loses its body when redirected. Google then gets a GET with no parameters and shows an error. That fails closed (no grant) but is confusing. Rare in practice.
- ~~**P3 (confidence 8/10):** a mistaken "Always allow" or "Always block" can't be undone until M3's options page.~~ Fixed in M3: the settings page has a **Remove** button on every listed app.
- **P3 (confidence 6/10):** incognito windows aren't gated unless the user turns on "Allow in Incognito". This is documented above.
- **P3 (confidence 5/10):** possible hardening: `use_dynamic_url` on the web-accessible page, so sites can't open it by a guessable URL. The frame check, the arming delay and the worker-side validation already make direct opening harmless.
- **P3:** if the gate rule fails to install, the error is logged and there is no gate until the worker next starts. Dynamic rules persist, so this only matters on the very first install.
- **P3:** every gated sign-in briefly shows grantgate's page, twice when Google's account chooser follows. That's the cost of deciding in JS with the full parser rather than in a DNR pattern.
- `npm test` still doesn't run the type-check, so it keeps working without `npm install`; run `npm run typecheck` separately (it is clean).

## M1 plan (built)

Milestone: **M1 — Detector and scope labels** (MVP run, 1 of 4). No REVIEW.md, REVENUE.md or TODOS.md existed, so the plan is built from PRD.md and ROADMAP.md only. Nobody was available to ask, so every open question below was decided here and the decision written down.

### Step 0: Scope challenge

1. **What already solves part of this?** The repo had only docs. Node's built-ins cover everything M1 needs:
   - WHATWG `URL`/`URLSearchParams` for parsing **[Layer 1]**.
   - `node:test` + `node:assert` for tests **[Layer 1]**.
   - Node's built-in TypeScript type stripping (on by default since 22.18), so `.ts` runs with no compiler or bundler **[Layer 1]**.

   **Decision:** use `node:test`, not the Vitest the roadmap suggests. There's nothing to install for the tests, and a security extension gains from a small, auditable dependency tree. The tests only use `describe`/`it`/`assert`, so moving to Vitest later is mechanical. TypeScript is a dev dependency for `npm run typecheck` only; tests don't need it.
2. **Minimum change:** two pure modules (`src/authorize.ts`, `src/scopes.ts`), a 20-URL fixture module, and three test files. Deferred because they don't block M1's exit criteria:
   - The MV3 manifest, navigation interception, the interstitial and the allowlist (M2).
   - The vault, CSV and policy files (M3).
   - The landing page (M4).
   - Reading `response_type` and `access_type`. M2's `decide()` can add `access_type=offline` if it wants to weigh offline access.
3. **Complexity check:** 2 source modules, 0 classes or services, 4 test files. Counting config and docs (package.json, tsconfig.json, .gitignore, BUILD.md) it is 10 files, but only 6 contain code. The check doesn't trigger.
4. **Search check:** search unavailable (web tools are not permitted in this sandbox). I proceeded with in-distribution knowledge only. The scope ratings follow Google's published restricted/sensitive classes as I know them, and should be re-checked against Google's scope docs before launch.
5. **TODOS cross-reference:** no TODOS.md. New work for later milestones is listed under "What's left".
6. **Completeness:** the parser gets complete edge-case handling, because it is the security boundary and a missed URL means the gate never fires. That covers host and path spellings, repeated parameters and malformed input. Feature scope stays narrow.
7. **Distribution:** M1 ships no artifact; it is a library inside the repo. Not in scope and flagged here: extension packaging (zip, unpacked load) in M2, and the landing-page deploy in M4.

**Not in scope for M1:**
- Anything the browser runs (no manifest or UI).
- Storage, policy and the allowlist.
- Microsoft, Slack or GitHub OAuth (non-goal in the PRD).
- `continue=` URLs that wrap an authorize URL, and the `/signin/oauth/consent` page, where scopes are hidden in an opaque `part=` blob. See the architecture section for why neither is needed.

### Architecture

```
 navigation URL (string | URL)
        │
        ▼
 parseAuthorizeUrl(url)        src/authorize.ts
   https/http, host accounts.google.com (case, trailing dot, default port only)
   path /o/oauth2/v2/auth or /o/oauth2/auth, or a sub-step under them
   (%-escapes, doubled slashes and case are normalised first)
        │ null ─► not a Google grant request: the gate stays out of the way
        ▼
 { client_id | null, scopes[], redirect_uri | null }
        │
        ▼
 scopeRisk(scopes)             src/scopes.ts
   KNOWN_SCOPES (77 hand-labelled scopes) ─► fallback by API family ─► medium
        │
        ▼
 { rating: low|medium|high, labels[{ scope, rating, label, known }] }
        │
        ▼
 (M2) decide(url, policy) ─► interstitial
```

**Rating rule:**
- **high:** Google's "restricted" scopes (mail, all Drive files). Also anything that sends mail as you, reads or edits all your Docs/Sheets/Slides, administers the Workspace, controls Google Cloud or Ads, or publishes Chrome extensions.
- **medium:** Google's "sensitive" scopes (calendar, contacts, tasks, YouTube…).
- **low:** sign-in only, or files the app creates or you pick.
- **Unrecognised scopes:** medium. Under `gmail.`, `drive.` or `admin.` they are high instead.

Labels complete the sentence "This app wants to …".

**Failure scenarios and how they're handled:**

| Scenario | Handling |
|---|---|
| An app hides a Gmail scope in a second `scope=` parameter, or joins scopes with `+` or commas | Scopes from every copy are combined and split on spaces, `+` and commas (fixture 14, unit tests). |
| An attacker repeats `client_id`, putting an allowlisted ID first | Conflicting copies give `client_id: null` ("unknown app"), so M2 can't match the allowlist. |
| Path tricks such as `/o/oauth2/v2/%61uth`, `//o//oauth2`, upper case, or a trailing-dot host | All normalised before comparing, so they are still detected (fails closed). |
| Lookalike hosts (`accounts.google.com.evil.example`, `accounts-google.com`) | Return null. Not a genuine Google consent screen; out of scope for a consent-click gate. |
| Google adds a new Gmail or Drive scope | Rated high by the family fallback, labelled as unrecognised. |
| The user reaches Google's consent page after redirects (`/signin/oauth/consent?part=…`) | Not parsed, because scopes are opaque there. M2 must catch the first `/o/oauth2/...` navigation. A `continue=` sign-in hop ends in that same navigation, so it is caught there too. |
| Garbage input (non-URL, relative URL, non-string) | Returns null and never throws. Covered by tests. |

**Security:** pure functions with no network, storage or secrets. One rule carries into M2: unrecognised-scope labels include the raw scope string from the URL, which an attacker controls, so the interstitial must render labels as text (`textContent`), never as HTML.

### Test plan

Every exit criterion maps to named tests, and every branch in both modules has a test.

| Exit criterion | Test |
|---|---|
| Roadmap URL returns `abc.apps.googleusercontent.com`, `["https://mail.google.com/","openid"]`, `https://app.example/cb` | `test/authorize.test.ts` › "returns client_id, scopes and redirect_uri for the roadmap example" |
| `scopeRisk(["openid","email","profile"])` is `low` | `test/scopes.test.ts` › "rates plain sign-in … low" |
| `scopeRisk(["https://mail.google.com/"])` is `high` with a label containing "email" | `test/scopes.test.ts` › "rates full Gmail access high with a label that mentions email" |
| A non-Google URL returns null | `test/authorize.test.ts` › "returns null for a non-Google URL", plus the lookalike-host, other-path, scheme/port and garbage-input tests |
| All 20 fixtures parse with the expected scopes | `test/fixtures.test.ts`: one parse test and one rating test per fixture, plus a set-level check (20 distinct, covers low/medium/high). The rating test also checks that every fixture scope has a hand-written label, which is the PRD metric "detects and labels 100%". |

Other paths covered:
- Legacy endpoint, account-chooser sub-steps, `URL` objects.
- Host and path spellings, rejected hosts, paths and schemes.
- Missing or blank `client_id`.
- Scope splitting, de-duplication and multi-param union; missing scope and redirect.
- Trimming, and agreeing vs conflicting duplicates.
- Max-of rating in any order, and an empty list.
- Scope spelling variants counted once.
- Unknown and family fallbacks, legacy feed scopes, `TypeError` on bad input.
- Table integrity: unique keys, valid ratings, labels in plain English that don't repeat the scope.


### M1 review (summary)

- No CRITICAL findings.
- Auto-fixed: a shadowed variable name in `src/scopes.ts`, and the `engines` range (now `^22.18 || >=23.6`).
- Carried into M2 and handled there:
  - Labels for unrecognised scopes embed raw URL text, so they must be rendered as text. Done; tested in `test/interstitial.test.ts`.
  - The gate must hook the first `/o/oauth2/...` navigation. Done with the DNR gate rule.
- Still open: the scope ratings come from memory, because there was no web access. Verify before launch.
