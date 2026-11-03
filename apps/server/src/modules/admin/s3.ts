/**
 * Minimal S3 client over signed HTTPS (AWS Signature Version 4), for M19-09 backups to a bucket the shop owns
 * (AWS S3 or any S3-compatible store such as Wasabi, Cloudflare R2, MinIO). No SDK: PUT / GET object and
 * ListObjectsV2 are all the backup needs, and the on-prem bundle stays small and offline-installable.
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Settings {
  endpoint?: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean;
}
export interface S3Object { name: string; size: number | null; modifiedAt: string | null }

const sha256hex = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();
/** RFC 3986 encoding as SigV4 wants it ('/' kept in paths). */
const enc = (s: string, keepSlash = false) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, '/') : e;
};

export interface SignInput {
  method: string; host: string; path: string; query?: Record<string, string>; headers?: Record<string, string>;
  payloadHash: string; region: string; accessKeyId: string; secretAccessKey: string; amzDate: string; service?: string;
}

/** Returns the Authorization header value (and the canonical pieces, for tests). */
export function signV4(i: SignInput): { authorization: string; signature: string; canonicalRequest: string } {
  const service = i.service ?? 's3';
  const date = i.amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: i.host, 'x-amz-content-sha256': i.payloadHash, 'x-amz-date': i.amzDate };
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const canonicalQuery = Object.entries(i.query ?? {}).map(([k, v]) => [enc(k), enc(v)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [i.method, enc(i.path, true), canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), i.payloadHash].join('\n');
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`, signature, canonicalRequest };
}

const amzNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export class S3Client {
  constructor(private readonly s: S3Settings, private readonly fetchImpl: typeof fetch = fetch) {}

  private base(): { origin: string; host: string; pathPrefix: string } {
    const ep = (this.s.endpoint?.replace(/\/+$/, '') || `https://s3.${this.s.region}.amazonaws.com`);
    const u = new URL(ep);
    if (this.s.forcePathStyle) return { origin: u.origin, host: u.host, pathPrefix: `/${this.s.bucket}` };
    return { origin: `${u.protocol}//${this.s.bucket}.${u.host}`, host: `${this.s.bucket}.${u.host}`, pathPrefix: '' };
  }

  private async req(method: string, key: string | null, opts: { query?: Record<string, string>; body?: Buffer } = {}): Promise<Response> {
    const b = this.base();
    const path = `${b.pathPrefix}/${key ?? ''}`;
    const payloadHash = sha256hex(opts.body ?? '');
    const amzDate = amzNow();
    const { authorization } = signV4({ method, host: b.host, path, query: opts.query, payloadHash, region: this.s.region, accessKeyId: this.s.accessKeyId, secretAccessKey: this.s.secretAccessKey, amzDate });
    const qs = opts.query ? `?${Object.entries(opts.query).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')}` : '';
    const res = await this.fetchImpl(`${b.origin}${enc(path, true)}${qs}`, {
      method, body: opts.body ? new Uint8Array(opts.body) : undefined, signal: AbortSignal.timeout(120_000),
      headers: { authorization, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(opts.body ? { 'content-type': 'application/octet-stream' } : {}) },
    });
    if (!res.ok) {
      const text = await res.text();
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      throw new Error(`S3 ${method} ${key ?? '(list)'} failed: ${res.status}${code ? ` ${code}` : ''}`);
    }
    return res;
  }

  async put(name: string, body: Buffer): Promise<void> {
    await this.req('PUT', this.s.prefix + name, { body });
  }

  async get(name: string): Promise<Buffer> {
    const res = await this.req('GET', this.s.prefix + name);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Objects under the prefix, newest first (ListObjectsV2, follows continuation tokens). */
  async list(): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: this.s.prefix, ...(token ? { 'continuation-token': token } : {}) };
      const xml = await (await this.req('GET', null, { query })).text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = unxml(/<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1] ?? '');
        out.push({ name: key.slice(this.s.prefix.length), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? NaN) || null, modifiedAt: /<LastModified>([^<]+)<\/LastModified>/.exec(m[1]!)?.[1] ?? null });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || undefined : undefined;
    } while (token);
    return out.filter((o) => o.name).sort((a, b) => (b.modifiedAt ?? b.name).localeCompare(a.modifiedAt ?? a.name));
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
