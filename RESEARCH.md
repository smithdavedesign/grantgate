# grantgate — research

## Summary
David's seed: a local vault that intercepts OAuth on "Sign in with Google" so he controls an added layer of security. Sharpened: a browser extension plus small local vault that intercepts Google OAuth consent requests, checks the requested scopes against the owner's policy, blocks or warns on risky grants, and keeps a local encrypted ledger of every grant with revoke guidance.
The buyer is a 5–50 person Google Workspace business with no IT/security staff, at a flat low monthly fee below the floor of enterprise SaaS-security products.
The password-vault half of the seed is dropped: password managers are cheap and saturated; the unserved moment is the consent click.

## Evidence of the problem
- Consent phishing: attackers get a user to approve a malicious OAuth app on a genuine Google consent page, so no password is stolen and the grant persists until revoked. The late-2024 campaign against Chrome extension developers used a fake "Privacy Policy Extension" app requesting the Chrome Web Store scope; reports say it reached 2.6M+ extension users (https://www.valencesecurity.com/resources/blogs/saas-oauth-attack-leads-to-widespread-browser-extension-breach, https://redcanary.com/blog/threat-detection/google-workspace-oauth-attack/).
- Why users fall for it: the consent screen is hosted by the provider, so usual phishing cues are absent (https://securityboulevard.com/2025/01/consent-phishing-the-new-smarter-way-to-phish/).
- Stolen OAuth tokens at vendors: in Aug 2025 attacker UNC6395 stole OAuth and refresh tokens from Salesloft's Drift integration and used them against customer Salesforce; Google reported Workspace email access via the Drift Email integration; all Drift tokens were revoked (https://www.bleepingcomputer.com/news/security/salesloft-breached-to-steal-oauth-tokens-for-salesforce-data-theft-attacks, https://securityaffairs.com/181686/cyber-crime/google-salesloft-drift-breach-hits-all-integrations.html). Lesson: every past grant is standing risk. The number of affected organisations was not verified.
- Infostealers abusing Google refresh tokens ("MultiLogin" endpoint, 2023–24) survive password resets; the fix is signing out/revoking sessions (https://www.securityweek.com/several-infostealers-use-persistent-cookies-to-hijack-google-accounts/). I found no 2026 reporting on current status.

## Who pays
- Buyer: owner/office manager of a 5–50 person business on Google Workspace (accountants, agencies, clinics, small advisers) who is the de facto admin.
- Price point: $5–9/month flat per business. This is a judgment from the gap below, not measured willingness to pay.
- Evidence they pay for something like it: Nudge Security sells OAuth-grant discovery and auto-revoke at $750/month flat for up to 150 users, or $5/user/month for 150–1,500 (https://nudgesecurity.com/pricing). That floor makes it uneconomic for a 10-person firm. Small businesses also pay for password managers, e.g. 1Password Business at roughly $8–9/user/month (https://dupple.com/compare/passpack-vs-1password, affiliate-style source).
- Honest caveat: no evidence yet that sub-50 person firms pay for OAuth-specific protection; Google gives admins free allowlisting.

## Competitors & alternatives
| Name | Price | Gap |
|---|---|---|
| Google Workspace admin "Manage Third-Party App Access" (Trusted/Limited/Blocked) | included in Workspace | Free but needs admin role, buried in Admin console, no per-click plain-English warning, nothing for personal accounts (https://support.google.com/a/answer/60757) |
| Nudge Security | $750/mo up to 150 users; $5/user/mo above | Priced for mid-market; discovery after the fact, not a gate at the consent click |
| AppTotal Chrome extension | unknown (listing not readable) | Closest direct competitor: claims to show OAuth app risk on the consent screen for Google/Microsoft/Slack. Needs a hands-on look before any build |
| Auth0 Token Vault | in Auth0 plans | Developer product for apps/agents holding tokens, not an end-user gate (https://auth0.com/blog/auth0-token-vault-secure-token-exchange-for-ai-agents/) |
| mcp-oauth2-proxy | free OSS | Local token proxy for MCP servers only; its docs say disk encryption is only obfuscation against same-user processes |
| Google "Third-party access" page | free | Manual after-the-fact review that few do |

## Technical notes
- Chrome MV3 extension watches navigations to accounts.google.com/o/oauth2/v2/auth (and /oauth2/auth); parses client_id, scope, redirect_uri, response_type.
- Policy engine: sensitive-scope list (gmail.*, drive full, calendar, admin.directory, chrome web store, offline access) vs. an allowlist of known client_ids. Blocking via declarativeNetRequest redirect to an interstitial page.
- Local vault: encrypted store (WebCrypto, key from passphrase) of the grant ledger: date, app, scopes, decision. It cannot hold tokens issued to third-party servers; it only gates and records the grant. The product must say so honestly.
- Revoke: link to myaccount.google.com/permissions; no API needed for MVP.
- App verification status is not in the URL; MVP uses scope risk plus a user-maintained allowlist. Whether verification can be looked up without Google API access is unverified.

## Risks & open questions
- AppTotal (and Google) may already cover the gate; the competitive check is step one.
- Extension-store review and trust: a security extension that reads auth URLs must be minimal-permission and auditable.
- The gate adds friction; users may disable it.
- Willingness to pay at $5–9/month is unproven; admins can use free Google controls.
- The seed's literal reading (vault holds tokens) is not possible for tokens sent to third-party servers; the gate-and-ledger framing keeps David's intent of owning the security layer.

## Sources
- https://www.valencesecurity.com/resources/blogs/saas-oauth-attack-leads-to-widespread-browser-extension-breach
- https://redcanary.com/blog/threat-detection/google-workspace-oauth-attack/
- https://securityboulevard.com/2025/01/consent-phishing-the-new-smarter-way-to-phish/
- https://www.bleepingcomputer.com/news/security/salesloft-breached-to-steal-oauth-tokens-for-salesforce-data-theft-attacks
- https://securityaffairs.com/181686/cyber-crime/google-salesloft-drift-breach-hits-all-integrations.html
- https://www.securityweek.com/several-infostealers-use-persistent-cookies-to-hijack-google-accounts/
- https://nudgesecurity.com/pricing
- https://support.google.com/a/answer/60757
- https://auth0.com/blog/auth0-token-vault-secure-token-exchange-for-ai-agents/
- https://dupple.com/compare/passpack-vs-1password
