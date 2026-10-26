/**
 * Prompt Plus adapter — CLOUD EDITION ONLY. This file is replaced by an empty module in the on-prem bundle
 * (apps/server/build.lib.mjs) and every call site sits inside `if (process.env.EDITION === 'cloud')`.
 * Thin HTTP client: the real Prompt Plus endpoints are not known yet, so paths below are placeholders.
 */
export function promptPlusCapabilities(): { promptPlusOrders: boolean; promptPlusSso: boolean } {
  return { promptPlusOrders: true, promptPlusSso: true };
}

export interface PromptPlusIncomingOrder { id: string; deliveryNo: string; vendorId: string | null; lines: { sku: string; qty: string }[] }

export class PromptPlusClient {
  constructor(
    private readonly baseUrl = process.env.PROMPTPLUS_BASE_URL ?? '',
    private readonly clientId = process.env.PROMPTPLUS_CLIENT_ID ?? '',
    private readonly timeoutMs = 5000,
  ) {}

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: { 'content-type': 'application/json', 'x-client-id': this.clientId, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Prompt Plus ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** TODO: real endpoint. Incoming deliveries to confirm as goods receipts (REQ-M05-01/02). */
  incoming(tenantCode: string): Promise<PromptPlusIncomingOrder[]> {
    return this.call(`/v1/shops/${encodeURIComponent(tenantCode)}/incoming`);
  }

  /** TODO: real endpoint. Places an order upstream from one of our documents (REQ-M05-05). */
  createOrder(tenantCode: string, payload: { docNo: string; lines: { sku: string; qty: string }[] }): Promise<{ orderId: string }> {
    return this.call(`/v1/shops/${encodeURIComponent(tenantCode)}/orders`, { method: 'POST', body: JSON.stringify(payload) });
  }
}
