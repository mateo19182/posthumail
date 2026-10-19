import type { D1Database, R2Bucket, SendEmail } from "@cloudflare/workers-types";
import { type Config, type Person, durations, parseDuration, people, validate } from "./config.ts";
import { type Purpose, type Sealed, open, sign, verify } from "./crypto.ts";
import * as M from "./machine.ts";
import * as T from "./texts.ts";

export interface Env {
  db: D1Database;
  files: R2Bucket;
  mail: SendEmail;
  telegramToken: string;
  telegramSecret: string;
  linkSecret: string;
  messageKey: string;
  adminToken: string;
}

export interface Attachment {
  key: string;
  name: string;
}

export interface StoredMessage extends Sealed {
  id: string;
  recipients: string[];
}

// Decrypted message payload; the CLI seals this JSON.
export interface MessageBody {
  subject: string;
  body: string;
  attachments: Attachment[];
}

// ---------- storage ----------

const kvGet = async <A>(env: Env, key: string): Promise<{ value: A; version: number } | null> => {
  const row = await env.db
    .prepare("SELECT value, version FROM kv WHERE key = ?")
    .bind(key)
    .first<{ value: string; version: number }>();
  return row ? { value: JSON.parse(row.value) as A, version: row.version } : null;
};

const kvPut = (env: Env, key: string, value: unknown) =>
  env.db
    .prepare(
      "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2, version = version + 1",
    )
    .bind(key, JSON.stringify(value))
    .run();

const log = (env: Env, kind: string, detail?: unknown) =>
  env.db
    .prepare("INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)")
    .bind(Date.now(), kind, detail === undefined ? null : JSON.stringify(detail))
    .run();

const getConfig = async (env: Env) => (await kvGet<Config>(env, "config"))?.value ?? null;

const ctxOf = (c: Config): M.Ctx => ({
  d: durations(c.timing),
  trustees: c.trustees.map((t) => t.id),
  quorum: c.quorum,
});

// Optimistic update of the single state row; retried if the cron and a webhook race.
const mutate = async (env: Env, c: Config, f: (s: M.State) => M.Step) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await kvGet<M.State>(env, "state");
    if (!cur) return null;
    const step = f(cur.value);
    if (step.state === cur.value) return step;
    const res = await env.db
      .prepare("UPDATE kv SET value = ?, version = version + 1 WHERE key = 'state' AND version = ?")
      .bind(JSON.stringify(step.state), cur.version)
      .run();
    if (res.meta.changes === 1) {
      if (step.actions.length) await log(env, "actions", step.actions);
      await perform(env, c, step);
      return step;
    }
  }
  throw new Error("state update conflict");
};

const chatOf = async (env: Env, personId: string) =>
  (await env.db.prepare("SELECT chat_id FROM chats WHERE person_id = ?").bind(personId).first<number>("chat_id")) ??
  null;

const personByChat = async (env: Env, c: Config, chatId: number) => {
  const id = await env.db.prepare("SELECT person_id FROM chats WHERE chat_id = ?").bind(chatId).first<string>("person_id");
  return id ? (people(c).find((p) => p.id === id) ?? null) : null;
};

// ---------- channels ----------

const baseUrl = (c: Config) => `https://${c.domain}`;
const link = async (env: Env, c: Config, path: string, p: Purpose, subject: string) =>
  `${baseUrl(c)}/${path}/${await sign(env.linkSecret, p, subject)}`;

type Button = { text: string; data: string };

const tg = async (env: Env, method: string, body: unknown) => {
  const res = await fetch(`https://api.telegram.org/bot${env.telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`telegram ${method}: ${res.status} ${await res.text()}`);
};

const tgSend = (env: Env, chatId: number, text: string, buttons: Button[] = []) =>
  tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(buttons.length && {
      reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] },
    }),
  });

const email = (env: Env, c: Config, to: string, subject: string, text: string) =>
  env.mail.send({ from: { name: "posthumail", email: c.from }, to, subject, text });

// Telegram and email are independent: one failing must not block the other.
const notify = async (
  env: Env,
  c: Config,
  person: Person,
  msg: { text: string; subject: string; emailText?: string; buttons?: Button[] },
) => {
  const chat = await chatOf(env, person.id);
  const results = await Promise.allSettled([
    chat === null ? Promise.resolve() : tgSend(env, chat, msg.text, msg.buttons),
    email(env, c, person.email, msg.subject, msg.emailText ?? msg.text),
  ]);
  const errors = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
  if (errors.length) await log(env, "notify_error", { to: person.id, errors });
};

const trusteeById = (c: Config, id: string) => c.trustees.find((t) => t.id === id)!;

const perform = async (env: Env, c: Config, step: M.Step) => {
  const ownerName = c.owner.name;
  for (const a of step.actions) {
    switch (a.kind) {
      case "ownerPing": {
        const text = T.owner.ping(a.reminder, a.urgent);
        await notify(env, c, c.owner, {
          text,
          subject: T.owner.pingSubject(a.urgent),
          emailText: T.owner.pingEmail(text, await link(env, c, "c", "checkin", c.owner.id)),
          buttons: [{ text: T.owner.aliveButton, data: "alive" }],
        });
        break;
      }
      case "askTrustee": {
        const t = trusteeById(c, a.id);
        const text = T.trustee.ask(ownerName, a.again);
        await notify(env, c, t, {
          text,
          subject: T.trustee.askSubject(ownerName),
          emailText: T.trustee.askEmail(text, await link(env, c, "t", "trustee", t.id)),
          buttons: [
            { text: T.trustee.fineButton, data: "fine" },
            { text: T.trustee.diedButton, data: "died" },
          ],
        });
        break;
      }
      case "trusteeConfirmed": {
        const text = T.owner.trusteeConfirmed(trusteeById(c, a.id).name, a.count, c.quorum);
        await notify(env, c, c.owner, {
          text,
          subject: T.owner.pingSubject(true),
          emailText: T.owner.pingEmail(text, await link(env, c, "c", "checkin", c.owner.id)),
          buttons: [{ text: T.owner.aliveButton, data: "alive" }],
        });
        break;
      }
      case "cooling":
        for (const t of c.trustees) {
          const text = T.trustee.cooling(ownerName, a.until);
          await notify(env, c, t, { text, subject: T.trustee.askSubject(ownerName) });
        }
        break;
      case "falseAlarm":
        for (const id of a.trustees) {
          const text = T.trustee.falseAlarm(ownerName);
          await notify(env, c, trusteeById(c, id), { text, subject: text });
        }
        if (a.by !== "owner") {
          const text = T.owner.falseAlarmBy(trusteeById(c, a.by).name);
          await notify(env, c, c.owner, { text, subject: `posthumail: ${text}` });
        }
        break;
      case "release":
        await log(env, "release");
        break;
    }
  }
};

// ---------- release ----------

const deliver = async (env: Env, c: Config) => {
  const { results: messages } = await env.db
    .prepare("SELECT id, recipients, iv, ct FROM messages")
    .all<{ id: string; recipients: string; iv: string; ct: string }>();
  let pending = 0;
  for (const m of messages) {
    const body = JSON.parse(await open(env.messageKey, m)) as MessageBody;
    for (const pid of JSON.parse(m.recipients) as string[]) {
      const person = people(c).find((p) => p.id === pid);
      if (!person) continue;
      const files = await Promise.all(
        body.attachments.map(async (f) => `- ${f.name}: ${await link(env, c, "f", "file", `${pid}.${f.key}`)}`),
      );
      const text = [body.body.trim(), files.length ? `${T.recipient.attachments}\n${files.join("\n")}` : "", T.recipient.footer(c.owner.name)]
        .filter(Boolean)
        .join("\n\n");
      const chat = await chatOf(env, pid);
      const channels: [string, () => Promise<unknown>][] = [
        ["email", () => email(env, c, person.email, body.subject, text)],
        ...(chat === null
          ? []
          : ([["telegram", () => tgSend(env, chat, `${T.recipient.tgCopy(body.subject)}\n\n${text}`)]] as [
              string,
              () => Promise<unknown>,
            ][])),
      ];
      for (const [channel, send] of channels) {
        const row = await env.db
          .prepare("SELECT sent_at, attempts FROM deliveries WHERE message_id = ? AND person_id = ? AND channel = ?")
          .bind(m.id, pid, channel)
          .first<{ sent_at: number | null; attempts: number }>();
        if (row?.sent_at || (row?.attempts ?? 0) >= 48) continue;
        let error: string | null = null;
        try {
          await send();
        } catch (e) {
          error = String(e);
          pending++;
        }
        await env.db
          .prepare(
            `INSERT INTO deliveries (message_id, person_id, channel, sent_at, attempts, error) VALUES (?1, ?2, ?3, ?4, 1, ?5)
             ON CONFLICT DO UPDATE SET sent_at = ?4, attempts = attempts + 1, error = ?5`,
          )
          .bind(m.id, pid, channel, error ? null : Date.now(), error)
          .run();
      }
    }
  }
  if (pending === 0 && !(await kvGet(env, "released_notice"))) {
    for (const t of c.trustees) {
      const text = T.trustee.released(c.owner.name);
      await notify(env, c, t, { text, subject: text });
    }
    await kvPut(env, "released_notice", Date.now());
  }
};

export const tick = async (env: Env, now = Date.now()) => {
  const c = await getConfig(env);
  if (!c) return;
  const step = await mutate(env, c, (s) => M.tick(s, now, ctxOf(c)));
  if (step?.state.phase === "released") await deliver(env, c);
};

// ---------- HTTP ----------

const html = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><style>body{font:18px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}` +
      `button{font:inherit;padding:.6rem 1.2rem;margin:.3rem .3rem 0 0;border-radius:.5rem;border:1px solid #888;background:#fff;cursor:pointer}` +
      `@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#222;color:#eee}}</style>` +
      `<h1>${title}</h1>${body}</html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const form = (buttons: [string, string][]) =>
  `<form method="post">${buttons.map(([action, label]) => `<button name="action" value="${action}">${esc(label)}</button>`).join("")}</form>`;

const checkinNow = async (env: Env, c: Config) => {
  const step = await mutate(env, c, (s) => M.checkin(s, Date.now()));
  return step ? M.dueAt(step.state, durations(c.timing)) : null;
};

// The check-in link acts on GET: a stray click only delays the switch, and Gmail does not prefetch links.
const handleCheckinLink = async (env: Env, c: Config, token: string) => {
  if ((await verify(env.linkSecret, "checkin", token)) !== c.owner.id) return html(T.page.invalid, "", 404);
  const next = await checkinNow(env, c);
  return html(T.page.checkinDone, next ? `<p>${esc(T.owner.thanks(next))}</p>` : "");
};

const trusteeAction = async (env: Env, c: Config, id: string, action: string) => {
  const now = Date.now();
  if (action === "fine") {
    const step = await mutate(env, c, (s) => M.trusteeFine(s, now, id));
    return step?.actions.length ? T.trustee.fineRecorded(c.owner.name) : T.trustee.notAsked;
  }
  if (action === "died") {
    const step = await mutate(env, c, (s) => M.trusteeConfirm(s, now, id, ctxOf(c)));
    return step?.actions.length ? T.trustee.recorded : T.trustee.notAsked;
  }
  return null;
};

// Trustee links only act on POST so link scanners can't confirm a death.
const handleTrusteeLink = async (env: Env, c: Config, req: Request, token: string) => {
  const id = await verify(env.linkSecret, "trustee", token);
  if (!id || !c.trustees.some((t) => t.id === id)) return html(T.page.invalid, "", 404);
  const title = T.page.trustee(c.owner.name).title;
  if (req.method !== "POST")
    return html(title, form([["fine", T.trustee.fineButton], ["died", T.trustee.diedButton]]));
  const result = await trusteeAction(env, c, id, String((await req.formData()).get("action")));
  return html(title, `<p>${esc(result ?? T.page.invalid)}</p>`);
};

const handleFile = async (env: Env, token: string) => {
  const subject = await verify(env.linkSecret, "file", token);
  const key = subject?.split(".").slice(1).join(".");
  const obj = key ? await env.files.get(key) : null;
  if (!obj) return html(T.page.invalid, "", 404);
  return new Response(obj.body as unknown as ReadableStream, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(obj.customMetadata?.name ?? key!)}`,
    },
  });
};

interface TgUpdate {
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

const handleTelegram = async (env: Env, c: Config, u: TgUpdate) => {
  const chatId = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
  if (chatId === undefined) return;
  if (u.callback_query) await tg(env, "answerCallbackQuery", { callback_query_id: u.callback_query.id });
  const text = u.message?.text?.trim() ?? "";

  const start = /^\/start\s+(\S+)/.exec(text);
  if (start) {
    const id = await verify(env.linkSecret, "link", start[1]!);
    const person = id ? people(c).find((p) => p.id === id) : undefined;
    if (!person) return tgSend(env, chatId, T.bot.unknown);
    await env.db
      .prepare(
        "INSERT INTO chats (person_id, chat_id, linked_at) VALUES (?1, ?2, ?3) ON CONFLICT(person_id) DO UPDATE SET chat_id = ?2, linked_at = ?3",
      )
      .bind(person.id, chatId, Date.now())
      .run();
    await log(env, "linked", { person: person.id });
    return tgSend(env, chatId, T.bot.linked(person.name));
  }

  const person = await personByChat(env, c, chatId);
  if (!person) return tgSend(env, chatId, T.bot.unknown);
  const d = durations(c.timing);
  const data = u.callback_query?.data;

  if (person.id === c.owner.id) {
    if (data === "alive" || text === "/alive") {
      const next = await checkinNow(env, c);
      return tgSend(env, chatId, next ? T.owner.thanks(next) : T.page.released);
    }
    const p = /^\/pause\s+(\S+)/.exec(text);
    if (p) {
      let ms: number;
      try {
        ms = parseDuration(p[1]!);
      } catch {
        return tgSend(env, chatId, T.owner.help);
      }
      const step = await mutate(env, c, (s) => M.pause(s, Date.now(), ms, d));
      return tgSend(env, chatId, step?.state.pausedUntil ? T.owner.paused(step.state.pausedUntil) : T.page.released);
    }
    if (text === "/resume") {
      const step = await mutate(env, c, (s) => M.resume(s, Date.now()));
      return tgSend(env, chatId, step ? T.owner.thanks(M.dueAt(step.state, d)) : T.page.released);
    }
    if (text === "/status") {
      const s = (await kvGet<M.State>(env, "state"))?.value;
      return tgSend(env, chatId, s ? statusText(s, c) : "—");
    }
    return tgSend(env, chatId, T.owner.help);
  }

  if (c.trustees.some((t) => t.id === person.id) && data) {
    const result = await trusteeAction(env, c, person.id, data);
    if (result) return tgSend(env, chatId, result);
  }
};

const statusText = (s: M.State, c: Config) => {
  const d = durations(c.timing);
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return [
    `phase: ${s.phase}`,
    `last check-in: ${fmt(s.lastCheckin)}`,
    `next ping: ${fmt(M.dueAt(s, d))}`,
    s.pausedUntil ? `paused until: ${fmt(s.pausedUntil)}` : "",
    Object.keys(s.confirmed).length ? `confirmed: ${Object.keys(s.confirmed).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const json = (data: unknown, status = 200) => Response.json(data, { status });

interface SyncBody {
  config: Config;
  messages: StoredMessage[];
}

const handleAdmin = async (env: Env, req: Request, path: string[]) => {
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${env.adminToken}`))
    return json({ error: "unauthorized" }, 401);
  const [route, arg] = path;

  if (route === "sync" && req.method === "POST") {
    const body = (await req.json()) as SyncBody;
    const c = validate(body.config);
    const state = await kvGet<M.State>(env, "state");
    if (state?.value.phase === "released") return json({ error: "already released" }, 409);
    const ids = new Set(people(c).map((p) => p.id));
    const unknown = body.messages.flatMap((m) => m.recipients.filter((r) => !ids.has(r) || r === c.owner.id));
    if (unknown.length) return json({ error: `unknown recipients: ${unknown.join(", ")}` }, 400);
    await env.db.batch([
      env.db
        .prepare("INSERT INTO kv (key, value) VALUES ('config', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1, version = version + 1")
        .bind(JSON.stringify(c)),
      ...(state ? [] : [env.db.prepare("INSERT INTO kv (key, value) VALUES ('state', ?)").bind(JSON.stringify(M.initial(Date.now())))]),
      env.db.prepare("DELETE FROM messages"),
      ...body.messages.map((m) =>
        env.db
          .prepare("INSERT INTO messages (id, recipients, iv, ct) VALUES (?, ?, ?, ?)")
          .bind(m.id, JSON.stringify(m.recipients), m.iv, m.ct),
      ),
    ]);
    await log(env, "sync", { messages: body.messages.length });
    return json({ ok: true, messages: body.messages.length });
  }

  if (route === "files" && arg) {
    if (req.method === "HEAD") return new Response(null, { status: (await env.files.head(arg)) ? 200 : 404 });
    if (req.method === "PUT") {
      await env.files.put(arg, req.body as never, {
        httpMetadata: { contentType: req.headers.get("content-type") ?? "application/octet-stream" },
        customMetadata: { name: decodeURIComponent(req.headers.get("x-file-name") ?? arg) },
      });
      return json({ ok: true });
    }
  }

  if (route === "tick" && req.method === "POST") {
    await tick(env);
    return json({ ok: true });
  }

  if (route === "status" && req.method === "GET") {
    const c = await getConfig(env);
    const s = (await kvGet<M.State>(env, "state"))?.value ?? null;
    const { results: chats } = await env.db.prepare("SELECT person_id, linked_at FROM chats").all();
    const { results: deliveries } = await env.db.prepare("SELECT * FROM deliveries").all();
    const { results: events } = await env.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 30").all();
    const messages = await env.db.prepare("SELECT COUNT(*) AS n FROM messages").first<number>("n");
    return json({ state: s, summary: s && c ? statusText(s, c) : null, chats, messages, deliveries, events });
  }

  return json({ error: "not found" }, 404);
};

export const fetchHandler = async (env: Env, req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const [first, ...rest] = url.pathname.split("/").filter(Boolean);

  if (first === "admin") return handleAdmin(env, req, rest);
  if (first === "tg" && !safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", env.telegramSecret))
    return new Response(null, { status: 401 });

  const c = await getConfig(env);
  if (!c) return html("posthumail", "", 503);

  if (first === "tg" && req.method === "POST") {
    try {
      await handleTelegram(env, c, (await req.json()) as TgUpdate);
    } catch (e) {
      await log(env, "telegram_error", String(e));
    }
    // Always 200 so Telegram doesn't redeliver the update forever.
    return new Response("ok");
  }
  if (first === "c" && rest[0]) return handleCheckinLink(env, c, rest[0]);
  if (first === "t" && rest[0]) return handleTrusteeLink(env, c, req, rest[0]);
  if (first === "f" && rest[0]) return handleFile(env, rest[0]);
  return html("posthumail", "");
};
