/**
 * The one fetch wrapper: attaches the JWT, parses success bodies with the @erp/contracts zod schemas,
 * and turns every non-2xx into an ApiFail carrying the contract's error code plus a Thai message.
 */
import { ApiError } from '@erp/contracts';
import type { ZodType, ZodTypeDef } from 'zod';

export type ErrorCode = ApiError['code'] | 'NETWORK';

const TOKEN_KEY = 'erp-token';
let token: string | null = readToken();

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null): void {
  token = t;
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode / blocked storage: keep the token in memory only
  }
}
export const getToken = () => token;

/** Called when the server says the session is gone (expired token, user resigned). */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

const THAI: Record<ErrorCode, string> = {
  VALIDATION: 'ข้อมูลไม่ถูกต้อง ตรวจสอบแล้วลองอีกครั้ง',
  UNAUTHORIZED: 'กรุณาเข้าสู่ระบบใหม่',
  FORBIDDEN: 'บทบาทนี้ทำรายการนี้ไม่ได้',
  NOT_FOUND: 'ไม่พบข้อมูล',
  CONFLICT: 'ข้อมูลขัดแย้งกับรายการที่มีอยู่',
  BELOW_COST: 'ขายต่ำกว่าต้นทุน ต้องให้เจ้าของร้านอนุมัติ',
  INSUFFICIENT_STOCK: 'สต็อกไม่พอ ระบบไม่ให้สต็อกติดลบ (BR-07)',
  SHIFT_REQUIRED: 'ต้องเปิดกะของคุณก่อน จึงขายหรือคืนเงินสดได้',
  NOT_AVAILABLE_IN_EDITION: 'ฟีเจอร์นี้ไม่มีใน edition นี้',
  DOWNSTREAM_FIRST: 'มีเอกสารอ้างอิงบิลนี้แล้ว (เช่น ใบลดหนี้) ให้จัดการเอกสารนั้นก่อน',
  INTERNAL: 'ระบบขัดข้อง ลองใหม่อีกครั้ง',
  NETWORK: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบเครือข่ายแล้วลองใหม่',
};

const LOGIN_REASON: Record<string, string> = {
  BAD_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  LOCKED: 'บัญชีถูกล็อกเพราะใส่รหัสผิด 5 ครั้ง ให้เจ้าของร้านปลดล็อกให้',
  RESIGNED: 'ผู้ใช้นี้ลาออกแล้ว เข้าระบบไม่ได้',
  TENANT_REQUIRED: 'ชื่อผู้ใช้นี้มีในหลายร้าน ต้องระบุรหัสร้าน',
};

const APPROVAL_REASON: Record<string, string> = {
  BAD_PIN: 'PIN ไม่ถูกต้อง',
  ROLE_NOT_ALLOWED: 'ผู้อนุมัติคนนี้ไม่มีสิทธิ์อนุมัติรายการนี้',
  NOT_FOUND: 'ไม่พบผู้อนุมัติ หรือผู้อนุมัติไม่ได้ใช้งานแล้ว',
};

export class ApiFail extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly serverMessage: string,
    readonly details: unknown,
  ) {
    super(thaiMessage(code, details, serverMessage));
    this.name = 'ApiFail';
  }
  /** details.<key> when details is an object. */
  detail<T = unknown>(key: string): T | undefined {
    return this.details && typeof this.details === 'object' ? ((this.details as Record<string, unknown>)[key] as T) : undefined;
  }
}

function thaiMessage(code: ErrorCode, details: unknown, serverMessage: string): string {
  const d = details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
  if (code === 'UNAUTHORIZED' && typeof d.reason === 'string' && LOGIN_REASON[d.reason]) return LOGIN_REASON[d.reason]!;
  if (typeof d.approvalError === 'string' && APPROVAL_REASON[d.approvalError]) return APPROVAL_REASON[d.approvalError]!;
  if (code === 'VALIDATION' || code === 'CONFLICT') return `${THAI[code]} (${serverMessage})`;
  return THAI[code];
}

type Query = Record<string, string | number | boolean | null | undefined>;
interface Opts<T> { body?: unknown; query?: Query; schema?: ZodType<T, ZodTypeDef, unknown> }

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, opts: Opts<T> = {}): Promise<T> {
  const qs = opts.query
    ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path + (qs ? `?${qs}` : ''), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch (err) {
    throw new ApiFail(0, 'NETWORK', String(err), null);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = ApiError.safeParse(json);
    const fail = e.success ? new ApiFail(res.status, e.data.code, e.data.message, e.data.details) : new ApiFail(res.status, 'INTERNAL', text.slice(0, 200), null);
    if (fail.code === 'UNAUTHORIZED' && token && !path.endsWith('/auth/login')) onUnauthorized();
    throw fail;
  }
  if (!opts.schema) return json as T;
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    console.error('Response does not match the contract', path, parsed.error.issues);
    throw new ApiFail(res.status, 'INTERNAL', 'Response does not match the contract', parsed.error.issues);
  }
  return parsed.data;
}

export const errText = (e: unknown): string => (e instanceof ApiFail ? e.message : e instanceof Error ? e.message : String(e));
