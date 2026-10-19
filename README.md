# posthumail

A self-hosted dead man's switch on Cloudflare's free plan. It asks the owner for a monthly check-in by email and Telegram. If the owner stops answering, it asks a few trusted people. Once enough of them confirm the death, and after a last warning period, it delivers pre-written messages and files.

Nothing is sent without trustee confirmation. There is no timeout fallback.

It also sends the owner's quarterly life updates, a Resend broadcast to a newsletter segment, and reminds the owner to write them.

## How it works

The Worker runs on an hourly cron. Defaults below; all timings are configurable.

| Phase | What happens |
|---|---|
| alive | Quiet for 30 days after the last check-in. Then the owner gets a ping (email link, Telegram button) and a reminder every 4 days. |
| asking | After 21 more days without a reply, trustees are asked one at a time, 3 days apart, and asked again weekly. The owner keeps getting pinged. |
| cooling | 2 of 3 trustees confirmed. The owner gets urgent pings every 6 hours for 48 hours. |
| released | Messages are delivered and failed sends retried hourly. Release is final. |

At any point before release, one owner check-in (email link, Telegram button, `/alive`) or one trustee answering "fine" resets everything. `/pause 60d` postpones the next ping, capped at `maxPause`.

Undelivered warnings never move it forward:

- An owner ping counts only when Telegram or the Cloudflare fallback accepts it, or when Resend reports it `delivered`. Bounced or unconfirmed pings are retried every 6 hours.
- Trustees are asked only after 2 delivered pings.
- The 48 hours of cooling start at the first urgent ping that was delivered.
- A trustee question that reached nobody is retried on the next tick.

The owner's check-in link acts on a single click. Trustee links show a page whose buttons submit a POST, so a mail scanner opening the link can't confirm anything.

## Stack

- `alchemy.run.ts`, `src/worker.ts`: [Alchemy](https://alchemy.run) v2 (Effect). One Worker with a cron trigger, D1 for state, encrypted messages and the delivery log, R2 for attachments, and a `send_email` binding.
- `src/machine.ts`: the state machine, pure and with no I/O. Tested in `test/machine.test.ts`.
- `src/app.ts`: HTTP routes, Telegram webhook, notifications and delivery. `test/app.test.ts` runs the whole flow against fake D1, R2, Resend and Telegram.
- Email goes through Resend. If Resend fails, mail to the owner and trustees falls back to Cloudflare Email Routing. That only reaches verified addresses, so deploying registers each trustee as one, and Cloudflare sends them a one-time verification email.

## Setup

Needs Bun and Node 22. The deploy runs Alchemy's CLI on Node, because its bundler needs a newer `util.styleText` than Bun 1.1 has.

```sh
bun install
bun cli init                                            # generates secrets into .env, never printed
cp posthumail.config.example.ts posthumail.config.ts    # owner, trustees, timing, domain, segments
bun cli deploy --stage prod                             # needs CLOUDFLARE_API_TOKEN/ACCOUNT_ID in .env
bun cli webhook                                         # points the Telegram bot at the Worker
bun cli sync                                            # config + encrypted messages + attachments
bun cli invites                                         # optional Telegram link for each person
bun cli status                                          # phase, Telegram links, Cloudflare verification, deliveries
```

Set `manageAddress: false` on a person whose address is already a verified destination used by other routing rules, so `alchemy destroy` never deletes it. Alchemy keeps deploy state in `.alchemy/`. Back it up together with `.env`.

## Messages

Put one Markdown file per message in `messages/` (gitignored). The filename is the message id.

```md
---
to: [all, ana, someone@example.com]
subject: Para ti
attachments: [./files/last-set.mp3]
---
Plain text, sent as-is.
```

`to` accepts three kinds of recipient:
- `all`: one broadcast to the killswitch segment in Resend. People join it from the blog's subscribe form.
- A trustee id: email, plus Telegram if they linked the bot.
- Any email address.

`bun cli sync` encrypts each message locally with `MESSAGE_KEY` (AES-GCM). Only the Worker holds that key, as a secret.

Attachments go into a private R2 bucket. They are served through signed links: one per recipient, and one shared link for broadcasts. Each sync replaces all messages. Sync is refused after release.

## Quarterly updates

Updates go out on the solstice or equinox that closes each quarter: Mar 20, Jun 21, Sep 22, Dec 21. The Worker reminds the owner a week before, and again on the day if nothing was sent.

```sh
$EDITOR updates/2026-q4.md               # frontmatter: subject, optional `blog: |`
bun cli update send 2026-q4 --test       # only to the owner
bun cli update send 2026-q4              # preview, confirm, broadcast to the updates segment
```

Each email ends with a link to earlier updates (`archiveUrl`) and an unsubscribe link. If the file has a `blog` field, that short public version is committed and pushed to `content/updates/` in the blog repo (`POSTHUMAIL_BLOG`). A broadcast is never sent twice.

## Secrets

`.env` holds:
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RESEND_API_KEY`, `TELEGRAM_TOKEN`
- `LINK_SECRET`, which signs every link
- `MESSAGE_KEY`
- `ADMIN_TOKEN`, used by the CLI to call `/admin/*`
- `TELEGRAM_WEBHOOK_SECRET`

Rotating `LINK_SECRET` invalidates every invite and every link already sent.

## Test stage

Copy the config with short timings (e.g. `"2m"`, `cron: "* * * * *"`), another `domain`, and test addresses. Then:

```sh
export POSTHUMAIL_CONFIG=posthumail.test.config.ts POSTHUMAIL_MESSAGES=messages.test
bun cli deploy --stage test && bun cli webhook && bun cli sync
# ...run through it, then destroy and point the webhook back at prod
```

Both stages share one bot, so only one of them can own the webhook at a time. Run the test once a year.
