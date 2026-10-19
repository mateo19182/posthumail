# posthumail

A self-hosted dead man's switch on Cloudflare's free plan. Monthly check-ins by email and Telegram. If you stop answering, trusted people are asked. Once enough confirm, your messages are sent. It also sends quarterly life updates to a newsletter segment.

## Flow

Hourly cron. Default timings, all configurable:

1. **Day 30**: you get a ping, then a reminder every 4 days. One click on the link or the button resets everything.
2. **Day 51**: trustees are asked one at a time, 3 days apart. One "fine" from any of them resets everything.
3. **2 of 3 confirm**: you get urgent pings for 48 hours.
4. **Release**: messages are delivered. Release is final.

Nothing is sent without trustee confirmation. Undelivered warnings don't count:
- Trustees are only asked after 2 pings reached you.
- The 48 hours start at the first urgent ping that reached you.

## Stack

[Alchemy](https://alchemy.run) v2 deploys a Worker with a cron trigger, D1 and R2. Email goes through Resend, with Cloudflare Email Routing as a fallback for you and the trustees. `src/machine.ts` holds the logic as a pure state machine, and `test/` covers the full flow.

## Use

```sh
bun install && bun cli init                            # secrets into .env
cp posthumail.config.example.ts posthumail.config.ts   # people, timing, domain, segments
bun cli deploy --stage prod                            # needs Cloudflare + Resend keys in .env, and Node 22
bun cli webhook && bun cli sync && bun cli invites     # Telegram links are optional
bun cli status
```

Messages are Markdown files in `messages/`:

```md
---
to: [all, ana, someone@example.com]   # all = killswitch segment, trustee id, or email
subject: Para ti
attachments: [./files/last-set.mp3]
---
Plain text.
```

`sync` encrypts each message locally. Only the Worker can decrypt it.

Quarterly updates go out on the solstices and equinoxes, with a reminder a week before:

```sh
bun cli update send 2026-q4 --test   # then without --test; an optional `blog:` field also publishes to the blog
```

Back up `.env` and `.alchemy/`. Run a test stage end to end once a year.
