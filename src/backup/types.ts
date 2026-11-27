// Backup destinations: where copies of labs go, and when.

export type DestinationKind =
  | "folder" // local folder, external drive, or a mounted SMB/NFS share or synced cloud folder
  | "s3" // Amazon S3 and S3-compatible storage (Cloudflare R2, Backblaze B2, MinIO, Wasabi, DigitalOcean Spaces)
  | "gdrive"
  | "onedrive"
  | "dropbox"
  | "webdav" // Nextcloud, ownCloud, Box, Koofr, pCloud, any WebDAV server
  | "sftp"
  | "ftp" // FTP and FTPS
  | "smb" // Windows/Samba share via UNC path or mount point
  | "http" // any endpoint that accepts PUT or POST
  | "rclone"; // any of rclone's 70+ backends, through a local rclone install

export type ScheduleMode = "manual" | "onSave" | "interval" | "daily" | "weekly";

export interface Schedule {
  mode: ScheduleMode;
  /** interval: minutes between runs */
  every?: number;
  /** daily/weekly: local time "HH:MM" */
  at?: string;
  /** weekly: days of the week, 0 = Sunday */
  days?: number[];
}

export type Scope = "current" | "all";

export interface Destination {
  id: string;
  name: string;
  kind: DestinationKind;
  enabled: boolean;
  schedule: Schedule;
  scope: Scope;
  /** Path template inside the destination. Tokens: {name} {date} {time} {datetime} {id} */
  path: string;
  /** Keep this many backups per lab at the destination (0 = keep all). */
  keep: number;
  /** Skip a scheduled run when nothing changed since the last successful one. */
  skipUnchanged: boolean;
  /** Non-secret settings (host, bucket, folder, ...). Secrets live in the secret store. */
  settings: Record<string, string>;
  created: number;
}

export interface RunRecord {
  destination: string;
  time: number;
  ok: boolean;
  message: string;
  files?: string[];
  bytes?: number;
  trigger: "manual" | "schedule" | "save" | "test";
}

export interface StoredFile {
  name: string;
}

/** What a provider must do. Paths are relative to the destination root and use "/". */
export interface Provider {
  put(path: string, data: string): Promise<void>;
  /** Files directly inside a folder (names only). Optional: without it, retention is skipped. */
  list?(folder: string): Promise<StoredFile[]>;
  remove?(path: string): Promise<void>;
  /** Checks the connection and credentials. Returns a short description. */
  test(): Promise<string>;
}

export interface FieldSpec {
  key: string;
  label: string;
  type?: "text" | "password" | "number" | "select" | "textarea" | "folder";
  placeholder?: string;
  options?: [string, string][];
  secret?: boolean;
  optional?: boolean;
  help?: string;
  default?: string;
}

export interface KindInfo {
  kind: DestinationKind;
  label: string;
  description: string;
  fields: FieldSpec[];
  /** Needs the desktop app (native networking or file system). */
  desktopOnly?: boolean;
  /** Signs in with OAuth instead of fields. */
  oauth?: boolean;
}
