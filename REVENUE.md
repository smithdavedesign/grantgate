# grantgate — road to first revenue

Date: 2026-10-25. Evidence strength is stated per claim. Nobody has been asked to pay yet, so every willingness-to-pay claim here is a judgment, not data.

## Verdict up front

Weak-to-moderate case. The problem is real (consent phishing, Drift token theft; documented in research). Whether a 5–50 person firm pays for it is **unproven**, and two things work against it:

1. **AppTotal already ships a Chrome extension** that shows OAuth app risk on the consent screen ("Shows OAuth applications risk in real time", Chrome Web Store). I could not find a price, so assume it is free or sales-led. The competitive check the research flagged as "step one" is still not done, and it is the biggest threat. Our difference is a *block* (not just a label), a local ledger, and a shareable policy file. Whether buyers value that over a free label is the whole bet.
2. **Google Admin's third-party app control is free** for the exact buyer. The owner who is the de facto admin can already set "Limited/Blocked". The pitch only works for owners who don't know that, or can't be bothered; staff-level enforcement via an extension each person must install is an extra step.

Competitor prices: Nudge Security is $750/month flat under 150 users (aggregators FitGap/TrustRadius disagree, quoting $3–5/user/month; its own page was not readable in search, so treat as approximate). Nothing found for a sub-$20 OAuth-gate product, which means either a gap or no market. I can't tell which from searching.

## Forcing questions, applied to money

**Who pays?** Not "users". The person is the owner or office manager of a 5–50 person Google Workspace firm with no IT staff: a small accounting practice, agency, dental/medical clinic, or bookkeeping shop. They hold the Workspace admin login by default and carry the blame if a staffer's "PDF tool" reads the client mailbox. Second, weaker buyer: the outsourced IT/MSP who looks after many such firms (could multiply seats, but sells slower and wants a multi-tenant console we don't have). Personal-account individuals are an install source, not a payer, at this price.

**What do they pay today?** Almost certainly $0 for this specific problem. They pay for a password manager (~$8–9/user/month 1Password Business) and perhaps endpoint/email security. Admin console is free and mostly unused. The honest status quo is "do nothing and hope", which is the red flag from the gstack rule: if the workaround is nothing, pain may be below the buying threshold. Evidence that would change my mind: 3 of 10 owners, after seeing a real consent screen blocked, hand over a card.

**Narrowest version worth paying for?** A person installs the extension, a high-risk Gmail/Drive grant is stopped with a plain-English interstitial, and the owner can hand staff one policy JSON file so the whole office has the same allowlist. The ledger/CSV is the "show my insurer/client what we approved" piece. Everything else (verification lookups, Microsoft/Slack, dashboards) is out.

**Free vs paid split.** Free: detection, labels, and warn-only interstitial (this is also the install and Web Store review driver, and it matches what AppTotal gives free). Paid: hard blocking, allowlist import/export of policy files, encrypted ledger and CSV export. Paid is the office features, which is the actual reason an owner buys.

## Price

**$49 per year per business (flat, up to 50 seats).** About $4/month equivalent, below the $5–9/month the PRD guessed, because the evidence of payment is thin and the free alternatives are real. Annual rather than monthly because: Stripe's fee (2.9% + $0.30) takes ~$0.45 off a $5 monthly charge (9%), versus ~$1.72 (3.5%) on $49; a local-only tool has no ongoing server story that justifies a monthly bill; and one decision per year is easier to approve. Anchors: Nudge $750/month (unreachable for them), password manager ~$8–9/user/month (a 10-person firm pays ~$90/month for that, so $49/year for a tool that protects the same mailboxes is an easy line item if the pain lands). If nobody bites at $49, drop to $29 before concluding anything.

## How payment works with no backend

Stripe Checkout **payment link** (no code). The extension has no server, so licensing is manual for the first ten: after payment, David emails the buyer a license code. Build step: the extension verifies an offline-signed code (e.g., ed25519 signature over email + expiry, public key in the extension) so no server is needed. Until that exists, the paid features can sit behind an honor-system "license key" field and David sends keys by hand from the Stripe receipt email. Do not build automated licensing before 10 buyers.

## Do-before-charging checklist

- Verify the real flow (M2 gate, M3 ledger) works in a real Chrome against a live Google consent screen, with desktop-size screenshots (extension popups, interstitial) in `docs/screenshots/` and the README.
- **Chrome Web Store listing.** The one-time developer registration fee ($5) is not $0. It's tiny but it's money, so this needs David's approval and payment. The alternative, "load unpacked" from GitHub, is not acceptable for non-technical office managers. Review time and acceptance of a gating extension is an open risk (declarativeNetRequest + accounts.google.com host permission will get scrutiny).
- Privacy policy and Terms pages (missing today; also required for the Web Store listing). The privacy policy's key honest line: all data stays on the device, nothing is sent to us.
- Landing page launch basics (og:image, robots.txt, sitemap.xml): the launch checker lists these missing.
- Stripe product + payment link (David creates; RepoHQ mapping).
- Comparison page: "grantgate vs Google Admin vs AppTotal vs Nudge", stated fairly. Buyers will search for this.
- Refund promise: 30 days, no questions. Cheap at this volume and removes the trust gap for an unknown vendor's security product.

## Where to find ten people

Be specific; these are places where owners of small Workspace firms or their IT helpers actually talk. Join in the plain and useful way, not as a drive-by link drop. URLs are well-known communities; I haven't verified the current rules of each, so read them first.

- r/sysadmin and r/msp (reddit.com/r/msp): MSPs managing Workspace tenants for small clients; they can say if this is an add-on they'd resell. Highest signal on the "is the buyer the MSP" open question.
- r/gsuite (reddit.com/r/gsuite): admins asking about third-party app control; the exact people who ask "how do I stop staff approving random apps?".
- r/smallbusiness and r/accounting: owner-level pain stories. Weak for conversion, good for interviews.
- Google Workspace Admin Community (support.google.com/a/community): threads about "app access control"; helpful answers with a link when rules allow.
- Hacker News "Show HN" (news.ycombinator.com): good for installs and Web Store reviews, poor for buyers. Use it for technical credibility and a free-tier install count.
- LinkedIn: direct DMs to owners of 5–50 person firms in one niche (e.g., accounting practices in one city). 30 DMs a week with one question: "How do you handle staff approving Google apps?" Interviews first, pitch second.

## First ten users, in order

1. Five interviews from r/gsuite and r/msp threads (ask, don't pitch). Show the interstitial on a real consent screen. Watch them, don't demo.
2. Offer the three most engaged a paid install at $49 with a 30-day refund, by email, hand-delivered license key. Note: a friendly "yes I'd pay" counts for nothing; a card does.
3. Personal network: any small-firm owners David knows directly. Ask for one 20-minute screen share each.
4. Post a Show HN with the free tier once the Web Store listing is live; convert the 2–3 office-manager types who write in.
5. Ask each buyer for an MSP/peer introduction.

## Risks

- AppTotal (and Google) already cover warnings; the paid delta is blocking + policy sharing + ledger, which may not matter to buyers.
- Free Google Admin controls cover the same ground for admins.
- Web Store rejects or delays a gating extension; no distribution otherwise.
- Friction: staff disable the gate; hard to prove retained value (a gate that never fires looks like it does nothing).
- Annual billing for a product with no recurring server cost invites "why recurring?" Mitigation: updates to scope risk labels as Google adds scopes.
- Local-only design means no license enforcement, no usage telemetry, and no way to see if it works for anyone except by asking.
- Support burden for a security product on tiny revenue.
- Competitive-claim risk: the research could not read AppTotal's listing; the free/paid status is unknown.

## Kill criteria

Stop if, after 2 weeks with the Web Store listing live and 10 real interviews: fewer than 2 of 10 say they'd pay $5–9/month (PRD's own kill line), **or** zero card payments at $49 (then $29) from the first 30 qualified conversations, **or** AppTotal turns out to be free with blocking, **or** Web Store rejects the extension twice. Success bar for continuing: 3 paying customers within 60 days.

## Next action for David

1. Install AppTotal's extension and run it against a real consent screen (15 minutes); record what it does and costs. This decides everything else.
2. If our delta survives, approve the $5 Web Store fee, create the Stripe payment link at $49/year, and start the interviews.
