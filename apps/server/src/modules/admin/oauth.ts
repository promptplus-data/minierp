/**
 * M19-09 Google Drive / OneDrive backup: OAuth 2.0 device authorization grant (RFC 8628). The on-prem machine has
 * no public callback URL, so the owner opens the provider's page on any device, types the short code shown in
 * settings, and this server polls the token endpoint until the account is connected. The refresh token is kept in
 * backup_config.settings (never returned by the API).
 *
 * WIRED: start / poll / token exchange against the provider endpoints below (tested against a local stub).
 * TODO (before release): SCG registers the OAuth apps (Google "TVs and limited input devices" client, Microsoft
 * public client with device code flow enabled) and sets BACKUP_GDRIVE_CLIENT_ID / BACKUP_GDRIVE_CLIENT_SECRET /
 * BACKUP_ONEDRIVE_CLIENT_ID on the installer. Until then the providers report "not configured".
 * TODO (before release): the upload adapters (DriveAdapter / OneDriveAdapter below) are STUBS that refuse to run;
 * they cannot be exercised without real accounts. Their intended API calls are written next to each method.
 */
import { E } from '../../lib/errors';
import type { BackupAdapter } from './backup';
import type { S3Object } from './s3';

export type OauthProviderId = 'gdrive' | 'onedrive';

export interface DeviceFlowProvider {
  id: OauthProviderId;
  label: string;
  clientId: string;
  clientSecret?: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scope: string;
}

/** Endpoints are the providers' real ones; *_DEVICE_URL / *_TOKEN_URL override them (tests, sovereign clouds). */
export function oauthProvider(id: OauthProviderId, env: NodeJS.ProcessEnv = process.env): DeviceFlowProvider | null {
  if (id === 'gdrive') {
    if (!env.BACKUP_GDRIVE_CLIENT_ID) return null;
    return {
      id, label: 'Google Drive', clientId: env.BACKUP_GDRIVE_CLIENT_ID, clientSecret: env.BACKUP_GDRIVE_CLIENT_SECRET || undefined,
      deviceCodeUrl: env.BACKUP_GDRIVE_DEVICE_URL || 'https://oauth2.googleapis.com/device/code',
      tokenUrl: env.BACKUP_GDRIVE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      // drive.file: only files this app created (the backups), not the rest of the owner's Drive
      scope: 'https://www.googleapis.com/auth/drive.file',
    };
  }
  if (!env.BACKUP_ONEDRIVE_CLIENT_ID) return null;
  return {
    id, label: 'OneDrive', clientId: env.BACKUP_ONEDRIVE_CLIENT_ID,
    deviceCodeUrl: env.BACKUP_ONEDRIVE_DEVICE_URL || 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
    tokenUrl: env.BACKUP_ONEDRIVE_TOKEN_URL || 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    // Files.ReadWrite.AppFolder: only the app's own folder (Apps/<app name>)
    scope: 'Files.ReadWrite.AppFolder offline_access',
  };
}

export function requireProvider(id: OauthProviderId, env: NodeJS.ProcessEnv = process.env): DeviceFlowProvider {
  const p = oauthProvider(id, env);
  if (!p) throw E.validation(`${id === 'gdrive' ? 'Google Drive' : 'OneDrive'} backup is not available yet; use an S3 bucket`, { reason: 'OAUTH_NOT_CONFIGURED' });
  return p;
}

export interface DeviceStart { deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }
export type DevicePoll =
  | { status: 'pending' | 'expired' | 'denied' }
  | { status: 'connected'; refreshToken: string; accessToken: string };

const form = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined)).toString();

async function postForm(fetchImpl: typeof fetch, url: string, body: Record<string, string | undefined>): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST', body: form(body), signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    });
  } catch (err) {
    throw E.validation(`Could not reach the sign-in server: ${err instanceof Error ? err.message : String(err)}`, { reason: 'OAUTH_NETWORK' });
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

/** Step 1: ask the provider for a device code and the short code the owner types on the provider's page. */
export async function startDeviceFlow(p: DeviceFlowProvider, fetchImpl: typeof fetch = fetch): Promise<DeviceStart> {
  const { status, json } = await postForm(fetchImpl, p.deviceCodeUrl, { client_id: p.clientId, scope: p.scope });
  const verificationUrl = String(json.verification_uri ?? json.verification_url ?? '');
  if (status !== 200 || typeof json.device_code !== 'string' || typeof json.user_code !== 'string' || !verificationUrl) {
    throw E.validation(`${p.label} refused the sign-in request (${String(json.error ?? status)})`, { reason: 'OAUTH_START_FAILED' });
  }
  return {
    deviceCode: json.device_code, userCode: json.user_code, verificationUrl,
    expiresIn: Number(json.expires_in ?? 900), interval: Math.max(1, Number(json.interval ?? 5)),
  };
}

/** Step 2 (repeated every `interval` seconds): exchange the device code for tokens once the owner has approved. */
export async function pollDeviceFlow(p: DeviceFlowProvider, deviceCode: string, fetchImpl: typeof fetch = fetch): Promise<DevicePoll> {
  const { status, json } = await postForm(fetchImpl, p.tokenUrl, {
    client_id: p.clientId, client_secret: p.clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (status === 200 && typeof json.refresh_token === 'string' && typeof json.access_token === 'string') {
    return { status: 'connected', refreshToken: json.refresh_token, accessToken: json.access_token };
  }
  switch (json.error) {
    case 'authorization_pending':
    case 'slow_down':
      return { status: 'pending' };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
    case 'authorization_declined':
      return { status: 'denied' };
    default:
      throw E.validation(`${p.label} sign-in failed (${String(json.error ?? status)})`, { reason: 'OAUTH_POLL_FAILED' });
  }
}

/** Refresh-token grant, used by the upload adapters before each run. */
export async function accessToken(p: DeviceFlowProvider, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { status, json } = await postForm(fetchImpl, p.tokenUrl, {
    client_id: p.clientId, client_secret: p.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token', scope: p.id === 'onedrive' ? p.scope : undefined,
  });
  if (status !== 200 || typeof json.access_token !== 'string') throw new Error(`${p.label}: the connection expired; connect the account again (${String(json.error ?? status)})`);
  return json.access_token;
}

const notYet = (label: string, what: string) =>
  new Error(`${label} ${what} is not implemented yet (TODO M19-09: needs SCG's registered OAuth app to test); use an S3 bucket`);

/**
 * STUB. Intended calls (Drive v3, scope drive.file):
 *   put:  POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable  {name, parents:[<folder id>]} then PUT the bytes
 *   list: GET  https://www.googleapis.com/drive/v3/files?q='<folder id>' in parents and trashed=false&fields=files(id,name,size,modifiedTime)
 *   get:  GET  https://www.googleapis.com/drive/v3/files/<id>?alt=media
 * The folder ("SCG Shop ERP backups") is created on first put and its id kept in settings.folderId.
 */
export class DriveAdapter implements BackupAdapter {
  constructor(readonly provider: DeviceFlowProvider, readonly settings: Record<string, unknown>) {}
  async put(): Promise<void> { throw notYet('Google Drive', 'upload'); }
  async get(): Promise<Buffer> { throw notYet('Google Drive', 'download'); }
  async list(): Promise<S3Object[]> { throw notYet('Google Drive', 'listing'); }
}

/**
 * STUB. Intended calls (Microsoft Graph, scope Files.ReadWrite.AppFolder):
 *   put:  POST https://graph.microsoft.com/v1.0/me/drive/special/approot:/<name>:/createUploadSession, then PUT 10 MiB chunks
 *   list: GET  https://graph.microsoft.com/v1.0/me/drive/special/approot/children?$select=name,size,lastModifiedDateTime
 *   get:  GET  https://graph.microsoft.com/v1.0/me/drive/special/approot:/<name>:/content
 */
export class OneDriveAdapter implements BackupAdapter {
  constructor(readonly provider: DeviceFlowProvider, readonly settings: Record<string, unknown>) {}
  async put(): Promise<void> { throw notYet('OneDrive', 'upload'); }
  async get(): Promise<Buffer> { throw notYet('OneDrive', 'download'); }
  async list(): Promise<S3Object[]> { throw notYet('OneDrive', 'listing'); }
}
