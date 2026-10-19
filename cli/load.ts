import { resolve } from "node:path";
import { type Config, validate } from "../src/config.ts";

export const configPath = () => resolve(process.env.POSTHUMAIL_CONFIG ?? "posthumail.config.ts");

export const loadConfig = async (): Promise<Config> =>
  validate((await import(configPath())).default as Config);
