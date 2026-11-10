/**
 * Searchable pickers of the B2B forms (all built on SearchSelect: partial Thai-segmented search, lazy 20-row pages):
 * customer (with "+ สร้างลูกค้าใหม่"), warehouse, salesperson, ship-to address (customer address book with
 * "+ บันทึกที่อยู่ใหม่"), sale type / project, delivery source.
 */
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { CustomerAddress, SalesDeliverySource, SalesPerson, page } from '@erp/contracts';
import { api } from '../../api';
import { useWarehouses } from '../../data';
import { th } from '../../ui';
import { CustomerPicker } from '../../ui/CustomerPicker';
import { SearchSelect } from '../../ui/SearchSelect';

/** Customer of a document; quick-create saves to the customer master and selects the new customer. */
export function CustomerSelect({ value, onChange, testId, requireTaxId, invalid, allowCreate = true }: {
  value: string; onChange: (id: string) => void; noCash?: boolean; testId?: string; requireTaxId?: boolean; invalid?: boolean; allowCreate?: boolean;
}) {
  return <CustomerPicker value={value || null} onChange={(id) => onChange(id ?? '')} testId={testId} requireTaxId={requireTaxId} invalid={invalid} allowCreate={allowCreate} />;
}

export function WarehouseSelect({ value, onChange, testId = 'wh', ariaLabel = 'คลังสินค้า' }: { value: string; onChange: (id: string) => void; testId?: string; ariaLabel?: string }) {
  const whs = useWarehouses();
  const items = useMemo(() => (whs.data ?? []).filter((w) => w.active), [whs.data]);
  type W = (typeof items)[number];
  return (
    <SearchSelect<W> value={value || null} onChange={(id) => onChange(id ?? '')} items={items} getId={(w) => w.id} getLabel={(w) => w.name}
      getSub={(w) => (w.isPos ? 'หน้าร้าน (POS)' : 'คลังสินค้า')} testId={testId} ariaLabel={ariaLabel} name="warehouseId" />
  );
}

const People = z.object({ items: z.array(SalesPerson) });
const ROLE_TH: Record<string, string> = { sales: 'พนักงานขาย', manager: 'ผู้จัดการ', owner: 'เจ้าของร้าน', cashier: 'แคชเชียร์' };
export function SalespersonSelect({ value, onChange, testId = 'salesperson' }: { value: string; onChange: (id: string) => void; testId?: string }) {
  const q = useQuery({ queryKey: ['salespeople'], staleTime: 5 * 60_000, queryFn: () => api('GET', '/api/sales/salespeople', { schema: People }) });
  return (
    <SearchSelect<SalesPerson> value={value || null} onChange={(id) => onChange(id ?? '')} items={q.data?.items ?? []} getId={(u) => u.id} getLabel={(u) => u.name}
      getSub={(u) => [ROLE_TH[u.role] ?? u.role, u.phone].filter(Boolean).join(' · ')} getSearch={(u) => u.phone ?? ''} emptyLabel="ตัวฉันเอง (ผู้บันทึก)"
      testId={testId} ariaLabel="พนักงานขาย" name="salespersonId" />
  );
}

const Addresses = z.object({ items: z.array(CustomerAddress) });
const KIND_TH: Record<CustomerAddress['kind'], string> = { customer: 'ที่อยู่ลูกค้า', project: 'หน้างาน', saved: 'ที่อยู่ที่บันทึกไว้' };
/**
 * Ship-to address: the customer's saved addresses, its own address and its project sites. Typing a new one offers
 * "+ บันทึกที่อยู่ใหม่", which saves it to the customer's address book and selects it. `value` is the address text.
 */
export function AddressPicker({ customerId, value, onChange, testId = 'ship-to', placeholder }: {
  customerId: string; value: string; onChange: (address: string) => void; testId?: string; placeholder?: string;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['cust-addresses', customerId], enabled: !!customerId, staleTime: 30_000,
    queryFn: () => api('GET', `/api/sales/customers/${customerId}/addresses`, { schema: Addresses }),
  });
  const items = q.data?.items ?? [];
  const hit = items.find((a) => a.address === value);
  const custom: CustomerAddress | null = value && !hit ? { id: '__typed', kind: 'saved', label: '', address: value } : null;
  const save = async (text: string) => {
    if (!text.trim()) return;
    if (!customerId) { onChange(text.trim()); return; }
    const a = await api('POST', `/api/sales/customers/${customerId}/addresses`, { body: { address: text.trim() }, schema: CustomerAddress });
    await qc.invalidateQueries({ queryKey: ['cust-addresses', customerId] });
    onChange(a.address);
  };
  return (
    <SearchSelect<CustomerAddress>
      value={hit?.id ?? (custom ? custom.id : null)}
      onChange={(_, a) => onChange(a?.address ?? '')}
      items={items}
      selected={custom}
      getId={(a) => a.id}
      getLabel={(a) => a.address}
      getSub={(a) => (a.id === '__typed' ? 'พิมพ์เอง' : a.label && a.label !== KIND_TH[a.kind] ? `${KIND_TH[a.kind]} · ${a.label}` : KIND_TH[a.kind])}
      getSearch={(a) => a.label}
      emptyLabel={placeholder ?? 'ไม่ระบุ (ใช้ที่ตั้งโครงการ / ที่อยู่ลูกค้า)'}
      placeholder={placeholder ?? 'เลือกหรือพิมพ์ที่อยู่ส่งของ'}
      onCreate={(t) => void save(t)}
      createLabel="บันทึกที่อยู่ใหม่"
      testId={testId}
      ariaLabel="ที่อยู่ส่งของ"
      name="shipTo"
    />
  );
}

/** Sale type of a sales order: ordinary, variation of an existing project, or a new project. Values '', projectId, 'new'. */
export function SaleTypeSelect({ value, onChange, projects, testId = 'so-project' }: {
  value: string; onChange: (v: string) => void; projects: { id: string; name: string; site: string }[]; testId?: string;
}) {
  type O = { id: string; label: string; sub: string };
  const items: O[] = [
    ...projects.map((p) => ({ id: p.id, label: `เพิ่มเข้าโครงการเดิม (งานเพิ่ม): ${p.name}`, sub: p.site || 'งานเพิ่ม (variation)' })),
    { id: 'new', label: 'ขายโครงการ: สร้างโครงการ/หน้างานใหม่จากใบนี้', sub: 'วางบิลตามงวด' },
  ];
  return (
    <SearchSelect<O> value={value || null} onChange={(id) => onChange(id ?? '')} items={items} getId={(o) => o.id} getLabel={(o) => o.label} getSub={(o) => o.sub}
      emptyLabel="ขายส่ง/เงินเชื่อทั่วไป" testId={testId} ariaLabel="ประเภทการขาย" name="project" />
  );
}

const sourcePage = page(SalesDeliverySource);
/** Open sales orders / goods-left invoices to deliver (searched on the server). */
export function DeliverySourceSelect({ value, onChange, selected, testId = 'dlv-source' }: {
  value: string; onChange: (key: string, s: SalesDeliverySource | null) => void; selected: SalesDeliverySource | null; testId?: string;
}) {
  return (
    <SearchSelect<SalesDeliverySource>
      value={value || null}
      onChange={(id, s) => onChange(id ?? '', s)}
      fetchPage={async (q) => ({ ...(await api('GET', '/api/sales/delivery-sources', { query: { q: q || undefined, limit: 50 }, schema: sourcePage, silent: true })), nextCursor: null })}
      queryKey={['dlv-src', 'pick']}
      selected={selected}
      getId={(x) => `${x.kind}:${x.no}`}
      getLabel={(x) => `${x.no} · ${x.customer.name}`}
      getSub={(x) => `${x.kind === 'SO' ? 'ใบสั่งขาย' : 'บิลฝากของ'}${x.project ? ` · ${x.project.name}` : ''} · ${th(x.date)}`}
      placeholder="ค้นเลขที่ใบขาย / ชื่อลูกค้า"
      testId={testId}
      ariaLabel="อ้างอิงใบขาย"
    />
  );
}
