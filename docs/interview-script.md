# grantgate — interview script

M4's exit criterion asks for 10 interviews scheduled. This file is how they are found, booked, run and scored.

**Never put names or email addresses in this file: it lives in the repo.** Use initials only in the tracker. Contact details stay in your own email and calendar.

## Goal and decision rule

We want to learn two things. Would the people the PRD targets pay $5–9/month for grantgate? And who is the buyer: the owner, or an outsourced IT provider?

Ask 10 people. A "yes" counts only when it comes with a reason or an action, such as a pre-order, an introduction or asking for the beta. A pre-order through the landing page counts as a yes.

- **At least 3 of 10** would pay: keep going. Next come a Chrome Web Store listing and real onboarding.
- **Fewer than 2** of 10 would pay: stop. Kill grantgate, or rethink who it's for.
- **Exactly 2**: book five more interviews. Keep going if at least one of those five would pay; otherwise stop.

## Who to talk to

- **At least 6 owners or office managers** of a 5–50 person business on Google Workspace. This is the PRD's target user: whoever ends up being the admin.
- **Up to 2 IT providers** who look after several small businesses. They are the other possible buyer.
- **Up to 2 security-minded individuals** with a personal Google account.

Avoid:
- friends who will be kind;
- people at companies with an IT department, who already have Google Admin and paid tools;
- developers, who will tell you how they'd build it.

## Screener

Ask these before booking, in the invite or in the first minute of the call:

- Does your business use Google Workspace (Gmail on your own domain)?
- How many people use it? Aim for 5–50.
- Who sets things up when someone needs a new app or account?
- Has anyone on your team used "Sign in with Google" for a new app in the last few months?

## Finding people ($0)

- **The waitlist.** People who ticked "I'm happy to do a 15-minute call" on the landing page. Run this in the Neon console's SQL editor for the grantgate project; it lists them oldest first:

```sql
SELECT email, role, team_size, joined_at FROM waitlist WHERE interview ORDER BY joined_at
```

- **Your own network:** local business owners (dental and medical practices, accountants, agencies, shops), plus your own accountant or bookkeeper.
- **Communities:** a local chamber of commerce or business group, LinkedIn, and r/smallbusiness or r/sysadmin. Read each group's rules, and ask for advice rather than selling.
- **IT providers:** search for "IT support for small business" near you. Each of them looks after dozens of the right businesses.

Invite, short and specific:

> Subject: 15 minutes on how your team signs in to apps?
>
> Hi [first name], I'm building a small tool that warns people before they give an app access to their Google account (the "Sign in with Google" → Allow screen). I'm not selling anything yet. I'd like 15 minutes to hear how your team handles this today. Would [time 1], [time 2] or [time 3] work? Thanks, [your name]

Scheduling:
- Offer three specific times, for 15 minutes by video or phone.
- When someone accepts, send a calendar invite and mark their row "scheduled" below.
- Aim to have all 10 rows "scheduled" or "done" within two weeks of the landing page going live.

## The interview (15 minutes)

Rules:
- Ask about what people did, not what they would do.
- Don't pitch until the idea section.
- Take notes in your own words.
- Ask before recording anything.

### Warm-up (2 minutes)

1. What does your business do, and how many people use Google Workspace?
2. Who looks after accounts and apps when someone needs something new?

### Past behaviour (6 minutes)

3. Tell me about the last time someone on your team started using a new app with "Sign in with Google". What happened?
4. Did anyone check what that app could see? Who checked, and how?
5. Have you ever found that an app had more access than you expected, or heard of it happening to someone you know? What did you do?
6. Have you ever opened Google's list of apps with access to your account, or the Admin console's app controls? When was that, and why?
7. What do you use today to keep accounts safe: passwords, MFA, a password manager, an IT provider? What does it cost each month?

### The idea (3 minutes)

Show the landing page's three risk levels, or the screenshot of grantgate stopping a request for full Gmail access.

8. What's your first reaction? What's unclear?
9. Who on your team would this have helped, and when?

### Price (3 minutes)

10. If this existed today for your whole team at $5 a month, would you buy it? Why or why not?
11. And at $9 a month?
12. What would make it an easy yes? What would make it a no?

### Close (1 minute)

13. Who else should I talk to about this? Could you introduce me?
14. Can I send you the beta when it's ready?

## Tracker

Initials only. A row's status moves from "to invite" to "invited", then "scheduled", then "done". It can also end as "no-show" or "declined". In the price columns write yes, no or maybe.

| # | When | Who (initials only) | Role | Team size | Found via | Status | Would pay $5/month? | Would pay $9/month? | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  | to invite |  |  |  |
| 2 |  |  |  |  |  | to invite |  |  |  |
| 3 |  |  |  |  |  | to invite |  |  |  |
| 4 |  |  |  |  |  | to invite |  |  |  |
| 5 |  |  |  |  |  | to invite |  |  |  |
| 6 |  |  |  |  |  | to invite |  |  |  |
| 7 |  |  |  |  |  | to invite |  |  |  |
| 8 |  |  |  |  |  | to invite |  |  |  |
| 9 |  |  |  |  |  | to invite |  |  |  |
| 10 |  |  |  |  |  | to invite |  |  |  |

## After each call

- Fill in the row the same day: role, team size, where you found them, both price answers and one line of notes.
- Check the Stripe dashboard for pre-orders, and count each one as a yes at $5.
- After the 10th call, apply the decision rule at the top.
- Also note the buyer pattern: did owners say yes, or IT providers? That decides who the store listing and the landing page should speak to.
