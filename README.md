# grantgate — consent-click gate for Google OAuth grants

## Screenshots

![The start page on a desktop: the headline, and a preview of grantgate stopping an app that wants all of Gmail and Drive](docs/screenshots/home-desktop.png)
The start page, served from the production build, with a risk preview that quotes the extension's own labels.

![The start page on a phone](docs/screenshots/home-mobile.png)
The same start page fits an iPhone 13 screen, with the header collapsed to its call to action.

![The extension's interstitial stopping a sample "PDF tool" that asks for Gmail and Drive, on a desktop](docs/screenshots/gate-desktop.png)
The core action: the built extension's own page, given a sample sign-in by the real `assess()`, holds back Gmail and Drive access and offers its four choices.

![The same interstitial on a phone](docs/screenshots/gate-mobile.png)
The gate stays readable on a phone, long app ID included.

![After joining the waitlist on a desktop: the "Buy for $49/year" button, the "you're on the list" reply, and the footer's Privacy and Terms links](docs/screenshots/waitlist-joined-desktop.png)
A real sign-up went through `/api/waitlist` and got its reply, with the Buy button (placeholder payment link) and the footer's Privacy and Terms links in view.

![The Buy button and the waitlist reply on a phone](docs/screenshots/waitlist-joined-mobile.png)
Buying and joining work on a phone too. Taken by `npm run screenshots` with sample data, an in-memory store and a placeholder `STRIPE_PAYMENT_LINK`; the sandbox's Chromium has only a monospace font.

For owners of 5–50 person Google Workspace businesses with no IT staff, it intercepts "Sign in with Google" consent prompts, blocks risky scope grants and keeps a local encrypted ledger, for a flat $49 a year instead of enterprise tools that start at $750/month.

- [Research](RESEARCH.md) — findings and sources
- [PRD](PRD.md)
- [Roadmap](ROADMAP.md)
- [Build notes](BUILD.md): what's built (M1–M4), how to run, test and deploy it
- [Launch notes](LAUNCH-READY.md): search and sharing tags, privacy and terms, the Buy button, the visit beacon, and what's left before launch
- [Interview script](docs/interview-script.md): the demand test

Effort: Low · Confidence: Low

_Researched by the idea pipeline on 2026-10-11 ([original record](https://github.com/smithdavedesign/idea-factory/tree/main/ideas/grantgate)); repo created on David's go-ahead 2026-10-11._
