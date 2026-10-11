# grantgate — PRD

## Problem
A person clicks "Allow" on a genuine Google consent screen for an app they barely know, granting Gmail or Drive access that persists until someone revokes it. Passwords and MFA do not help. Free Google admin controls exist but are hidden and admin-only, and enterprise tools start at $750/month.

## Target user
The owner or office manager of a 5–50 person Google Workspace business who is the de facto admin, plus security-minded individuals with a personal Google account. Painful moment: a staff member approves a "PDF tool" or "email tracker" that asks for full Gmail read access.

## Competitors & gap
Google Admin third-party app control (free, admin-only, no per-click context), Nudge Security ($750/mo floor, discovery not a gate), AppTotal extension (closest; needs hands-on review). Gap: a flat-price, no-admin-console gate at the consent click with a local record of grants.

## MVP scope
- Chrome extension detects Google OAuth authorize requests and parses client_id, scopes, redirect_uri.
- Scope risk labels in plain English (e.g. "read all your email") with a high/medium/low rating.
- Interstitial that blocks high-risk grants until the user confirms or the client_id is allowlisted.
- Local encrypted grant ledger (date, app, scopes, decision), passphrase-protected, exportable as CSV.
- Allowlist/denylist of client_ids, shareable as a JSON policy file so an owner can hand it to staff.
- "Review grants" page linking to Google's permissions page and listing grants recorded locally.

## Non-goals
- Storing or proxying tokens issued to third-party servers.
- A general password manager.
- Microsoft/Slack/GitHub OAuth in v1.
- Enterprise admin dashboards or SSO.

## Success metrics
- Detects and labels 100% of authorize URLs in a 20-sample fixture set with correct scopes.
- 30 installs from a 2-week $0 outreach test, and 5 users who finish setup.
- At least 3 of 10 interviewed small-business admins say they would pay $5–9/month (kill if fewer than 2).
- Under 5% of users disable the gate within 14 days.

## Open questions
- Does AppTotal already do this well and for free?
- Can app verification status be obtained without Google API access?
- Will the Chrome Web Store accept a gating extension?
- Is the buyer the owner or an outsourced IT provider?
