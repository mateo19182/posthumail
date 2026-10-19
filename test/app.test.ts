import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Env, fetchHandler, tick } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { randomKey, seal, sign } from "../src/crypto.ts";

const DAY = 86_400_000;
// Offsets below are relative to T0; bun treats setSystemTime(0) as a reset.
const T0 = Date.UTC(2030, 0, 1);

// Minimal D1 over bun:sqlite: enough of prepare/bind/first/all/run/batch for app.ts.
const fakeD1 = (sql: Database) => {
  const stmt = (q: string, binds: unknown[] = []) => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async (col?: string) => {
      const row = sql.query(q).get(...(binds as any[])) as Record<string, unknown> | null;
      return row ? (col ? row[col] : row) : null;
    },
    all: async () => ({ results: sql.query(q).all(...(binds as any[])) }),
    run: async () => {
      const r = sql.query(q).run(...(binds as any[]));
      return { meta: { changes: r.changes } };
    },
  });
  return {
    prepare: (q: string) => stmt(q),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      sql.exec("BEGIN");
      for (const s of stmts) await s.run();
      sql.exec("COMMIT");
      return [];
    },
  };
};

const fakeR2 = () => {
  const objects = new Map<string, { data: Uint8Array<ArrayBuffer>; type: string; name: string }>();
  return {
    objects,
    head: async (k: string) => (objects.has(k) ? {} : null),
    put: async (k: string, body: ReadableStream, o: any) => {
      objects.set(k, {
        data: new Uint8Array(await new Response(body).arrayBuffer()),
        type: o.httpMetadata.contentType,
        name: o.customMetadata.name,
      });
    },
    get: async (k: string) => {
      const o = objects.get(k);
      return o
        ? { body: new Response(o.data).body, httpMetadata: { contentType: o.type }, customMetadata: { name: o.name } }
        : null;
    },
  };
};

const config: Config = {
  owner: { id: "me", name: "Mateo", email: "me@x.test" },
  trustees: [
    { id: "ana", name: "Ana", email: "ana@x.test" },
    { id: "luis", name: "Luis", email: "luis@x.test" },
    { id: "eva", name: "Eva", email: "eva@x.test" },
  ],
  recipients: [{ id: "mama", name: "Mamá", email: "mama@x.test" }],
  quorum: 2,
  from: "posthumail@x.test",
  domain: "p.x.test",
  cron: "0 * * * *",
  timing: {
    checkinEvery: "30d",
    grace: "21d",
    remindEvery: "4d",
    trusteeStagger: "3d",
    trusteeReask: "7d",
    cooling: "48h",
    coolingPingEvery: "6h",
    maxPause: "180d",
  },
};

let env: Env;
let mails: { to: string; subject: string; text: string }[];
let tgs: { method: string; body: any }[];
let cfMails: string[];
let resendDown = false;
const chats: Record<string, number> = { me: 1, ana: 2, luis: 3, eva: 4 };
const realFetch = globalThis.fetch;

beforeEach(() => {
  const sql = new Database(":memory:");
  sql.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  mails = [];
  tgs = [];
  cfMails = [];
  resendDown = false;
  env = {
    db: fakeD1(sql) as any,
    files: fakeR2() as any,
    mail: { send: async (m: any) => void cfMails.push(m.to) } as any,
    telegramToken: "t",
    telegramSecret: "tgsecret",
    linkSecret: randomKey(),
    messageKey: randomKey(),
    adminToken: "admin",
    resendKey: "rk",
  };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).startsWith("https://api.resend.com")) {
      if (resendDown) return new Response("down", { status: 500 });
      mails.push({ to: body.to[0], subject: body.subject, text: body.text });
    } else tgs.push({ method: String(url).split("/").pop()!, body });
    return new Response("{}");
  }) as any;
  setSystemTime(new Date(T0));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const call = (path: string, init: RequestInit = {}) => fetchHandler(env, new Request(`https://p.x.test${path}`, init));
const adminCall = (path: string, init: RequestInit = {}) =>
  call(`/admin/${path}`, { ...init, headers: { authorization: "Bearer admin", ...init.headers } });

const setup = async () => {
  await adminCall("files/k1", {
    method: "PUT",
    body: "audio-bytes",
    headers: { "content-type": "audio/mpeg", "x-file-name": "set.mp3" },
  });
  const body = JSON.stringify({ subject: "Para ti", body: "Te quiero.", attachments: [{ key: "k1", name: "set.mp3" }] });
  const messages = [{ id: "m1", recipients: ["mama", "ana"], ...(await seal(env.messageKey, body)) }];
  const r = await adminCall("sync", { method: "POST", body: JSON.stringify({ config, messages }) });
  expect(r.status).toBe(200);
  for (const [id, chat] of Object.entries(chats)) await tgUpdate({ message: { chat: { id: chat }, text: `/start ${await sign(env.linkSecret, "link", id)}` } });
  tgs = [];
};

const tgUpdate = (u: unknown) =>
  call("/tg", { method: "POST", body: JSON.stringify(u), headers: { "x-telegram-bot-api-secret-token": "tgsecret" } });
const press = (person: string, data: string) =>
  tgUpdate({ callback_query: { id: "q", data, message: { chat: { id: chats[person] } } } });

const hours = async (from: number, to: number) => {
  for (let t = from; t <= to; t += 3_600_000) {
    setSystemTime(new Date(T0 + t));
    await tick(env, T0 + t);
  }
};

test("admin requires token", async () => {
  expect((await call("/admin/status")).status).toBe(401);
  expect((await call("/tg", { method: "POST", body: "{}" })).status).toBe(401);
});

test("full flow: ping, grace, staggered trustees, quorum, cooling, release", async () => {
  await setup();
  await hours(0, 30 * DAY);
  expect(mails.map((m) => m.to)).toEqual(["me@x.test"]);
  expect(tgs.at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data).toBe("alive");

  await hours(30 * DAY + 3_600_000, 51 * DAY);
  expect(mails.filter((m) => m.to === "ana@x.test").length).toBe(1);
  expect(mails.filter((m) => m.to === "luis@x.test").length).toBe(0);

  await hours(51 * DAY + 3_600_000, 54 * DAY);
  expect(mails.filter((m) => m.to === "luis@x.test").length).toBe(1);

  await press("ana", "died");
  await press("luis", "died");
  const status = (await (await adminCall("status")).json()) as any;
  expect(status.state.phase).toBe("cooling");

  mails = [];
  await hours(54 * DAY, 54 * DAY + 49 * 3_600_000);
  const toMama = mails.filter((m) => m.to === "mama@x.test");
  expect(toMama.length).toBe(1);
  expect(toMama[0]!.text).toContain("Te quiero.");
  const fileLink = /https:\/\/p\.x\.test(\/f\/\S+)/.exec(toMama[0]!.text)![1]!;
  const file = await call(fileLink);
  expect(await file.text()).toBe("audio-bytes");
  expect(file.headers.get("content-disposition")).toContain("set.mp3");
  // Ana is a trustee and a recipient: email + telegram copy.
  expect(mails.filter((m) => m.to === "ana@x.test" && m.subject === "Para ti").length).toBe(1);
  expect(tgs.some((t) => t.body.chat_id === chats.ana && t.body.text.includes("Te quiero."))).toBe(true);

  // Idempotent: more ticks send nothing new.
  const before = mails.length;
  await hours(56 * DAY, 57 * DAY);
  expect(mails.length).toBe(before);
});

test("owner check-in via email link cancels and notifies asked trustees", async () => {
  await setup();
  await hours(0, 52 * DAY);
  await press("ana", "died");
  const ping = mails.filter((m) => m.to === "me@x.test").at(-1)!;
  const path = /https:\/\/p\.x\.test(\/c\/\S+)/.exec(ping.text)![1]!;
  expect(((await (await adminCall("status")).json()) as any).state.phase).toBe("asking");
  expect(await (await call(path)).text()).toContain("Hecho");
  expect(((await (await adminCall("status")).json()) as any).state.phase).toBe("alive");
  expect(tgs.some((t) => t.body.chat_id === chats.ana && t.body.text.includes("Falsa alarma"))).toBe(true);
});

test("trustee email link: fine resets", async () => {
  await setup();
  await hours(0, 52 * DAY);
  const ask = mails.find((m) => m.to === "ana@x.test")!;
  const path = /https:\/\/p\.x\.test(\/t\/\S+)/.exec(ask.text)![1]!;
  const form = new FormData();
  form.set("action", "fine");
  const r = await call(path, { method: "POST", body: form });
  expect(await r.text()).toContain("Se reinicia");
  expect(((await (await adminCall("status")).json()) as any).state.phase).toBe("alive");
});

test("forged links and strangers are rejected", async () => {
  await setup();
  expect((await call(`/c/${"x".repeat(22)}me`)).status).toBe(404);
  const anaLink = await sign(env.linkSecret, "trustee", "ana");
  expect((await call(`/c/${anaLink}`)).status).toBe(404);
  await tgUpdate({ message: { chat: { id: 99 }, text: "/start garbage" } });
  expect(tgs.at(-1)!.body.text).toContain("No te conozco");
  await press("mama", "died");
  await press("ana", "died");
  expect(((await (await adminCall("status")).json()) as any).state.confirmed).toEqual({});
});

test("pause via telegram", async () => {
  await setup();
  await tgUpdate({ message: { chat: { id: chats.me }, text: "/pause 60d" } });
  expect(tgs.at(-1)!.body.text).toContain("Pausado");
  await hours(0, 59 * DAY);
  expect(mails.length).toBe(0);
});

test("falls back to Cloudflare for owner and trustees only, retries recipients", async () => {
  await setup();
  resendDown = true;
  await hours(0, 30 * DAY);
  expect(cfMails).toEqual(["me@x.test"]);
  await hours(30 * DAY + 3_600_000, 52 * DAY);
  await press("ana", "died");
  await press("luis", "died");
  await hours(52 * DAY, 52 * DAY + 49 * 3_600_000);
  const status = (await (await adminCall("status")).json()) as any;
  const mama = status.deliveries.find((d: any) => d.person_id === "mama");
  expect(mama.sent_at).toBeNull();
  expect(mama.error).toContain("resend");
  resendDown = false;
  await hours(52 * DAY + 50 * 3_600_000, 52 * DAY + 50 * 3_600_000);
  expect(mails.filter((m) => m.to === "mama@x.test").length).toBe(1);
  expect(cfMails).toContain("ana@x.test");
});

test("quarterly update reminder: once at quarter start, again after 2 weeks, stops when sent", async () => {
  const withUpdates = { ...config, updates: { segmentId: "seg", from: "m@x.test", remind: true } };
  await adminCall("sync", { method: "POST", body: JSON.stringify({ config: withUpdates, messages: [] }) });
  const reminders = () => mails.filter((m) => m.subject.includes("actualización")).length;
  await hours(0, 13 * DAY);
  expect(reminders()).toBe(1);
  await hours(14 * DAY, 40 * DAY);
  expect(reminders()).toBe(2);
  await hours(91 * DAY, 91 * DAY);
  expect(reminders()).toBe(3);
  await adminCall("update-sent", { method: "POST", body: JSON.stringify({ quarter: "2030-q2" }) });
  await hours(106 * DAY, 106 * DAY);
  expect(reminders()).toBe(3);
});
