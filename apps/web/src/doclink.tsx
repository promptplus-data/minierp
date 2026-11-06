/**
 * One place that knows where every document number opens. Use <DocLink no="..." /> wherever a document number is
 * shown (lists, dashboards, reports, audit log, aging, project pages) instead of plain text.
 *
 * The document type comes from the explicit `type` prop, otherwise from the number's letter prefix (QT, SO, DO, INV,
 * ABB, CN, BN, RE, GR, AP, PV, PR, MO, TR, ADJ, RQ, CNT, LV, IMP, DP). When the signed-in role cannot open the target
 * screen (the nav item is hidden), the number renders as plain text instead of a link that bounces to the home page.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { navFor, useVisibleNav } from './modules';

export type DocType =
  | 'ABB' | 'INV' | 'CN' | 'QT' | 'SO' | 'DO' | 'BN' | 'RE' | 'GR' | 'AP' | 'PV' | 'PR' | 'MO' | 'TR' | 'ADJ' | 'RQ' | 'CNT' | 'LV' | 'IMP' | 'DP' | 'PJ' | 'GRD';

export const DOC_TYPE_TH: Record<DocType, string> = {
  ABB: 'ใบกำกับภาษีอย่างย่อ', INV: 'ใบกำกับภาษี', CN: 'ใบลดหนี้ / รับคืน', QT: 'ใบเสนอราคา', SO: 'ใบสั่งขาย', DO: 'ใบส่งของ', BN: 'ใบวางบิล', RE: 'ใบเสร็จรับเงิน',
  GR: 'ใบรับสินค้า', AP: 'บิลเจ้าหนี้', PV: 'ใบสำคัญจ่าย', PR: 'ใบส่งคืนผู้ขาย', MO: 'ใบสั่งผลิต', TR: 'ใบโอนคลัง', ADJ: 'ใบปรับยอดสต็อก', RQ: 'คำขอปรับยอด',
  CNT: 'ใบนับสต็อก', LV: 'ใบลา', IMP: 'ชุดนำเข้าข้อมูล', DP: 'ใบมัดจำ', PJ: 'โครงการ', GRD: 'ใบส่งของรอรับ',
};

const KNOWN = Object.keys(DOC_TYPE_TH) as DocType[];

/** 'INV2611-0004' → 'INV'. Longest known prefix wins; null when the text is not a document number. */
export function docTypeOf(no: string): DocType | null {
  const head = /^([A-Z]+)/.exec(no)?.[1];
  if (!head || !/\d/.test(no)) return null;
  for (let n = Math.min(head.length, 3); n >= 2; n--) {
    const p = head.slice(0, n) as DocType;
    if (KNOWN.includes(p)) return p;
  }
  return null;
}

const enc = encodeURIComponent;

/** Route that opens a document, with the nav path that guards it (for the visibility check). `b2b` = prefer the B2B page. */
export function docRoute(type: DocType, no: string, opts: { b2b?: boolean } = {}): string | null {
  switch (type) {
    case 'ABB': case 'CN': return `/sales/${enc(no)}`;
    case 'INV': return opts.b2b === false ? `/sales/${enc(no)}` : `/b2b/inv/${enc(no)}`;
    case 'QT': return `/b2b/qt/${enc(no)}`;
    case 'SO': return `/b2b/so/${enc(no)}`;
    case 'DO': return `/b2b/do/${enc(no)}`;
    case 'BN': return `/ar/bn/${enc(no)}`;
    case 'RE': return `/ar/rc/${enc(no)}`;
    case 'GR': return `/purchasing/gr/${enc(no)}`;
    case 'AP': return `/ap/bill/${enc(no)}`;
    case 'PV': return `/ap/pv/${enc(no)}`;
    case 'PR': return `/ap/pr/${enc(no)}`;
    case 'MO': return `/production/${enc(no)}`;
    case 'TR': case 'ADJ': return `/stock-ledger?q=${enc(no)}`;
    case 'RQ': return `/stock?req=${enc(no)}`;
    case 'CNT': return `/stock-count?no=${enc(no)}`;
    case 'LV': return `/leave?no=${enc(no)}`;
    case 'IMP': return '/import';
    case 'DP': case 'PJ': return `/projects?q=${enc(no)}`;
    case 'GRD': return null;
  }
}

/** The route for a number as the signed-in role would open it, or null when no visible screen shows it. */
export function useDocRoute() {
  const visible = useVisibleNav();
  const shows = (path: string) => {
    const owner = navFor(path.split('?')[0]!);
    return !!owner && visible.includes(owner);
  };
  return (no: string, type?: DocType | null): string | null => {
    const t = type ?? docTypeOf(no);
    if (!t) return null;
    let to = docRoute(t, no);
    if (to && t === 'INV' && !shows(to)) to = docRoute(t, no, { b2b: false });
    return to && shows(to) ? to : null;
  };
}

export function DocLink({ no, type, className, children }: { no: string | null | undefined; type?: DocType; className?: string; children?: ReactNode }) {
  const route = useDocRoute();
  if (!no) return <>{children ?? '-'}</>;
  const to = route(no, type);
  const label = children ?? no;
  return to ? <Link className={className ? `${className} doclink` : 'doclink'} to={to} onClick={(e) => e.stopPropagation()}>{label}</Link> : <span className={className}>{label}</span>;
}

/** Comma-separated DocLinks for a list of numbers. */
export function DocLinks({ nos, type }: { nos: (string | null | undefined)[]; type?: DocType }) {
  const list = nos.filter((x): x is string => !!x);
  if (!list.length) return <>-</>;
  return <>{list.map((n, i) => <span key={n}>{i > 0 && ', '}<DocLink no={n} type={type} /></span>)}</>;
}

/** A link to any in-app path that degrades to plain text when the signed-in role cannot open that screen. */
export function RouteLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const visible = useVisibleNav();
  const owner = navFor(to.split('?')[0]!);
  return owner && visible.includes(owner) ? <Link className={className} to={to} onClick={(e) => e.stopPropagation()}>{children}</Link> : <span className={className}>{children}</span>;
}

const NO_RE = /\b(ABB|INV|CN|QT|SO|DO|BN|RE|GR|AP|PV|PR|MO|TR|ADJ|RQ|CNT|DP|PJ|LV)\d{4}-\d{4}\b/g;

/** Free text that mentions document numbers ("ส่งของ · SO2611-0003"): each number becomes a DocLink. */
export function DocText({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(NO_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push(<DocLink key={i} no={m[0]} />);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
