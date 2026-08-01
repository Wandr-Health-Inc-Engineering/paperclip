// Google Drive writer (Phase 11) — writes agent deliverables into ONE folder
// you control, and nothing else. Uses a Google service account: a service
// account can only touch files/folders explicitly shared with its email, so
// sharing just the "Tethr" folder is the tightest possible scope (the delicate-
// permissions requirement). Same key works locally and on Railway.
//
// Plain node:crypto + fetch — no googleapis SDK. Inert until configured, so it
// never breaks local dev without creds.
//
// Env:
//   TETHR_GDRIVE_SA_KEY       inline service-account JSON, OR
//   TETHR_GDRIVE_SA_KEY_PATH  path to the service-account JSON key file
//   TETHR_GDRIVE_FOLDER_ID    the Drive folder id it may write into (required)

import crypto from "node:crypto";
import fs from "node:fs";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function loadServiceAccount(): ServiceAccount | null {
  const inline = process.env.TETHR_GDRIVE_SA_KEY?.trim();
  const path = process.env.TETHR_GDRIVE_SA_KEY_PATH?.trim();
  let raw: string | undefined;
  if (inline) raw = inline;
  else if (path) {
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as ServiceAccount;
    if (j.client_email && j.private_key) return j;
  } catch {
    /* fall through */
  }
  return null;
}

export function driveFolderId(): string | undefined {
  return process.env.TETHR_GDRIVE_FOLDER_ID?.trim() || undefined;
}

export function googleDriveConfigured(): boolean {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return false; // never write to Drive in tests
  return loadServiceAccount() !== null && Boolean(driveFolderId());
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive.file",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key, "base64url");
  const jwt = `${header}.${claims}.${signature}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`gdrive token exchange failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

export interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
}

/**
 * Create a text/markdown file in the configured Tethr folder. Returns the
 * created file (id + link). Throws if not configured or on API error.
 */
export async function driveCreateFile(
  name: string,
  content: string,
  mimeType = "text/markdown",
): Promise<DriveFile> {
  const sa = loadServiceAccount();
  const folderId = driveFolderId();
  if (!sa || !folderId) throw new Error("Google Drive not configured (SA key + TETHR_GDRIVE_FOLDER_ID)");
  const token = await getAccessToken(sa);
  const boundary = `tethr-${crypto.randomUUID()}`;
  const metadata = { name, parents: [folderId], mimeType };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}; charset=UTF-8\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) throw new Error(`gdrive create failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  return (await res.json()) as DriveFile;
}
