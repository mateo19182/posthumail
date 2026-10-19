#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MessageBody, StoredMessage } from "../src/app.ts";
import { people, type Config } from "../src/config.ts";
import { randomKey, seal, sha256, sign } from "../src/crypto.ts";
import { loadConfig } from "./load.ts";

const SECRETS = ["LINK_SECRET", "MESSAGE_KEY", "ADMIN_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] as const;

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
};

const baseUrl = (c: Config) => process.env.POSTHUMAIL_URL ?? `https://${c.domain}`;

const admin = async (c: Config, path: string, init: RequestInit = {}) => {
  const res = await fetch(`${baseUrl(c)}/admin/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${need("ADMIN_TOKEN")}`, ...init.headers },
  });
  if (!res.ok && init.method !== "HEAD") throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res;
};

const telegram = async (method: string, body: unknown = {}) => {
  const res = await fetch(`https://api.telegram.org/bot${need("TELEGRAM_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: any; description?: string };
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
};

// Secrets are generated locally and never printed.
const init = () => {
  const missing = SECRETS.filter((k) => !process.env[k]);
  if (missing.length) appendFileSync(".env", `\n${missing.map((k) => `${k}=${randomKey()}`).join("\n")}\n`);
  console.log(missing.length ? `added to .env: ${missing.join(", ")}` : "all secrets already set");
  if (!process.env.TELEGRAM_TOKEN) console.log("still missing: TELEGRAM_TOKEN");
};

const deploy = async (c: Config, args: string[]) => {
  // Alchemy's bundler needs a newer util.styleText than Bun 1.1 ships, so run its CLI on Node.
  const proc = Bun.spawn(["node", "node_modules/alchemy/bin/alchemy.js", "deploy", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, POSTHUMAIL_DOMAIN: c.domain, POSTHUMAIL_CRON: c.cron },
  });
  process.exit(await proc.exited);
};

const mime: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const readMessage = (file: string) => {
  const raw = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const meta = parseYaml(m[1]!) as { to: string | string[]; subject: string; attachments?: string[] };
  if (!meta.to || !meta.subject) throw new Error(`${file}: frontmatter needs 'to' and 'subject'`);
  return {
    id: basename(file, ".md"),
    to: [meta.to].flat(),
    subject: meta.subject,
    body: m[2]!,
    attachments: (meta.attachments ?? []).map((a) => resolve(dirname(file), a)),
  };
};

const sync = async (c: Config) => {
  const dir = resolve(process.env.POSTHUMAIL_MESSAGES ?? "messages");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const ids = new Set(people(c).map((p) => p.id));
  const messages: StoredMessage[] = [];
  for (const f of files) {
    const msg = readMessage(join(dir, f));
    const unknown = msg.to.filter((r) => !ids.has(r) || r === c.owner.id);
    if (unknown.length) throw new Error(`${f}: unknown recipients ${unknown.join(", ")}`);
    const attachments = [];
    for (const path of msg.attachments) {
      if (!existsSync(path)) throw new Error(`${f}: attachment not found: ${path}`);
      const data = new Uint8Array(readFileSync(path));
      const key = await sha256(data);
      const name = basename(path);
      if ((await admin(c, `files/${key}`, { method: "HEAD" })).status !== 200) {
        console.log(`  uploading ${name} (${(data.length / 1e6).toFixed(1)} MB)`);
        await admin(c, `files/${key}`, {
          method: "PUT",
          body: data,
          headers: {
            "content-type": mime[extname(path).toLowerCase()] ?? "application/octet-stream",
            "x-file-name": encodeURIComponent(name),
          },
        });
      }
      attachments.push({ key, name });
    }
    const body: MessageBody = { subject: msg.subject, body: msg.body, attachments };
    messages.push({ id: msg.id, recipients: msg.to, ...(await seal(need("MESSAGE_KEY"), JSON.stringify(body))) });
    console.log(`  ${msg.id} → ${msg.to.join(", ")}${attachments.length ? ` (+${attachments.length} files)` : ""}`);
  }
  const res = await admin(c, "sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: c, messages }),
  });
  console.log(await res.json());
};

const invites = async (c: Config) => {
  const bot = await telegram("getMe");
  for (const p of people(c)) {
    const role = p.id === c.owner.id ? "owner" : c.trustees.includes(p) ? "trustee" : "recipient";
    console.log(`${p.name} (${role}): https://t.me/${bot.username}?start=${await sign(need("LINK_SECRET"), "link", p.id)}`);
  }
};

const webhook = async (c: Config) => {
  await telegram("setWebhook", {
    url: `${baseUrl(c)}/tg`,
    secret_token: need("TELEGRAM_WEBHOOK_SECRET"),
    allowed_updates: ["message", "callback_query"],
  });
  await telegram("setMyCommands", {
    commands: [
      { command: "alive", description: "Confirmar que sigues por aquí" },
      { command: "pause", description: "Pausar, p. ej. /pause 60d" },
      { command: "resume", description: "Quitar la pausa" },
      { command: "status", description: "Estado actual" },
    ],
  });
  console.log(`webhook set to ${baseUrl(c)}/tg`);
};

const status = async (c: Config) => {
  const s = (await (await admin(c, "status")).json()) as any;
  console.log(s.summary ?? "no state yet (run sync)");
  console.log(`messages: ${s.messages}`);
  const linked = new Set(s.chats.map((x: any) => x.person_id));
  for (const p of people(c)) console.log(`  ${linked.has(p.id) ? "✓" : "·"} telegram ${p.id}`);
  if (s.deliveries.length) console.table(s.deliveries);
  if (process.argv.includes("--events")) console.table(s.events);
};

const resendApi = async (path: string, body?: unknown) => {
  const res = await fetch(`https://api.resend.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${need("RESEND_API_KEY")}`, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`resend ${path}: ${res.status} ${data.message ?? ""}`);
  return data;
};

// The short public version goes to the blog repo, which lists it on the Now page.
const publishToBlog = (name: string, subject: string, blog: string) => {
  const repo = resolve(process.env.POSTHUMAIL_BLOG ?? join(process.env.HOME!, "projects/blog-19182"));
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  if (git("status", "--porcelain").trim()) throw new Error(`${repo} has uncommitted changes; publish skipped`);
  git("pull", "--ff-only", "-q");
  const q = /^(\d{4})-q([1-4])$/.exec(name);
  const title = q ? `Q${q[2]} ${q[1]}` : subject;
  const path = `content/updates/${name}.md`;
  mkdirSync(join(repo, "content/updates"), { recursive: true });
  writeFileSync(join(repo, path), `---\ntitle: ${title}\ndate: ${new Date().toISOString().slice(0, 10)}\n---\n${blog.trim()}\n`);
  git("add", path);
  git("commit", "-q", "-m", `Quarterly update ${title}`);
  git("push", "-q");
  console.log(`published ${path}`);
};

const UNSUBSCRIBE = "{{{RESEND_UNSUBSCRIBE_URL}}}";

// Quarterly update: plain-text Resend broadcast to the configured segment.
// `--test` sends it only to the owner. Re-running reuses the draft and never sends twice.
const update = async (c: Config, [sub, name]: string[]) => {
  if (sub !== "send" || !name) throw new Error("usage: posthumail update send <name> [--test]");
  if (!c.updates) throw new Error("config has no `updates` section");
  const file = join(resolve(process.env.POSTHUMAIL_UPDATES ?? "updates"), `${name}.md`);
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const { subject, blog } = parseYaml(m[1]!) as { subject?: string; blog?: string };
  if (!subject) throw new Error(`${file}: frontmatter needs 'subject'`);
  const text = `${m[2]!.trim()}\n\n--\nUnsubscribe / Darse de baja: ${UNSUBSCRIBE}`;
  const from = c.updates.from;

  if (process.argv.includes("--test")) {
    await resendApi("/emails", { from, to: [c.owner.email], subject: `[test] ${subject}`, text: text.replace(UNSUBSCRIBE, "(link)") });
    console.log(`test sent to ${c.owner.email}`);
    return;
  }

  const broadcastName = `update:${name}`;
  const existing = ((await resendApi("/broadcasts?limit=100")).data as any[]).find(
    (b) => b.name === broadcastName && b.segment_id === c.updates!.segmentId,
  );
  if (existing && existing.status !== "draft") throw new Error(`${broadcastName} already ${existing.status}`);
  const contacts = (await resendApi(`/contacts?segment_id=${c.updates.segmentId}&limit=100`)).data as any[];
  const n = contacts.filter((x) => !x.unsubscribed).length;
  console.log(`From: ${from}\nSubject: ${subject}\n\n${text}\n`);
  if (blog) console.log(`Blog (Now page):\n${blog.trim()}\n`);
  const question = `Send to ${n} subscribed contacts${blog ? " and publish to the blog" : ""}? [y/N]`;
  if (prompt(question)?.trim().toLowerCase() !== "y") return console.log("cancelled");
  const draft =
    existing ?? (await resendApi("/broadcasts", { name: broadcastName, segment_id: c.updates.segmentId, from, reply_to: c.owner.email, subject, text }));
  await resendApi(`/broadcasts/${draft.id}/send`, {});
  console.log(`sent ${broadcastName}`);
  if (blog) publishToBlog(name, subject, blog);
  if (/^\d{4}-q[1-4]$/.test(name)) await admin(c, "update-sent", { method: "POST", body: JSON.stringify({ quarter: name }) });
};

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "init") init();
else {
  const c = await loadConfig();
  const commands: Record<string, () => Promise<unknown>> = {
    deploy: () => deploy(c, args),
    sync: () => sync(c),
    invites: () => invites(c),
    webhook: () => webhook(c),
    status: () => status(c),
    update: () => update(c, args),
    tick: async () => console.log(await (await admin(c, "tick", { method: "POST" })).json()),
  };
  const run = commands[cmd ?? ""];
  if (!run) {
    console.log("usage: posthumail <init|deploy|sync|invites|webhook|status|update|tick>");
    process.exit(1);
  }
  await run();
}
