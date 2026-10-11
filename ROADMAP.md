# grantgate — roadmap

Suggested stack: TypeScript + Chrome MV3 (the extension is the product surface), Vite for bundling, Vitest for tests, WebCrypto for the local vault (no server, $0), static landing page on Vercel hobby.

## M1 — Detector and scope labels (one weekend)
Deliverables:
- Pure TypeScript module `parseAuthorizeUrl(url)` returning client_id, scopes, redirect_uri.
- `scopeRisk(scopes)` mapping scopes to plain-English labels and a high/medium/low rating.
- Fixture set of 20 Google authorize URLs.

Exit criteria (test-runnable):
- parseAuthorizeUrl on `https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20openid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code` returns client_id `abc.apps.googleusercontent.com`, scopes `["https://mail.google.com/","openid"]`, redirect_uri `https://app.example/cb`.
- scopeRisk(["openid","email","profile"]) returns `low`; scopeRisk(["https://mail.google.com/"]) returns `high` with a label containing "email".
- A non-Google URL returns null.
- All 20 fixtures parse with the expected scopes.

## M2 — Gate and allowlist
Deliverables: MV3 extension intercepting authorize navigations, interstitial page, allowlist/denylist storage.

Exit criteria:
- decide(url, policy) returns `block` for a high-risk scope with an unknown client_id, `allow` when the client_id is allowlisted, and `allow` for low-risk scopes.
- Confirming the interstitial adds nothing to the allowlist unless "always allow" is chosen.

## M3 — Local encrypted ledger
Deliverables: AES-GCM ledger keyed from a passphrase (PBKDF2), CSV export, policy JSON import/export.

Exit criteria:
- A ledger written with passphrase A decrypts with A and fails with B.
- Exporting 3 entries yields a CSV with a header plus 3 rows.
- Importing a policy JSON with 2 client_ids makes decide() allow those.

## M4 — Landing page and demand test
Deliverables: landing page, waitlist, interview script.

Exit criteria: the page lists the three risk labels and has working email capture; 10 interviews scheduled.
