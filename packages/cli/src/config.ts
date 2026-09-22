import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface YakjevClientConfig {
  readonly remoteUrl: string | undefined;
  readonly ownerToken: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const asClientConfig = (value: unknown): YakjevClientConfig => {
  if (!isRecord(value)) return { remoteUrl: undefined, ownerToken: undefined };
  return {
    remoteUrl: asString(value.remoteUrl),
    ownerToken: asString(value.ownerToken),
  };
};

export const defaultClientConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string =>
  resolve(
    env.YAKJEV_CONFIG ?? join(homedir(), ".config", "yakjev", "config.json"),
  );

export const loadClientConfig = (
  path = defaultClientConfigPath(),
): YakjevClientConfig | undefined => {
  if (!existsSync(path)) return undefined;
  return asClientConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
};

export const configuredRemoteUrl = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const explicit = asString(env.YAKJEV_REMOTE_URL) ?? asString(env.YAKJEV_URL);
  if (explicit !== undefined) return explicit.replace(/\/+$/, "");
  const config = loadClientConfig(defaultClientConfigPath(env));
  return config?.remoteUrl?.replace(/\/+$/, "");
};

export const configuredOwnerToken = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const explicit = asString(env.YAKJEV_OWNER_TOKEN);
  if (explicit !== undefined) return explicit;
  const config = loadClientConfig(defaultClientConfigPath(env));
  return config?.ownerToken;
};
