import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PublicClientApplication } from "@azure/msal-node";
import { CLIENT_ID_PATTERN } from "./setup.js";

export const GRAPH_SCOPES = ["Mail.Read"];
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";

export async function ensureTokenCachePath(
  stateDir = process.env.OUTLOOK_STATE_DIR ?? "/var/lib/outlook-mail",
) {
  const resolved = path.resolve(stateDir);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  // mkdir's mode is a hint modified by umask; chmod explicitly to enforce the
  // restrictive permission the sidecar requires.
  await chmod(resolved, 0o700);
  const cachePath = path.join(resolved, "token-cache.json");
  try {
    await readFile(cachePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(cachePath, "", { mode: 0o600 });
  }
  await chmod(cachePath, 0o600);
  return cachePath;
}

export async function createAuthClient({
  clientId = process.env.OUTLOOK_CLIENT_ID,
  stateDir,
  authority = DEFAULT_AUTHORITY,
  PublicClientApplicationImpl = PublicClientApplication,
} = {}) {
  if (!clientId || !CLIENT_ID_PATTERN.test(clientId))
    throw new Error("OUTLOOK_CLIENT_ID is required");
  const cachePath = await ensureTokenCachePath(stateDir);
  const cachePlugin = {
    beforeCacheAccess: async (context) => {
      const serialized = await readFile(cachePath, "utf8");
      if (serialized.trim()) context.tokenCache.deserialize(serialized);
    },
    afterCacheAccess: async (context) => {
      if (context.cacheHasChanged) {
        await writeFile(cachePath, context.tokenCache.serialize(), { mode: 0o600 });
        await chmod(cachePath, 0o600);
      }
    },
  };
  return new PublicClientApplicationImpl({ auth: { clientId, authority }, cache: { cachePlugin } });
}

export async function getAccessToken({ client, scopes = GRAPH_SCOPES, forceRefresh = false } = {}) {
  const accounts = await client.getTokenCache().getAllAccounts();
  const account = accounts[0];
  if (!account) throw new Error("Outlook authentication is required");
  const result = await client.acquireTokenSilent({ account, scopes, forceRefresh });
  if (!result?.accessToken) throw new Error("Outlook authentication is required");
  return result.accessToken;
}
