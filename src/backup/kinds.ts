import type { Destination, DestinationKind, FieldSpec, KindInfo, Provider } from "./types";
import { secrets } from "./env";
import { s3Provider } from "./providers/s3";
import { webdavProvider } from "./providers/webdav";
import { httpProvider } from "./providers/http";
import { dropboxProvider, gdriveProvider, onedriveProvider } from "./providers/cloud";
import { folderProvider, ftpProvider, rcloneProvider, sftpProvider } from "./providers/native";

const oauthApp = (consoleName: string, redirectNote: string): FieldSpec[] => [
  { key: "folder", label: "Folder", placeholder: "OpenPacketLab Backups", optional: true },
  { key: "clientId", label: "Client ID", optional: true, help: `Use your own app: create one in the ${consoleName} and paste its client ID. ${redirectNote}` },
];

export const KINDS: KindInfo[] = [
  {
    kind: "folder",
    label: "Folder or Drive",
    description: "A folder on this computer, an external drive, or a synced folder (iCloud Drive, Dropbox, OneDrive, Google Drive, Syncthing).",
    fields: [{ key: "path", label: "Folder", type: "folder", placeholder: "/Users/you/Backups" }],
  },
  {
    kind: "s3",
    label: "Amazon S3 or Compatible",
    description: "AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, DigitalOcean Spaces, and other S3 APIs.",
    fields: [
      { key: "endpoint", label: "Endpoint", placeholder: "https://s3.amazonaws.com", optional: true, help: "Leave empty for AWS. For R2: https://<account>.r2.cloudflarestorage.com" },
      { key: "region", label: "Region", placeholder: "us-east-1", default: "us-east-1" },
      { key: "bucket", label: "Bucket" },
      { key: "prefix", label: "Folder in bucket", placeholder: "openpacketlab/", optional: true },
      { key: "accessKey", label: "Access key ID" },
      { key: "secretKey", label: "Secret access key", type: "password", secret: true },
      { key: "pathStyle", label: "Addressing", type: "select", options: [["false", "Virtual-hosted (AWS)"], ["true", "Path-style (MinIO, most self-hosted)"]], default: "false" },
    ],
  },
  { kind: "gdrive", label: "Google Drive", description: "Backups go to a folder in your Drive. OpenPacketLab can only see files it created.", oauth: true, fields: oauthApp("Google Cloud console (OAuth client type “Desktop app”)", "Also paste the client secret Google shows.").concat([{ key: "clientSecret", label: "Client secret", optional: true }]) },
  { kind: "onedrive", label: "OneDrive", description: "Personal, work or school OneDrive. Backups go to Apps/OpenPacketLab.", oauth: true, fields: oauthApp("Microsoft Entra admin center (platform “Mobile and desktop”, redirect http://localhost)", "") },
  { kind: "dropbox", label: "Dropbox", description: "Backups go to a folder in your Dropbox.", oauth: true, fields: oauthApp("Dropbox App Console", "Add the redirect URI http://localhost:53682/.") },
  {
    kind: "webdav",
    label: "WebDAV",
    description: "Nextcloud, ownCloud, Box, Koofr, pCloud, Synology, QNAP, or any WebDAV server.",
    fields: [
      { key: "url", label: "Server URL", placeholder: "https://cloud.example.com/remote.php/dav/files/you" },
      { key: "folder", label: "Folder", placeholder: "OpenPacketLab", optional: true },
      { key: "username", label: "User name", optional: true },
      { key: "password", label: "Password or app password", type: "password", secret: true, optional: true },
    ],
  },
  {
    kind: "sftp",
    label: "SFTP (SSH)",
    description: "Any server you can reach over SSH: a NAS, a VPS, a Raspberry Pi.",
    desktopOnly: true,
    fields: [
      { key: "host", label: "Host" },
      { key: "port", label: "Port", type: "number", default: "22" },
      { key: "username", label: "User name" },
      { key: "password", label: "Password", type: "password", secret: true, optional: true },
      { key: "privateKey", label: "Private key", type: "textarea", secret: true, optional: true, placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----", help: "Paste a key instead of using a password." },
      { key: "passphrase", label: "Key passphrase", type: "password", secret: true, optional: true },
      { key: "folder", label: "Remote folder", placeholder: "backups/openpacketlab", optional: true },
    ],
  },
  {
    kind: "ftp",
    label: "FTP or FTPS",
    description: "Classic FTP servers, with TLS encryption when the server supports it.",
    desktopOnly: true,
    fields: [
      { key: "host", label: "Host" },
      { key: "security", label: "Encryption", type: "select", options: [["explicit", "FTPS (explicit TLS)"], ["implicit", "FTPS (implicit TLS, port 990)"], ["none", "None (plain FTP)"]], default: "explicit" },
      { key: "port", label: "Port", type: "number", optional: true, placeholder: "21" },
      { key: "username", label: "User name", optional: true, placeholder: "anonymous" },
      { key: "password", label: "Password", type: "password", secret: true, optional: true },
      { key: "folder", label: "Remote folder", optional: true },
    ],
  },
  {
    kind: "smb",
    label: "Network Share (SMB)",
    description: "A Windows or Samba share, NAS or NFS export. Use a UNC path on Windows or the mount point on macOS and Linux.",
    desktopOnly: true,
    fields: [{ key: "path", label: "Share path", type: "folder", placeholder: "\\\\nas\\backups or /Volumes/backups" }],
  },
  {
    kind: "http",
    label: "HTTP Endpoint",
    description: "Upload to your own server or a webhook with PUT or POST.",
    fields: [
      { key: "url", label: "URL", placeholder: "https://example.com/backups/{path}" },
      { key: "method", label: "Method", type: "select", options: [["PUT", "PUT"], ["POST", "POST"]], default: "PUT" },
      { key: "token", label: "Bearer token", type: "password", secret: true, optional: true },
      { key: "headers", label: "Extra headers", type: "textarea", optional: true, placeholder: "X-Api-Key: ..." },
    ],
  },
  {
    kind: "rclone",
    label: "rclone",
    description: "Any of rclone's 70+ backends (Box, MEGA, pCloud, Proton Drive, Azure Blob, Google Cloud Storage, iCloud, and more) through rclone on this computer.",
    desktopOnly: true,
    fields: [
      { key: "remote", label: "Remote and path", placeholder: "mybox:OpenPacketLab", help: "Set up the remote first with “rclone config”." },
      { key: "binary", label: "rclone command", optional: true, placeholder: "rclone" },
    ],
  },
];

export const kindInfo = (k: DestinationKind) => KINDS.find((x) => x.kind === k)!;

/** Settings with secrets filled in from the secret store. */
export async function resolvedSettings(d: Destination): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of kindInfo(d.kind).fields) out[f.key] = f.secret ? await secrets.get(d.id, f.key) : (d.settings[f.key] ?? f.default ?? "");
  for (const [k, v] of Object.entries(d.settings)) if (!(k in out)) out[k] = v;
  return out;
}

export async function providerFor(d: Destination, hooks: { onFingerprint?: (fp: string) => void } = {}): Promise<Provider> {
  const s = await resolvedSettings(d);
  switch (d.kind) {
    case "folder":
    case "smb":
      return folderProvider(s.path || d.id);
    case "s3":
      return s3Provider({ endpoint: s.endpoint, region: s.region, bucket: s.bucket, prefix: s.prefix, accessKey: s.accessKey, secretKey: s.secretKey, pathStyle: s.pathStyle === "true" });
    case "webdav":
      return webdavProvider({ url: s.url, folder: s.folder, username: s.username, password: s.password });
    case "http":
      return httpProvider({ url: s.url, method: s.method, headers: s.headers, token: s.token });
    case "gdrive":
      return gdriveProvider(d.id, s);
    case "onedrive":
      return onedriveProvider(d.id, s);
    case "dropbox":
      return dropboxProvider(d.id, s);
    case "sftp":
      return sftpProvider({ host: s.host, port: s.port, username: s.username, password: s.password, privateKey: s.privateKey, passphrase: s.passphrase, folder: s.folder, fingerprint: s.fingerprint }, hooks.onFingerprint);
    case "ftp":
      return ftpProvider({ host: s.host, port: s.port, username: s.username, password: s.password, folder: s.folder, security: s.security });
    case "rclone":
      return rcloneProvider(s.remote, s.binary);
  }
}
