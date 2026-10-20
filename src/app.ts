import type { D1Database, R2Bucket, SendEmail } from "@cloudflare/workers-types";
import { ALL, type Config, type Person, badRecipients, durations, parseDuration, people, validate } from "./config.ts";
import { type Purpose, type Sealed, open, sha256, sign, verify } from "./crypto.ts";
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
  resendKey: string;
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

const getState = async (env: Env) => {
  const cur = await kvGet<M.State>(env, "state");
  return cur ? { value: M.normalize(cur.value), version: cur.version } : null;
};

// Optimistic update of the single state row; retried if the cron and a webhook race.
const update = async (env: Env, f: (s: M.State) => M.Step) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await getState(env);
    if (!cur) return null;
    const step = f(cur.value);
    if (step.state === cur.value) return { step, changed: false };
    const res = await env.db
      .prepare("UPDATE kv SET value = ?, version = version + 1 WHERE key = 'state' AND version = ?")
      .bind(JSON.stringify(step.state), cur.version)
      .run();
    if (res.meta.changes === 1) return { step, changed: true };
  }
  throw new Error("state update conflict");
};

// Applies a transition, performs its actions, then feeds delivery results back.
const mutate = async (env: Env, c: Config, f: (s: M.State) => M.Step) => {
  const r = await update(env, f);
  if (!r) return null;
  if (r.changed && r.step.actions.length) {
    await log(env, "actions", r.step.actions);
    const results = await perform(env, c, r.step);
    if (results.length) await update(env, (s) => ({ state: results.reduce((acc, g) => g(acc), s), actions: [] }));
  }
  return r.step;
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

const resend = async (env: Env, c: Config, to: string, subject: string, text: string, idempotencyKey?: string) => {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.resendKey}`,
      "content-type": "application/json",
      ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify({ from: `posthumail <${c.from}>`, to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`resend: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id?: string }).id ?? null;
};

// Resend first; Cloudflare Email Routing as a fallback, which only reaches the
// owner and trustees because those are the verified destination addresses.
// Returns the Resend id to track delivery, or null when Cloudflare took it.
const email = async (env: Env, c: Config, person: Person, subject: string, text: string, idempotencyKey?: string) => {
  try {
    return { resendId: await resend(env, c, person.email, subject, text, idempotencyKey) };
  } catch (e) {
    const verified = person.id === c.owner.id || c.trustees.some((t) => t.id === person.id);
    if (!verified) throw e;
    await log(env, "resend_fallback", { to: person.id, error: String(e) });
    await env.mail.send({ from: { name: "posthumail", email: c.from }, to: person.email, subject, text });
    return { resendId: null };
  }
};

interface Outcome {
  telegram: boolean;
  // Accepted by an email provider: a Resend id still to be confirmed, or `true` for the Cloudflare fallback.
  email: string | true | null;
}

// Telegram and email are independent: one failing must not block the other.
const notify = async (
  env: Env,
  c: Config,
  person: Person,
  msg: { text: string; subject: string; emailText?: string; buttons?: Button[] },
): Promise<Outcome> => {
  const chat = await chatOf(env, person.id);
  const [tgr, mail] = await Promise.allSettled([
    chat === null ? Promise.reject(new Error("no telegram")) : tgSend(env, chat, msg.text, msg.buttons),
    email(env, c, person, msg.subject, msg.emailText ?? msg.text),
  ]);
  const errors = [tgr, mail].flatMap((r) =>
    r.status === "rejected" && String(r.reason) !== "Error: no telegram" ? [String(r.reason)] : [],
  );
  if (errors.length) await log(env, "notify_error", { to: person.id, errors });
  return {
    telegram: tgr.status === "fulfilled",
    email: mail.status === "fulfilled" ? (mail.value.resendId ?? true) : null,
  };
};

const trusteeById = (c: Config, id: string) => c.trustees.find((t) => t.id === id)!;

interface PendingPing {
  resendId: string;
  at: number;
}

// An owner ping counts as delivered when Telegram took it, the Cloudflare fallback
// took it, or Resend later reports it delivered (checked on the next ticks).
const ownerPingResult = async (env: Env, o: Outcome, at: number): Promise<(s: M.State) => M.State> => {
  if (o.telegram || o.email === true) return (s) => M.pingDelivered(s, at);
  if (typeof o.email === "string") {
    await kvPut(env, "ping_pending", { resendId: o.email, at } satisfies PendingPing);
    return (s) => s;
  }
  return (s) => M.pingFailed(s, at);
};

const DELIVERED = new Set(["delivered", "opened", "clicked"]);
const FAILED = new Set(["bounced", "complained", "failed", "canceled", "suppressed"]);

const resolvePendingPing = async (env: Env, now: number) => {
  const pending = (await kvGet<PendingPing>(env, "ping_pending"))?.value;
  if (!pending) return;
  const res = await fetch(`https://api.resend.com/emails/${pending.resendId}`, {
    headers: { authorization: `Bearer ${env.resendKey}` },
  });
  const event = res.ok ? ((await res.json()) as { last_event?: string }).last_event ?? "" : "";
  const failed = FAILED.has(event) || now - pending.at > 6 * 3_600_000;
  if (!DELIVERED.has(event) && !failed) return;
  await env.db.prepare("DELETE FROM kv WHERE key = 'ping_pending'").run();
  await log(env, "ping_result", { event, delivered: DELIVERED.has(event) });
  await update(env, (s) => ({ state: DELIVERED.has(event) ? M.pingDelivered(s, pending.at) : M.pingFailed(s, now), actions: [] }));
};

const perform = async (env: Env, c: Config, step: M.Step) => {
  const ownerName = c.owner.name;
  const results: ((s: M.State) => M.State)[] = [];
  for (const a of step.actions) {
    switch (a.kind) {
      case "ownerPing": {
        const text = T.owner.ping(a.reminder, a.urgent);
        const o = await notify(env, c, c.owner, {
          text,
          subject: T.owner.pingSubject(a.urgent),
          emailText: T.owner.pingEmail(text, await link(env, c, "c", "checkin", c.owner.id)),
          buttons: [{ text: T.owner.aliveButton, data: "alive" }],
        });
        results.push(await ownerPingResult(env, o, Date.now()));
        break;
      }
      case "askTrustee": {
        const t = trusteeById(c, a.id);
        const text = T.trustee.ask(ownerName, a.again);
        const o = await notify(env, c, t, {
          text,
          subject: T.trustee.askSubject(ownerName),
          emailText: T.trustee.askEmail(text, await link(env, c, "t", "trustee", t.id)),
          buttons: [
            { text: T.trustee.fineButton, data: "fine" },
            { text: T.trustee.diedButton, data: "died" },
          ],
        });
        if (!o.telegram && o.email === null) results.push((s) => M.askFailed(s, a.id));
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
  return results;
};

// ---------- release ----------

// One Resend broadcast per `to: all` message, to the killswitch list. The
// broadcast name makes retries reuse the draft instead of sending twice.
const broadcast = async (env: Env, c: Config, name: string, subject: string, text: string) => {
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`https://api.resend.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${env.resendKey}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`resend ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as any;
  };
  const k = c.killswitch!;
  const existing = ((await api("/broadcasts?limit=100")).data as any[]).find((b) => b.name === name);
  if (existing && existing.status !== "draft") return;
  const draft = existing ?? (await api("/broadcasts", { name, segment_id: k.segmentId, topic_id: k.topicId, from: k.from, subject, text }));
  await api(`/broadcasts/${draft.id}/send`, {});
};

const deliver = async (env: Env, c: Config) => {
  const { results: messages } = await env.db
    .prepare("SELECT id, recipients, iv, ct FROM messages")
    .all<{ id: string; recipients: string; iv: string; ct: string }>();
  let pending = 0;
  for (const m of messages) {
    const body = JSON.parse(await open(env.messageKey, m)) as MessageBody;
    for (const to of JSON.parse(m.recipients) as string[]) {
      const trustee = c.trustees.find((t) => t.id === to);
      // File links are per recipient; a broadcast shares one set.
      const fileSubject = trustee?.id ?? (to === ALL ? ALL : "e" + (await sha256(to)).slice(0, 16));
      const files = await Promise.all(
        body.attachments.map(async (f) => `- ${f.name}: ${await link(env, c, "f", "file", `${fileSubject}.${f.key}`)}`),
      );
      const footer = to === ALL ? `${T.recipient.footer(c.owner.name)}\n${UNSUBSCRIBE}` : T.recipient.footer(c.owner.name);
      const text = [body.body.trim(), files.length ? `${T.recipient.attachments}\n${files.join("\n")}` : "", footer]
        .filter(Boolean)
        .join("\n\n");
      const channels: [string, () => Promise<unknown>][] = [];
      if (to === ALL) {
        if (c.killswitch) channels.push(["broadcast", () => broadcast(env, c, `release:${m.id}`, body.subject, text)]);
      } else {
        const person: Person = trustee ?? { id: to, name: to, email: to };
        channels.push(["email", () => email(env, c, person, body.subject, text, `release:${m.id}:${to}`)]);
        const chat = trustee ? await chatOf(env, trustee.id) : null;
        if (chat !== null) channels.push(["telegram", () => tgSend(env, chat, `${T.recipient.tgCopy(body.subject)}\n\n${text}`)]);
      }
      for (const [channel, send] of channels) {
        const row = await env.db
          .prepare("SELECT sent_at, attempts FROM deliveries WHERE message_id = ? AND person_id = ? AND channel = ?")
          .bind(m.id, to, channel)
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
          .bind(m.id, to, channel, error ? null : Date.now(), error)
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

const UNSUBSCRIBE = "{{{RESEND_UNSUBSCRIBE_URL}}}";

export const tick = async (env: Env, now = Date.now()) => {
  const c = await getConfig(env);
  if (!c) return;
  await resolvePendingPing(env, now);
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
    const ownerChat = person.id === c.owner.id ? null : await chatOf(env, c.owner.id);
    if (ownerChat !== null) await tgSend(env, ownerChat, T.owner.linked(person.name)).catch(() => {});
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
      const s = (await getState(env))?.value;
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
    const state = await getState(env);
    if (state?.value.phase === "released") return json({ error: "already released" }, 409);
    const unknown = body.messages.flatMap((m) => badRecipients(c, m.recipients));
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
    const s = (await getState(env))?.value ?? null;
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
