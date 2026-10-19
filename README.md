# posthumail

A self-hosted dead man's switch on Cloudflare (free plan). It sends a monthly check-in over Telegram and email. If the owner goes quiet, trusted people are asked, staggered over a few days. Once a quorum of them confirms the death and a cooling-off period passes, pre-written messages and files are delivered.

Nothing is released without trustee confirmation. There is no timeout fallback.

## How it works

| Phase | What happens |
|---|---|
| alive | Quiet until `checkinEvery` (30d) after the last check-in, then the owner is pinged on Telegram (button) and by email (link). Reminders go out every `remindEvery`. |
| asking | After `grace` (21d) with no reply, trustees are asked one at a time, `trusteeStagger` (3d) apart, and re-asked every `trusteeReask`. The owner keeps getting pinged. |
| cooling | `quorum` trustees confirmed. The owner gets urgent pings every `coolingPingEvery` for `cooling` (48h). |
| released | Messages go to each recipient by email, plus a Telegram copy if they linked the bot. Attachments are per-recipient links to R2. Failed sends are retried hourly. |

Any owner check-in (button, email link, `/alive`), or any trustee answering "fine", resets everything back to *alive*. `/pause 60d` postpones the next ping, capped at `maxPause`. Email links only act on a POST from the page, so link scanners can't trigger anything.

## Stack

- `alchemy.run.ts` / `src/worker.ts`: Alchemy v2 (Effect). One Worker with an hourly cron, D1 (state, chats, encrypted messages, delivery log), R2 (attachments), a `send_email` binding, and one `Email.Address` per person.
- `src/machine.ts`: the pure state machine. All the timing rules live here, tested in `test/machine.test.ts`.
- `src/app.ts`: HTTP routes, Telegram webhook, notifications, delivery. `test/app.test.ts` runs the full flow against fake D1, R2, mail and Telegram.
- Email goes through Resend (`RESEND_API_KEY`, sender on m19182.dev). If Resend fails, mail to the owner and trustees falls back to Cloudflare Email Routing. That only reaches verified addresses, so deploying creates an Address for each of them, and Cloudflare sends each one a one-time verification email. Other recipients rely on Resend, with hourly retries.

## Setup

```sh
bun install
bun cli init                      # generates secrets into .env (never printed)
cp posthumail.config.example.ts posthumail.config.ts   # people, timing, domain
bunx alchemy profile edit         # Cloudflare credentials (one time)
bun cli deploy                    # alchemy deploy with domain/cron from the config
bun cli webhook                   # point the Telegram bot at the Worker
bun cli sync                      # upload config + encrypted messages + attachments
bun cli invites                   # per-person t.me links; everyone opens theirs once
bun cli status                    # phase, linked chats, deliveries
```

Set `manageAddress: false` on a person whose address is already a verified destination used by other routing rules. That way `alchemy destroy` can never delete it.

## Messages

Put one Markdown file per message in `messages/` (gitignored). The filename is the message id:

```md
---
to: [mama, ana]          # person ids from the config (trustees allowed, not the owner)
subject: Para ti
attachments: [./files/ultimo-set.mp3]
---
Text, sent as-is.
```

`bun cli sync` encrypts each message locally with `MESSAGE_KEY` (AES-GCM). Only the Worker holds that key, as a secret. Attachments are stored unencrypted in a private R2 bucket and served only through signed per-recipient links. Every sync replaces all messages. Sync is refused once released.

## Quarterly updates

These go to the blog newsletter's "Quarterly updates" segment in Resend (`updates` in the config). The Worker reminds the owner when a quarter starts, and again two weeks later if nothing was sent.

```sh
$EDITOR updates/2026-q4.md                 # frontmatter: subject. Plain text body.
bun cli update send 2026-q4 --test         # only to the owner
bun cli update send 2026-q4                # preview, confirm, broadcast; marks the quarter done
```

Re-running reuses the Resend draft, so a sent update is never sent twice. The death-notice list is separate and manual: add the people you want to the config and address messages to them.

## Secrets

`.env` holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RESEND_API_KEY`, `TELEGRAM_TOKEN`, `LINK_SECRET` (signs links), `MESSAGE_KEY`, `ADMIN_TOKEN` (CLI → `/admin/*`) and `TELEGRAM_WEBHOOK_SECRET`. Keep an offline backup. Rotating `LINK_SECRET` invalidates every Telegram invite and email link.

## Test stage

Make a copy of the config with short timings (e.g. `checkinEvery: "10m"`, `cron: "* * * * *"`), a different `domain`, and test addresses, then:

```sh
POSTHUMAIL_CONFIG=posthumail.test.config.ts POSTHUMAIL_MESSAGES=messages.test bun cli deploy --stage test
# ...webhook/sync/invites with the same env vars, run through it, then:
POSTHUMAIL_CONFIG=posthumail.test.config.ts bunx alchemy destroy --stage test
```

Both stages share one bot, so only one stage can own the webhook at a time. Re-run `bun cli webhook` for prod afterwards.

Run this end to end once a year.
