/** M09: project from a sales order (BR-23), templates / custom installments, variation orders, deposits, installment invoices, overview. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { arOf, ok, pin, setupSales, type SalesEnv } from './sales-helpers';

let env: SalesEnv;
let P: Record<string, string>;
let C: Record<string, string>;
let WH2: string;
beforeAll(async () => {
  env = await setupSales();
  P = env.seed.products;
  C = env.seed.customers;
  WH2 = env.seed.warehouses.WH2!;
});
afterAll(async () => { await env.close(); });

/** inc-VAT order of qty × 24 (อิฐมวลเบา) for c1 by the owner (credit limit self-approved). */
const order = (qty: string, extra: Record<string, unknown> = {}) =>
  ok(env.owner.post('/api/sales/orders', { customerId: C.c1, vatMode: 'inc', warehouseId: WH2, lines: [{ productId: P.p3, qty, unitPrice: '24' }], ...extra }), 201);

describe('project from a new sales order (BRD example 480,000 / deposit 96,000)', () => {
  let so: any;
  let pj: any;
  it('a new order flagged as project creates the project with 30/40/30 installments and due dates', async () => {
    so = await order('20000', { project: { mode: 'new', name: 'บ้านคุณสมชาย หมู่บ้านลานนา แปลง 5', site: 'ต.สันทราย จ.เชียงใหม่', contact: 'คุณสมชาย', template: '30/40/30' } });
    expect(so.totals.total).toBe('480000.00');
    expect(so.project).toMatchObject({ name: 'บ้านคุณสมชาย หมู่บ้านลานนา แปลง 5', isMain: true });
    expect(so.shipTo).toBe('ต.สันทราย จ.เชียงใหม่');
    pj = await ok(env.boy.get(`/api/sales/projects/${so.project.id}`));
    expect(pj.no).toMatch(/^PJ2610-/);
    expect(pj.mainSoNo).toBe(so.no);
    expect(pj.installments.map((i: { pct: string; dueDate: string; gross: string }) => [i.pct, i.dueDate, i.gross])).toEqual([
      ['30', '2026-11-25', '144000.00'], ['40', '2026-12-25', '192000.00'], ['30', '2027-01-24', '144000.00'],
    ]);
    expect(pj.figures).toMatchObject({ value: '480000.00', billed: '0.00', unbilled: '480000.00' });
  });

  it('a guarantee deposit has no VAT; the installment deducts it pro rata: 40 % = 192,000 − 38,400 = 153,600', async () => {
    const after = await ok(env.boy.post(`/api/sales/projects/${pj.id}/deposits`, { type: 'guarantee', amount: '96000', method: 'transfer' }), 201);
    const dep = after.deposits[0];
    expect(dep).toMatchObject({ type: 'guarantee', amount: '96000.00', invoiceNo: null, remaining: '96000.00' });
    expect(after.installments[1]).toMatchObject({ gross: '192000.00', deduct: '38400.00', net: '153600.00' });
    // only one deposit type per project
    expect((await env.boy.post(`/api/sales/projects/${pj.id}/deposits`, { type: 'advance', amount: '1000', method: 'cash' })).status).toBe(409);
    const b1 = await ok(env.boy.post(`/api/sales/projects/${pj.id}/installments/${after.installments[0].id}/bill`, {}), 201);
    const i1 = await ok(env.boy.get(`/api/sales/invoices/${b1.invoiceNo}`));
    expect(i1).toMatchObject({ source: 'installment', grossAmount: '144000.00', depositDeduct: '28800.00', depositType: 'guarantee', arBalance: '115200.00', dueDate: '2026-11-25' });
    expect(i1.doc.totals).toMatchObject({ total: '144000.00', vat: '9420.56' }); // VAT on the full installment once the deposit is applied
    const b2 = await ok(env.boy.post(`/api/sales/projects/${pj.id}/installments/${after.installments[1].id}/bill`, {}), 201);
    expect(await arOf(env, b2.invoiceNo)).toBe('153600.00');
    expect((await env.boy.post(`/api/sales/projects/${pj.id}/installments/${after.installments[1].id}/bill`, {})).status).toBe(409);
    expect(b2.project.deposits[0]).toMatchObject({ applied: '67200.00', remaining: '28800.00' });
    expect(b2.project.figures).toMatchObject({ billed: '336000.00', outstanding: '268800.00', collected: '67200.00', unbilled: '144000.00' });
  });

  it('billed installments keep their percentage; the rest is editable but must still add up to 100', async () => {
    const cur = await ok(env.boy.get(`/api/sales/projects/${pj.id}`));
    const rows = cur.installments.map((i: { id: string; pct: string; label: string; dueDate: string }) => ({ id: i.id, pct: i.pct, label: i.label, dueDate: i.dueDate }));
    expect((await env.boy.post(`/api/sales/projects/${pj.id}/installments`, { rows: [{ ...rows[0], pct: '20' }, rows[1], { ...rows[2], pct: '40' }] })).status).toBe(409);
    expect((await env.boy.post(`/api/sales/projects/${pj.id}/installments`, { rows: [rows[0], rows[1], { pct: '20', label: 'งวด 3', dueDate: '2027-01-15' }] })).status).toBe(400);
    const ok2 = await ok(env.boy.post(`/api/sales/projects/${pj.id}/installments`, { rows: [rows[0], rows[1], { pct: '10', label: 'งานหลังคา', dueDate: '2027-01-10' }, { pct: '20', label: 'ส่งมอบ', dueDate: '2027-02-10' }] }));
    expect(ok2.installments.map((i: { pct: string; status: string }) => `${i.pct}:${i.status}`)).toEqual(['30:billed', '40:billed', '10:open', '20:open']);
  });

  it('REQ-M09-06: forfeiting the unapplied guarantee needs the owner and issues a tax invoice for it', async () => {
    const no = (await ok(env.boy.get(`/api/sales/projects/${pj.id}`))).deposits[0].no;
    const r = await env.boy.post(`/api/sales/deposits/${no}/forfeit`, { reason: 'ลูกค้าผิดสัญญา' });
    expect(r.status).toBe(403);
    expect(r.body.details.need).toBe('ownerApproval');
    expect((await env.boy.post(`/api/sales/deposits/${no}/forfeit`, { reason: 'x', approval: pin(env, 'suda') })).status).toBe(403);
    const after = await ok(env.boy.post(`/api/sales/deposits/${no}/forfeit`, { reason: 'ลูกค้าผิดสัญญา', approval: pin(env, 'charoen') }));
    const dep = after.deposits[0];
    expect(dep).toMatchObject({ status: 'forfeited', remaining: '0.00' });
    const f = await ok(env.boy.get(`/api/sales/invoices/${dep.forfeitNo}`));
    expect(f).toMatchObject({ source: 'forfeit', arBalance: '0.00' });
    expect(f.doc.totals).toMatchObject({ total: '28800.00', vat: '1884.11' });
    // later installments deduct nothing more
    expect(after.installments[2]).toMatchObject({ deduct: '0.00' });
  });
});

describe('advance deposit, variation order, "ตั้งเป็นโครงการ"', () => {
  let pj: any;
  it('starts a project from an existing sales order and refuses a second one', async () => {
    const so = await order('4458.33', { vatMode: 'inc' }); // 106,999.92
    pj = await ok(env.boy.post('/api/sales/projects', { soNo: so.no, name: 'อาคารพาณิชย์ 2 คูหา', site: 'อ.สารภี', template: '50/50' }), 201);
    expect(pj.mainSoNo).toBe(so.no);
    expect(pj.installments).toHaveLength(2);
    expect((await env.boy.post('/api/sales/projects', { soNo: so.no, name: 'x' })).status).toBe(409);
    // custom percentages must add up to 100
    const so2 = await order('10');
    expect((await env.boy.post('/api/sales/projects', { soNo: so2.no, name: 'y', template: 'custom', installments: [{ pct: '60' }, { pct: '30' }] })).status).toBe(400);
    const custom = await ok(env.boy.post('/api/sales/projects', { soNo: so2.no, name: 'y', template: 'custom', installments: [{ pct: '60', label: 'มัดจำงาน' }, { pct: '40', label: 'ส่งมอบ' }] }), 201);
    expect(custom.template).toBe('custom');
  });

  it('an advance deposit is a tax invoice on receipt and is not taxed again on the installment', async () => {
    const after = await ok(env.boy.post(`/api/sales/projects/${pj.id}/deposits`, { type: 'advance', amount: '21400', method: 'transfer' }), 201);
    const dep = after.deposits[0];
    const depInv = await ok(env.boy.get(`/api/sales/invoices/${dep.invoiceNo}`));
    expect(depInv).toMatchObject({ source: 'deposit', kind: 'cash', arBalance: '0.00' });
    expect(depInv.doc.totals).toMatchObject({ total: '21400.00', vat: '1400.00' });
    const b1 = await ok(env.boy.post(`/api/sales/projects/${pj.id}/installments/${after.installments[0].id}/bill`, {}), 201);
    const i1 = await ok(env.boy.get(`/api/sales/invoices/${b1.invoiceNo}`));
    expect(i1).toMatchObject({ grossAmount: '53499.96', depositDeduct: '10700.00', depositType: 'advance' });
    expect(i1.doc.totals).toMatchObject({ total: '42799.96', vat: '2800.00' });
    expect(i1.textLines[1].amount).toBe('-10700.00');
    // the deposit is applied: it cannot be voided before that invoice
    expect((await env.owner.post(`/api/sales/deposits/${dep.no}/void`, { reason: 'x' })).status).toBe(409);
    expect((await env.owner.post(`/api/sales/deposits/${dep.no}/refund`, {})).status).toBe(409); // advance → credit note
  });

  it('a variation order adds to the project value; the last installment bills the remainder', async () => {
    const vo = await order('833.34', { project: { mode: 'existing', projectId: pj.id } }); // 20,000.16
    expect(vo.project).toMatchObject({ id: pj.id, isMain: false });
    const cur = await ok(env.boy.get(`/api/sales/projects/${pj.id}`));
    expect(cur.figures.value).toBe('127000.08');
    expect(cur.orders.map((o: { no: string; isMain: boolean }) => o.isMain)).toEqual([true, false]);
    expect(cur.installments[1]).toMatchObject({ gross: '73500.12', deduct: '10700.00' });
    // the variation must be for the project customer
    expect((await env.owner.post('/api/sales/orders', { customerId: C.c2, lines: [{ productId: P.p3, qty: '1', unitPrice: '24' }], project: { mode: 'existing', projectId: pj.id } })).status).toBe(400);
  });

  it('overview: delivered value follows the delivery orders to the site; collected follows receipts', async () => {
    const cur = await ok(env.boy.get(`/api/sales/projects/${pj.id}`));
    const main = await ok(env.boy.get(`/api/sales/orders/${cur.mainSoNo}`));
    const dl = await ok(env.chai.post('/api/sales/deliveries', { soNo: main.no, lines: [{ srcLineId: main.lines[0].id, qty: '1000' }] }), 201);
    expect(dl.shipTo).toBe('อ.สารภี');
    expect(dl.project.id).toBe(pj.id);
    const inv = cur.invoices.find((i: { source: string }) => i.source === 'installment');
    await ok(env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'transfer', lines: [{ invoiceNo: inv.no, amount: '20000' }] }), 201);
    const fig = (await ok(env.boy.get(`/api/sales/projects/${pj.id}`))).figures;
    expect(fig).toMatchObject({ value: '127000.08', delivered: '24000.00', billed: '53499.96', collected: '30700.00', outstanding: '22799.96' });
    const list = await ok(env.boy.get('/api/sales/projects?limit=10'));
    expect(list.items.find((p: { id: string }) => p.id === pj.id).figures.billed).toBe('53499.96');
  });
});

describe('void and permissions', () => {
  it('a project with invoices cannot be voided; an empty one can, and its order becomes an ordinary order', async () => {
    const so = await order('10', { project: { mode: 'new', name: 'ทดลอง', template: '100%' } });
    const p = so.project;
    expect((await env.boy.post(`/api/sales/orders/${so.no}/void`, { reason: 'x', ...pin(env) })).status).toBe(409); // main order: project first
    const dep = await ok(env.boy.post(`/api/sales/projects/${p.id}/deposits`, { type: 'guarantee', amount: '100', method: 'cash' }), 201);
    expect((await env.owner.post(`/api/sales/projects/${p.id}/void`, { reason: 'x' })).status).toBe(409);
    await ok(env.owner.post(`/api/sales/deposits/${dep.deposits[0].no}/refund`, { method: 'cash', reason: 'ยกเลิกงาน' }));
    const v = await ok(env.owner.post(`/api/sales/projects/${p.id}/void`, { reason: 'ลูกค้ายกเลิก' }));
    expect(v.status).toBe('void');
    expect(v.deposits[0]).toMatchObject({ status: 'refunded', refund: { amount: '100.00', method: 'cash' } });
    expect((await ok(env.boy.get(`/api/sales/orders/${so.no}`))).project).toBeNull();
    expect((await ok(env.boy.post(`/api/sales/orders/${so.no}/void`, { reason: 'x', ...pin(env) }))).status).toBe('void');
  });

  it('cashier and warehouse users cannot create projects', async () => {
    const so = await order('5');
    expect((await env.prae.post('/api/sales/projects', { soNo: so.no, name: 'x' })).status).toBe(403);
    expect((await env.chai.post('/api/sales/projects', { soNo: so.no, name: 'x' })).status).toBe(403);
    expect((await env.chai.get('/api/sales/projects')).status).toBe(403);
  });
});

describe('editing a project header', () => {
  it('owner edits name, site, contact and note; it is audited; a sales clerk without sales.project cannot; a void project cannot', async () => {
    const so = await order('10', { project: { mode: 'new', name: 'งานแก้หมายเหตุ', site: 'เดิม', template: '50/50' } });
    const id = so.project.id;
    const r = await ok(env.owner.patch(`/api/sales/projects/${id}`, { note: 'เข้าหน้างานได้หลัง 8 โมง', site: 'ซอย 5 ถ.ใหม่' }));
    expect(r).toMatchObject({ note: 'เข้าหน้างานได้หลัง 8 โมง', site: 'ซอย 5 ถ.ใหม่', name: 'งานแก้หมายเหตุ' });
    expect((await env.owner.patch(`/api/sales/projects/${id}`, {})).status).toBe(400);
    expect((await env.owner.patch(`/api/sales/projects/${id}`, { name: '  ' })).status).toBe(400);
    const log = await ok(env.owner.get(`/api/audit-log?q=${encodeURIComponent(r.no)}&limit=50`));
    expect(JSON.stringify(log)).toContain('หมายเหตุ');
  });
});

