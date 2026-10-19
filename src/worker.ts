import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { type Env, fetchHandler, tick } from "./app.ts";
import { Db, Files, Mail } from "./resources.ts";

const props = Effect.gen(function* () {
  const domain = yield* Config.String("POSTHUMAIL_DOMAIN").pipe(Config.withDefault(""));
  return {
    main: import.meta.url,
    compatibility: { date: "2026-10-01" },
    ...(domain && { domain }),
  };
});

export default class Posthumail extends Cloudflare.Worker<Posthumail>()(
  "Posthumail",
  props,
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Db);
    const files = yield* Cloudflare.R2.ReadWriteBucket(Files);
    const mail = yield* Cloudflare.Email.Send(Mail);
    const secrets = {
      telegramToken: yield* Config.Redacted("TELEGRAM_TOKEN"),
      telegramSecret: yield* Config.Redacted("TELEGRAM_WEBHOOK_SECRET"),
      linkSecret: yield* Config.Redacted("LINK_SECRET"),
      messageKey: yield* Config.Redacted("MESSAGE_KEY"),
      adminToken: yield* Config.Redacted("ADMIN_TOKEN"),
      resendKey: yield* Config.Redacted("RESEND_API_KEY"),
    };
    const cron = yield* Config.String("POSTHUMAIL_CRON").pipe(Config.withDefault("0 * * * *"));

    const env = Effect.gen(function* () {
      return {
        db: yield* db.raw,
        files: yield* files.raw,
        mail: yield* mail.raw,
        ...Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, Redacted.value(v)])),
      } as Env;
    });

    yield* Cloudflare.Workers.cron(cron, () =>
      env.pipe(
        Effect.flatMap((e) => Effect.tryPromise(() => tick(e))),
        Effect.tapError((error) => Effect.logError("tick failed", error)),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest).pipe(Effect.orDie);
        const e = yield* env;
        const response = yield* Effect.promise(() =>
          fetchHandler(e, request).catch((error) => {
            console.error(error);
            return new Response("error", { status: 500 });
          }),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    Effect.provide(Cloudflare.R2.ReadWriteBucketBinding),
    Effect.provide(Cloudflare.Email.SendBinding),
  ),
) {}
