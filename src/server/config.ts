import { env } from "node:process";
import { DEFAULT_DB_PATH } from "../lib/raw.js";
import type { AuthConfig } from "./app.js";

/**
 * Server configuration from environment variables (see docs/deploy-gcp.md).
 *
 *   PORT                    listen port (Cloud Run sets it)              default 8787
 *   DM_DB_PATH              local SQLite file                             default data/dm.sqlite
 *   DM_DATA_STORE           gs://bucket/prefix (or a local dir) holding the published dm.sqlite;
 *                           downloaded at startup and re-checked periodically
 *   DM_DB_REFRESH_SECONDS   how often to check the store for a newer DB  default 600 (0 = never)
 *   DM_AUTH_USER / DM_AUTH_PASSWORD   Basic auth for the UI and API
 *   DM_API_TOKEN            Bearer token for the API and /mcp
 *   DM_PUBLIC=1             allow access without any credentials
 */
export interface ServerConfig {
  port: number;
  dbPath: string;
  dataStore: string | null;
  refreshSeconds: number;
  auth: AuthConfig;
}

export class ConfigError extends Error {}

export function loadConfig(vars: Record<string, string | undefined> = env, args: string[] = []): ServerConfig {
  const arg = (name: string) =>
    args
      .find((a) => a.startsWith(`--${name}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  const auth: AuthConfig = {};
  if (vars.DM_AUTH_USER || vars.DM_AUTH_PASSWORD) {
    if (!vars.DM_AUTH_USER || !vars.DM_AUTH_PASSWORD) throw new ConfigError("DM_AUTH_USER and DM_AUTH_PASSWORD must be set together");
    if (vars.DM_AUTH_PASSWORD.length < 12) throw new ConfigError("DM_AUTH_PASSWORD must be at least 12 characters");
    auth.basic = { user: vars.DM_AUTH_USER, password: vars.DM_AUTH_PASSWORD };
  }
  if (vars.DM_API_TOKEN) {
    if (vars.DM_API_TOKEN.length < 24) throw new ConfigError("DM_API_TOKEN must be at least 24 characters");
    auth.token = vars.DM_API_TOKEN;
  }
  const hasCredentials = !!(auth.basic || auth.token);
  if (vars.DM_PUBLIC === "1") auth.public = true;
  else if (!hasCredentials) {
    // On Cloud Run (K_SERVICE is set) refuse to serve the card data openly by accident.
    if (vars.K_SERVICE) throw new ConfigError("no credentials configured: set DM_AUTH_USER/DM_AUTH_PASSWORD and/or DM_API_TOKEN, or DM_PUBLIC=1");
    auth.public = true; // local development
  }
  return {
    port: Number(arg("port") ?? vars.PORT ?? 8787),
    dbPath: arg("db") ?? vars.DM_DB_PATH ?? DEFAULT_DB_PATH,
    dataStore: arg("store") ?? vars.DM_DATA_STORE ?? null,
    refreshSeconds: Number(vars.DM_DB_REFRESH_SECONDS ?? 600),
    auth,
  };
}
