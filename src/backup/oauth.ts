// OAuth 2.0 with PKCE for Google Drive, OneDrive and Dropbox.
// Desktop: the system browser and a one-shot listener on http://localhost:53682/.
// Browser build: a popup that returns to oauth.html on this site.
import { httpFetch, isDesktop, native, openExternal, secrets } from "./env";

export interface OAuthProvider {
  id: "gdrive" | "onedrive" | "dropbox";
  authUrl: string;
  tokenUrl: string;
  scope: string;
  extra: Record<string, string>;
  defaultClientId: string;
  defaultClientSecret: string;
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const OAUTH: Record<OAuthProvider["id"], OAuthProvider> = {
  gdrive: {
    id: "gdrive",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.file",
    extra: { access_type: "offline", prompt: "consent" },
    defaultClientId: env.VITE_GOOGLE_CLIENT_ID ?? "",
    defaultClientSecret: env.VITE_GOOGLE_CLIENT_SECRET ?? "",
  },
  onedrive: {
    id: "onedrive",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite.AppFolder offline_access User.Read",
    extra: { prompt: "select_account" },
    defaultClientId: env.VITE_ONEDRIVE_CLIENT_ID ?? "",
    defaultClientSecret: "",
  },
  dropbox: {
    id: "dropbox",
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scope: "",
    extra: { token_access_type: "offline" },
    defaultClientId: env.VITE_DROPBOX_CLIENT_ID ?? "",
    defaultClientSecret: "",
  },
};

export const LOOPBACK_PORT = 53682;
export const desktopRedirect = `http://localhost:${LOOPBACK_PORT}/`;
export const browserRedirect = () => new URL("oauth.html", location.href).toString();

function b64url(bytes: ArrayBuffer | Uint8Array) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export function credentialsFor(p: OAuthProvider, settings: Record<string, string>): Credentials {
  return { clientId: settings.clientId || p.defaultClientId, clientSecret: settings.clientSecret || p.defaultClientSecret };
}

/** Runs the sign-in flow and stores the tokens for the destination. Returns the account label if known. */
export async function signIn(destId: string, p: OAuthProvider, cred: Credentials): Promise<void> {
  if (!cred.clientId) throw new Error("Add an OAuth client ID for this service first (see “Use your own app” below).");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirect = isDesktop ? desktopRedirect : browserRedirect();
  const params = new URLSearchParams({ client_id: cred.clientId, redirect_uri: redirect, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256", ...p.extra });
  if (p.scope) params.set("scope", p.scope);
  const url = `${p.authUrl}?${params}`;

  let returned: string;
  if (isDesktop) {
    await native("oauth_listen", { port: LOOPBACK_PORT });
    await openExternal(url);
    returned = await native<string>("oauth_wait", { port: LOOPBACK_PORT, timeoutSecs: 300 });
  } else {
    returned = await popup(url);
  }
  const q = new URL(returned, "http://localhost").searchParams;
  if (q.get("error")) throw new Error(`Sign-in was cancelled or refused: ${q.get("error_description") ?? q.get("error")}`);
  if (q.get("state") !== state) throw new Error("Sign-in failed a security check (state mismatch). Try again.");
  const code = q.get("code");
  if (!code) throw new Error("Sign-in did not return an authorization code.");

  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: cred.clientId, code_verifier: verifier });
  if (cred.clientSecret) body.set("client_secret", cred.clientSecret);
  const tok = await tokenRequest(p, body);
  if (!tok.refresh_token) throw new Error("The service did not grant offline access, so scheduled backups could not run later.");
  await secrets.set(destId, "refresh_token", tok.refresh_token);
  await secrets.set(destId, "access_token", tok.access_token);
  await secrets.set(destId, "expires", String(Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000));
}

export async function signOut(destId: string) {
  for (const k of ["refresh_token", "access_token", "expires"]) await secrets.set(destId, k, "");
}

export async function isSignedIn(destId: string) {
  return !!(await secrets.get(destId, "refresh_token"));
}

/** A valid access token, refreshing it when it has expired. */
export async function accessToken(destId: string, p: OAuthProvider, cred: Credentials): Promise<string> {
  const exp = Number(await secrets.get(destId, "expires"));
  const cur = await secrets.get(destId, "access_token");
  if (cur && exp > Date.now()) return cur;
  const refresh = await secrets.get(destId, "refresh_token");
  if (!refresh) throw new Error("Not signed in. Open the destination and sign in again.");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: cred.clientId });
  if (cred.clientSecret) body.set("client_secret", cred.clientSecret);
  if (p.id === "onedrive") body.set("scope", p.scope);
  const tok = await tokenRequest(p, body);
  await secrets.set(destId, "access_token", tok.access_token);
  await secrets.set(destId, "expires", String(Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000));
  if (tok.refresh_token) await secrets.set(destId, "refresh_token", tok.refresh_token);
  return tok.access_token;
}

async function tokenRequest(p: OAuthProvider, body: URLSearchParams) {
  const res = await httpFetch(p.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Sign-in failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  return json as { access_token: string; refresh_token?: string; expires_in?: number };
}

function popup(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = window.open(url, "opl-oauth", "width=520,height=680");
    if (!w) return reject(new Error("The sign-in window was blocked. Allow pop-ups for this site and try again."));
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || typeof e.data !== "object" || e.data?.type !== "opl-oauth") return;
      cleanup();
      resolve(String(e.data.url));
    };
    const timer = setInterval(() => {
      if (w.closed) {
        cleanup();
        reject(new Error("The sign-in window was closed."));
      }
    }, 500);
    const cleanup = () => {
      clearInterval(timer);
      window.removeEventListener("message", onMsg);
    };
    window.addEventListener("message", onMsg);
  });
}
