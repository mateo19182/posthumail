import * as Cloudflare from "alchemy/Cloudflare";

export const Db = Cloudflare.D1.Database("Db", { migrations: "./migrations" });
export const Files = Cloudflare.R2.Bucket("Files");
export const Mail = Cloudflare.Email.SendEmail("Mail");
