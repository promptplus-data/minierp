/** Multi-line stock forms (mockup stockFormModal + mpModal): transfer, issue, adjust request, manual receipt. */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AdjustRequest, StockDoc, type Product } from '@erp/contracts';
import { d, sum } from '@erp/core';
import { ApiFail, api, errText } from '../api';
import { useCatalog, useMeta, useVendors, useWarehouseStock, useWarehouses } from '../data';
import { fmt, fq, Modal, ReasonField, reasonInit, reasonText, ShortageModal, useToast, type ReasonState, type Shortage } from '../ui';

export type StockKind = 'tr' | 'iss' | 'adj';
interface Line { pid: string; u: number; q: string }

const isNum = (s: string, allowNeg = false) => (allowNeg ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/).test(s.trim());
const baseQty = (p: Product | undefined, l: Line) => (p && isNum(l.q, true) ? d(l.q).times(d(p.units[l.u]?.factor ?? '1')) : d(0));

function useStockProducts() {
  const cat = useCatalog();
  const list = useMemo(() => (cat.data ?? []).filter((p) => p.kind === 'stock'), [cat.data]);
  return { list, byId: cat.byId };
}

function useInvalidateStock() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['stock'] }), qc.invalidateQueries({ queryKey: ['adjust'] }), qc.invalidateQueries({ queryKey: ['lots'] })]);
}

export function StockFormModal({ kind, onClose }: { kind: StockKind; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateStock();
  const whs = useWarehouses();
  const prods = useStockProducts();
  const active = (whs.data ?? []).filter((w) => w.active);
  const back = active.find((w) => !w.isPos) ?? active[0];
  const front = active.find((w) => w.isPos) ?? active[1] ?? active[0];
  const [wh, setWh] = useState('');
  const [wh2, setWh2] = useState('');
  const from = wh || back?.id || '';
  const to = wh2 || front?.id || '';
  const [lines, setLines] = useState<Line[]>([]);
  const [reason, setReason] = useState<ReasonState>(reasonInit(kind));
  const [note, setNote] = useState('');
  const [scan, setScan] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [short, setShort] = useState<Shortage[] | null>(null);
  const stock = useWarehouseStock(from || undefined);

  const rows = lines.length ? lines : prods.list[0] ? [{ pid: prods.list[0].id, u: 0, q: kind === 'adj' ? '-1' : '1' }] : [];
  const update = (i: number, patch: Partial<Line>) => setLines(rows.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const used = new Map<string, ReturnType<typeof d>>();
  rows.forEach((l) => used.set(l.pid, (used.get(l.pid) ?? d(0)).plus(baseQty(prods.byId.get(l.pid), l))));

  const T = { tr: 'โอนสินค้าระหว่างคลัง', iss: 'เบิกใช้สินค้า', adj: 'ขอปรับยอดสต็อก' }[kind];

  const onScan = () => {
    const p = prods.list.find((x) => x.barcode && x.barcode === scan.trim());
    if (!p) return toast('ไม่พบบาร์โค้ดนี้');
    const ex = rows.find((l) => l.pid === p.id && l.u === 0);
    if (ex) setLines(rows.map((l) => (l === ex ? { ...l, q: d(l.q || '0').plus(kind === 'adj' && d(l.q || '0').lt(0) ? -1 : 1).toString() } : l)));
    else setLines([...rows, { pid: p.id, u: 0, q: kind === 'adj' ? '-1' : '1' }]);
    setScan('');
  };

  const save = async () => {
    const r = reasonText(reason);
    if (r === null) return setErr('เลือก "อื่น ๆ" แล้ว ต้องพิมพ์เหตุผลก่อน');
    if (!rows.length) return setErr('เพิ่มสินค้าอย่างน้อย 1 รายการ');
    if (rows.some((l) => !isNum(l.q, kind === 'adj') || d(l.q).isZero() || (kind !== 'adj' && d(l.q).lt(0)))) return setErr(kind === 'adj' ? 'ใส่จำนวน + หรือ − ทุกแถว (ห้าม 0)' : 'จำนวนต้องมากกว่า 0 ทุกแถว');
    if (kind === 'tr' && from === to) return setErr('เลือกคลังปลายทางที่ต่างจากต้นทาง');
    const fullReason = note.trim() ? `${r} · ${note.trim()}` : r;
    setBusy(true);
    setErr('');
    try {
      let no: string;
      if (kind === 'adj') {
        const res = await api('POST', '/api/stock/adjust-requests', {
          body: { warehouseId: from, reason: fullReason, lines: rows.map((l) => ({ productId: l.pid, qtyDelta: baseQty(prods.byId.get(l.pid), l).toString() })) },
          schema: AdjustRequest,
        });
        no = res.no;
      } else {
        const lns = rows.map((l) => ({ productId: l.pid, unitIdx: l.u, qty: l.q.trim() }));
        const res = kind === 'tr'
          ? await api('POST', '/api/stock/transfers', { body: { fromWarehouseId: from, toWarehouseId: to, lines: lns, note: fullReason }, schema: StockDoc })
          : await api('POST', '/api/stock/issues', { body: { warehouseId: from, lines: lns, reason: fullReason }, schema: StockDoc });
        no = res.no;
      }
      await invalidate();
      toast(kind === 'adj' ? `ส่งขออนุมัติปรับยอด ${no} แล้ว` : `บันทึก ${no} แล้ว ${rows.length} รายการ`);
      onClose();
    } catch (e) {
      if (e instanceof ApiFail && e.code === 'INSUFFICIENT_STOCK') setShort(e.details as Shortage[]);
      else setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (short) return <ShortageModal shortages={short} what={`${T}ไม่ได้`} onClose={() => setShort(null)} />;

  return (
    <Modal onClose={onClose} wide label={T}>
      <h3>{T}</h3>
      <p className="small muted" style={{ margin: 0 }}>ใส่ได้หลายสินค้าในใบเดียว · สแกนบาร์โค้ดเพื่อเพิ่มแถวได้ · {kind === 'adj' ? 'ใส่ + เพื่อเพิ่ม หรือ − เพื่อลด ทุกแถวต้องรอเจ้าของร้านหรือผู้จัดการอนุมัติก่อนสต็อกเปลี่ยน' : kind === 'tr' ? 'ล็อตย้ายไปพร้อมวันที่และต้นทุนเดิม' : 'ตัดล็อตเก่าก่อน (FIFO)'}</p>
      <div className="fgrid">
        <label className="f">{kind === 'tr' ? 'จากคลัง' : 'คลัง'}
          <select value={from} onChange={(e) => setWh(e.target.value)} data-testid="sf-wh">{active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </label>
        {kind === 'tr' && (
          <label className="f">ไปคลัง<select value={to} onChange={(e) => setWh2(e.target.value)} data-testid="sf-wh2">{active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        )}
        <ReasonField kind={kind} value={reason} onChange={setReason} label={kind === 'tr' ? 'เหตุผลการโอน' : 'เหตุผล'} />
        <label className="f">หมายเหตุ<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'iss' ? 'เช่น ใช้ซ่อมหลังคาร้าน' : 'ไม่บังคับ'} /></label>
      </div>
      <div className="row">
        <input type="text" value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onScan(); }} placeholder="สแกน / พิมพ์บาร์โค้ด แล้วกด Enter เพื่อเพิ่มแถว" style={{ flex: 1, minWidth: 200 }} aria-label="สแกนบาร์โค้ด" />
      </div>
      <div className="tw">
        <table>
          <thead><tr><th>#</th><th>สินค้า</th><th>หน่วย</th><th className="n">{kind === 'adj' ? 'ปรับ + / −' : 'จำนวน'}</th><th className="n">คงเหลือในคลัง</th><th className="n">{kind === 'tr' ? 'ต้นทาง' : ''}หลังทำรายการ</th><th /></tr></thead>
          <tbody>
            {rows.map((l, i) => {
              const p = prods.byId.get(l.pid);
              const av = d(stock.data?.get(l.pid) ?? '0');
              const after = kind === 'adj' ? av.plus(baseQty(p, l)) : av.minus(used.get(l.pid) ?? 0);
              const bad = kind === 'adj' ? !isNum(l.q, true) || d(l.q).isZero() || after.lt(0) : !isNum(l.q) || d(l.q).lte(0) || after.lt(0);
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <select value={l.pid} aria-label={`สินค้าแถว ${i + 1}`} onChange={(e) => update(i, { pid: e.target.value, u: 0 })} data-testid={`sf-p${i}`}>
                      {prods.list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                  <td>
                    {kind === 'adj' ? p?.units[0]?.name : (
                      <select value={l.u} aria-label="หน่วย" onChange={(e) => update(i, { u: Number(e.target.value) })}>{p?.units.map((u, k) => <option key={k} value={k}>{u.name}</option>)}</select>
                    )}
                  </td>
                  <td className="n"><input className={`qty${bad ? ' bad' : ''}`} type="text" inputMode="decimal" value={l.q} aria-label={`จำนวนแถว ${i + 1}`} onChange={(e) => update(i, { q: e.target.value })} data-testid={`sf-q${i}`} /></td>
                  <td className="n">{fq(av)} {p?.units[0]?.name}</td>
                  <td className="n" style={bad ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>
                    {fq(after)}{bad && <div className="small">{kind === 'adj' ? (isNum(l.q, true) && !d(l.q).isZero() ? 'ติดลบไม่ได้' : 'ใส่จำนวน') : 'เกินคงเหลือ'}</div>}
                  </td>
                  <td>{rows.length > 1 && <button className="btn sm bad" aria-label="ลบแถว" onClick={() => setLines(rows.filter((_, j) => j !== i))}>✕</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="btn sm" onClick={() => prods.list[0] && setLines([...rows, { pid: prods.list[0].id, u: 0, q: kind === 'adj' ? '-1' : '1' }])}>+ เพิ่มสินค้า</button>
        <span className="small muted">{rows.length} รายการ</span>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="sf-save">{kind === 'adj' ? `ส่งขออนุมัติ ${rows.length} รายการ` : `บันทึก ${rows.length} รายการ`}</button>
      </div>
    </Modal>
  );
}

interface RLine { pid: string; u: number; q: string; cost: string }

/** ซื้อเข้าแบบบันทึกเอง (REQ-M05-06): the only goods-receipt path on-prem. Bill discount goes into lot cost. */
export function ReceiptModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateStock();
  const meta = useMeta();
  const vendors = useVendors();
  const whs = useWarehouses();
  const prods = useStockProducts();
  const vat = meta.data?.shop.vatRegistered ?? true;
  const active = (whs.data ?? []).filter((w) => w.active);
  const [vendor, setVendor] = useState('');
  const [inv, setInv] = useState('');
  const [dn, setDn] = useState('');
  const [wh, setWh] = useState('');
  const [bd, setBd] = useState('');
  const [lines, setLines] = useState<RLine[]>([{ pid: '', u: 0, q: '1', cost: '0' }]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const vId = vendor || vendors.data?.[0]?.id || '';
  const whId = wh || active.find((w) => !w.isPos)?.id || active[0]?.id || '';
  const update = (i: number, patch: Partial<RLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const amt = (l: RLine) => (isNum(l.q) && isNum(l.cost) ? d(l.q).times(d(l.cost)) : d(0));
  const total = sum(lines.filter((l) => l.pid).map(amt));
  const disc = isNum(bd) ? Math.min(d(bd).toNumber(), total.toNumber()) : 0;
  const net = total.minus(disc);
  const vatAmt = vat ? net.times('0.07') : d(0);

  const save = async () => {
    if (!dn.trim()) return setErr('กรอกเลขที่ใบส่งของ');
    if (!inv.trim()) return setErr('กรอกเลขที่ใบกำกับภาษี / บิลของผู้ขาย');
    const ls = lines.filter((l) => l.pid);
    if (!ls.length) return setErr('เลือกสินค้าอย่างน้อย 1 รายการ');
    if (ls.some((l) => !isNum(l.q) || d(l.q).lte(0) || !isNum(l.cost))) return setErr('จำนวนต้องมากกว่า 0 และต้นทุนต้องเป็นตัวเลข');
    if (bd && !isNum(bd)) return setErr('ส่วนลดท้ายบิลต้องเป็นตัวเลข');
    setBusy(true);
    setErr('');
    try {
      const res = await api('POST', '/api/stock/receipts', {
        body: { vendorId: vId, vendorInvoiceNo: inv.trim(), deliveryNo: dn.trim(), warehouseId: whId, billDiscount: bd.trim() || '0', lines: ls.map((l) => ({ productId: l.pid, unitIdx: l.u, qty: l.q.trim(), unitCost: l.cost.trim() })) },
        schema: StockDoc,
      });
      await invalidate();
      toast(`รับเข้าสต็อก ${res.no} แล้ว ${ls.length} รายการ`);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} wide label="ซื้อเข้าแบบบันทึกเอง">
      <h3>ซื้อเข้าแบบบันทึกเอง</h3>
      <p className="small muted" style={{ margin: 0 }}>สำหรับของที่ซื้อจากผู้จำหน่าย · 1 ใบรับได้หลายสินค้า · บันทึกแล้วสร้างล็อตใหม่ตามวันที่รับของ</p>
      <div className="fgrid">
        <label className="f">ผู้จำหน่าย<select value={vId} onChange={(e) => setVendor(e.target.value)}>{(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label className="f">เลขที่ใบส่งของ (จำเป็น)<input type="text" value={dn} onChange={(e) => setDn(e.target.value)} placeholder="เช่น DO-6910-0158" data-testid="gr-dn" /></label>
        <label className="f">เลขที่ใบกำกับภาษีผู้ขาย (จำเป็น)<input type="text" value={inv} onChange={(e) => setInv(e.target.value)} placeholder="เช่น IV6910-0042" data-testid="gr-inv" /></label>
        <label className="f">เข้าคลัง<select value={whId} onChange={(e) => setWh(e.target.value)}>{active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      </div>
      <div className="tw">
        <table>
          <thead><tr><th>สินค้า</th><th>หน่วย</th><th className="n">จำนวน</th><th className="n">ต้นทุน/หน่วย ({vat ? 'ก่อน VAT' : 'ที่จ่ายจริง'})</th><th className="n">รวม</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const p = prods.byId.get(l.pid);
              return (
                <tr key={i}>
                  <td>
                    <select value={l.pid} aria-label={`สินค้าแถว ${i + 1}`} data-testid={`gr-p${i}`}
                      onChange={(e) => { const np = prods.byId.get(e.target.value); update(i, { pid: e.target.value, u: 0, cost: np?.cost ?? l.cost }); }}>
                      <option value="">— เลือกสินค้า —</option>
                      {prods.list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    {!p && <div className="small" style={{ color: 'var(--warn)' }}>ยังไม่ได้เลือกสินค้า</div>}
                  </td>
                  <td>{p ? <select value={l.u} aria-label="หน่วย" onChange={(e) => update(i, { u: Number(e.target.value) })}>{p.units.map((u, k) => <option key={k} value={k}>{u.name}</option>)}</select> : '-'}</td>
                  <td className="n"><input className="qty" type="text" inputMode="decimal" value={l.q} aria-label={`จำนวนแถว ${i + 1}`} onChange={(e) => update(i, { q: e.target.value })} data-testid={`gr-q${i}`} /></td>
                  <td className="n"><input className="qty" type="text" inputMode="decimal" value={l.cost} style={{ width: 100 }} aria-label={`ต้นทุนแถว ${i + 1}`} onChange={(e) => update(i, { cost: e.target.value })} data-testid={`gr-c${i}`} /></td>
                  <td className="n">{fmt(amt(l))}</td>
                  <td>{lines.length > 1 && <button className="btn sm bad" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>ลบ</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row"><button className="btn sm" onClick={() => setLines((ls) => [...ls, { pid: '', u: 0, q: '1', cost: '0' }])}>+ เพิ่มสินค้า</button><span className="small muted">{lines.filter((l) => l.pid).length} รายการ</span></div>
      <div className="grid g2" style={{ gap: 12 }}>
        <div>
          <label className="f">ส่วนลดท้ายบิลจากผู้ขาย (บาท{vat ? ' ก่อน VAT' : ''} · ไม่ได้ระบุรายสินค้า)<input type="text" inputMode="decimal" value={bd} placeholder="0" onChange={(e) => setBd(e.target.value)} data-testid="gr-bd" /></label>
          <div className="small muted" style={{ marginTop: 4 }}>ระบบกระจายส่วนลดเข้าทุนของแต่ละล็อตตามสัดส่วนมูลค่า · ทุนต่อหน่วยลดลง {total.gt(0) ? fq(d(disc).div(total).times(100)) : '0'}%</div>
        </div>
        <div className="tot">
          <span className="muted">ยอดสินค้า</span><span>{fmt(total)}</span>
          <span className="muted">ส่วนลดท้ายบิล</span><span>−{fmt(disc)}</span>
          {vat && <><span className="muted">VAT ซื้อ 7%</span><span>{fmt(vatAmt)}</span></>}
          <span style={{ fontWeight: 600 }}>ตั้งเจ้าหนี้</span><span className="big">฿{fmt(net.plus(vatAmt))}</span>
        </div>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="gr-save">บันทึกรับเข้าสต็อก</button>
      </div>
    </Modal>
  );
}
