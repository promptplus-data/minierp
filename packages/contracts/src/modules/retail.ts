/**
 * API contract for the "retail" module group (Agent C): M15 promotions, M16 production, held POS bills,
 * customer price lists (BR-05) and product images (REQ-M07-11). Every name is re-exported from '@erp/contracts'.
 * The POS sale extension (bundle sales, promo refs) lives on PosSaleReq / DocLine in ../core.ts.
 * Keep Prompt Plus names out of this file (scripts/check-onprem.mjs).
 */
import { z } from 'zod';
import { Approval, Dec, DecNN, pageQuery, type RouteEditions } from '../core';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

// ---------- M15 promotions ----------
export const PromoKind = z.enum(['disc', 'bundle']);
export const PromoMode = z.enum(['pct', 'amt', 'fixed']);
export const PromoChannel = z.enum(['pos', 'b2b']);
export const PromoStateZ = z.enum(['draft', 'scheduled', 'live', 'expired', 'closed']);

export const PromoItem = z.object({ productId: z.string(), qtyPerSet: Dec.optional() });
export const PromoInput = z.object({
  name: z.string().trim().min(1),
  kind: PromoKind,
  mode: PromoMode.optional(),           // disc
  value: DecNN.optional(),              // disc: % / baht per base unit / promo price per base unit
  setPrice: DecNN.optional(),           // bundle: price of one set (document price basis: incl. VAT for a VAT shop)
  sku: z.string().trim().min(1).optional(), // bundle
  items: z.array(PromoItem).min(1),
  channels: z.array(PromoChannel).min(1).default(['pos']),
  start: IsoDate,
  end: IsoDate,
  draft: z.boolean().default(false),
  note: z.string().max(500).optional(),
  /** REQ-M15-03: a promo priced below cost needs the owner's PIN when it is saved (owner saving it confirms it). */
  belowCostApproval: Approval.optional(),
});
export type PromoInput = z.infer<typeof PromoInput>;
export const PromoUpdate = PromoInput.omit({ kind: true }).partial().extend({ belowCostApproval: Approval.optional() });

/** One product line of a promo as the promo screen shows it; cost fields are null without data.cost. */
export const PromoLine = z.object({
  productId: z.string(), name: z.string(), sku: z.string(), unitName: z.string(),
  qtyPerSet: Dec.nullable(), normalPrice: Dec, promoPrice: Dec.nullable(),
  unitCost: Dec.nullable(), belowCost: z.boolean(),
});
export const Promo = z.object({
  id: z.string(), code: z.string(), name: z.string(), kind: PromoKind, mode: PromoMode.nullable(), value: Dec.nullable(),
  setPrice: Dec.nullable(), normalSetPrice: Dec.nullable(), sku: z.string().nullable(),
  lines: z.array(PromoLine), channels: z.array(PromoChannel), start: z.string(), end: z.string(),
  status: z.enum(['draft', 'active', 'closed']), state: PromoStateZ,
  belowCost: z.boolean(), belowCostBy: z.string().nullable(),
  createdBy: z.string(), createdAt: z.string(), updatedBy: z.string().nullable(), updatedAt: z.string().nullable(),
  closedBy: z.string().nullable(), closedAt: z.string().nullable(),
  /** Bundles: whole sets the POS warehouse can make right now. */
  setsAvailable: z.number().int().nullable(),
  note: z.string().default(''),
  stats: z.object({ bills: z.number().int(), qty: Dec, sales: Dec }),
});
export type Promo = z.infer<typeof Promo>;
export const PromoListQuery = pageQuery.extend({ state: PromoStateZ.optional(), kind: PromoKind.optional() });
/** POST /api/promos/check: preview of below-cost lines and clashes, without saving. */
export const PromoCheck = z.object({ lines: z.array(PromoLine), belowCost: z.array(z.string()), clashes: z.array(z.object({ code: z.string(), name: z.string() })), normalSetPrice: Dec.nullable(), setCost: Dec.nullable() });

/** REQ-M11-07 / REQ-M15-05 promo P&L (data for group E's report). Money before VAT except `sales`. */
export const PromoPnlQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional(), promoId: z.string().optional() });
export const PromoPnlRow = z.object({
  promoId: z.string(), code: z.string(), name: z.string(), kind: PromoKind, state: PromoStateZ, start: z.string(), end: z.string(),
  bills: z.number().int(), sets: Dec, qty: Dec,
  /** Revenue incl. VAT as billed (net after bill discount). */
  sales: Dec, salesExVat: Dec,
  /** Normal price − promo price over the sold quantity (incl. VAT basis of the bill). */
  discount: Dec,
  cogs: Dec.nullable(), grossProfit: Dec.nullable(),
  /** Same-length period right before the promo started: sales and gross profit of the same products (comparison). */
  before: z.object({ from: z.string(), to: z.string(), qty: Dec, salesExVat: Dec, grossProfit: Dec.nullable() }),
});
export const PromoPnl = z.object({ items: z.array(PromoPnlRow) });

/** GET /api/pos/pricing: what the POS needs to price a cart (live promos, bundles, the customer's price lists). */
export const PosPricingQuery = z.object({ warehouseId: z.string().optional(), customerId: z.string().optional() });
export const PosPromo = z.object({ id: z.string(), code: z.string(), name: z.string(), mode: PromoMode, value: Dec, productIds: z.array(z.string()) });
export const PosBundle = z.object({
  id: z.string(), code: z.string(), name: z.string(), sku: z.string().nullable(), setPrice: Dec, normalSetPrice: Dec,
  components: z.array(z.object({ productId: z.string(), name: z.string(), unitName: z.string(), qtyPerSet: Dec, normalPrice: Dec })),
  setsAvailable: z.number().int(),
});
export const PosPriceEntry = z.object({ productId: z.string(), source: z.enum(['customer', 'group']), unitIdx: z.number().int(), minQty: Dec, price: Dec, listName: z.string() });
export const PosPricing = z.object({
  today: z.string(), promos: z.array(PosPromo), bundles: z.array(PosBundle),
  customer: z.object({ id: z.string(), name: z.string(), group: z.string() }).nullable(),
  prices: z.array(PosPriceEntry),
  /** productId → image version, for products with an uploaded image. */
  images: z.record(z.number().int()),
});
export type PosPricing = z.infer<typeof PosPricing>;

// ---------- BR-05 price lists ----------
export const CustomerGroupZ = z.enum(['retail', 'whole', 'contr']);
export const PriceListItemIn = z.object({ productId: z.string(), unitIdx: z.number().int().min(0).default(0), minQty: DecNN.default('0'), price: DecNN });
export const PriceListInput = z.object({
  name: z.string().trim().min(1),
  customerId: z.string().nullable().optional(),
  customerGroup: CustomerGroupZ.nullable().optional(),
  vatIncluded: z.boolean().default(true),
  validFrom: IsoDate.nullable().optional(),
  validTo: IsoDate.nullable().optional(),
  active: z.boolean().default(true),
  items: z.array(PriceListItemIn).default([]),
  note: z.string().max(500).optional(),
});
export const PriceListUpdate = PriceListInput.partial();
export const PriceListItem = PriceListItemIn.extend({ name: z.string(), sku: z.string(), unitName: z.string(), retailPrice: Dec });
export const PriceList = z.object({
  id: z.string(), name: z.string(), customer: z.object({ id: z.string(), name: z.string() }).nullable(), customerGroup: CustomerGroupZ.nullable(),
  vatIncluded: z.boolean(), validFrom: z.string().nullable(), validTo: z.string().nullable(), active: z.boolean(),
  itemCount: z.number().int(), items: z.array(PriceListItem).optional(), createdBy: z.string(), createdAt: z.string(),
  note: z.string().default(''),
});
export type PriceList = z.infer<typeof PriceList>;
export const PriceResolveQuery = z.object({ customerId: z.string().optional(), productId: z.string(), unitIdx: z.coerce.number().int().min(0).default(0), qty: Dec.default('1'), date: IsoDate.optional(), channel: PromoChannel.default('pos') });
export const PriceResolution = z.object({ unitPrice: Dec, source: z.enum(['quotation', 'customer', 'group', 'retail', 'promo']), promoId: z.string().nullable(), listPrice: Dec });

// ---------- REQ-M07-08 held bills ----------
export const HeldCartLine = z.object({ productId: z.string(), unitIdx: z.number().int().min(0), qty: z.string(), dval: z.string().default(''), dmode: z.enum(['amt', 'pct']).default('amt') });
export const HeldCart = z.object({
  lines: z.array(HeldCartLine).default([]),
  bundles: z.array(z.object({ promoId: z.string(), sets: z.string() })).default([]),
  billDiscount: z.string().default(''),
  customerId: z.string().nullable().default(null),
});
export const HoldReq = z.object({ shiftId: z.string(), label: z.string().trim().max(60).optional(), cart: HeldCart, total: DecNN });
export const HeldBill = z.object({
  id: z.string(), label: z.string(), customer: z.string().nullable(), itemCount: z.number().int(), total: Dec,
  status: z.enum(['held', 'resumed', 'discarded']), createdAt: z.string(), userName: z.string(), cart: HeldCart,
});
export type HeldBill = z.infer<typeof HeldBill>;
export const HeldListQuery = pageQuery.extend({ shiftId: z.string().optional() });

// ---------- REQ-M07-11 product images ----------
export const PRODUCT_IMAGE_MAX_BYTES = 262144;
export const ImageMime = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export const ProductImagePut = z.object({ mime: ImageMime, data: z.string().min(4).max(Math.ceil(PRODUCT_IMAGE_MAX_BYTES / 3) * 4 + 4) });
export const ProductImage = z.object({ productId: z.string(), mime: ImageMime, version: z.number().int(), bytes: z.number().int(), data: z.string() });
export const ProductImageInfo = ProductImage.omit({ data: true });

// ---------- REQ-M01-07 POS machines (POS ID from the Revenue Department) ----------
export const PosDeviceStatus = z.enum(['pending', 'approved', 'retired']);
export const PosDeviceInput = z.object({
  /** Device name the POS opens shifts on (shifts.deviceId), e.g. "POS-01". */
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(80),
  rdPosId: z.string().trim().max(40).nullable().optional(),
  approvedOn: IsoDate.nullable().optional(),
  status: PosDeviceStatus.default('pending'),
  note: z.string().max(200).default(''),
});
export const PosDeviceUpdate = PosDeviceInput.omit({ code: true }).partial();
export const PosDevice = z.object({
  id: z.string(), code: z.string(), name: z.string(), rdPosId: z.string().nullable(), approvedOn: z.string().nullable(), status: PosDeviceStatus,
  note: z.string(), canIssueAbb: z.boolean(), createdBy: z.string(), createdAt: z.string(), updatedBy: z.string().nullable(), updatedAt: z.string().nullable(),
});
export type PosDevice = z.infer<typeof PosDevice>;
export const PosDeviceListQuery = pageQuery.extend({ status: PosDeviceStatus.optional() });

// ---------- M16 production ----------
export const BomComponentIn = z.object({ productId: z.string(), qtyPerUnit: Dec });
export const BomInput = z.object({
  productId: z.string(), components: z.array(BomComponentIn).min(1),
  labourPerUnit: DecNN.default('0'), overheadPerUnit: DecNN.default('0'), note: z.string().default(''),
});
export const Bom = z.object({
  id: z.string(), productId: z.string(), productName: z.string(), unitName: z.string(), version: z.number().int(), active: z.boolean(),
  components: z.array(BomComponentIn.extend({ name: z.string(), unitName: z.string(), unitCost: Dec.nullable() })),
  labourPerUnit: Dec, overheadPerUnit: Dec, note: z.string(),
  /** Σ qty × current FIFO cost + labour + overhead; null without data.cost. */
  stdUnitCost: Dec.nullable(), price: Dec, createdBy: z.string(), createdAt: z.string(),
});
export type Bom = z.infer<typeof Bom>;
export const BomListQuery = pageQuery.extend({ productId: z.string().optional(), all: z.coerce.boolean().optional() });

export const MoSuggestReq = z.object({ productId: z.string(), planQty: Dec, issueWarehouseId: z.string() });
export const MoSuggestLine = z.object({ productId: z.string(), name: z.string(), unitName: z.string(), stdQty: Dec, available: Dec, estCost: Dec.nullable() });
export const MoSuggest = z.object({ bomId: z.string(), version: z.number().int(), labourPerUnit: Dec.nullable(), overheadPerUnit: Dec.nullable(), lines: z.array(MoSuggestLine) });
export const MoCreateReq = z.object({
  productId: z.string(), planQty: Dec, issueWarehouseId: z.string(), outputWarehouseId: z.string(),
  /** Editable issue qty per material (base units); omitted materials are issued at the BOM quantity. */
  issues: z.array(z.object({ productId: z.string(), qty: DecNN })).default([]),
  note: z.string().default(''),
});
export const MoOutputReq = z.object({ good: DecNN, reject: DecNN.default('0'), note: z.string().default('') });
export const MoCloseReq = z.object({
  /** Leftover materials sent back to the issue warehouse at their issued unit cost. */
  returns: z.array(z.object({ productId: z.string(), qty: DecNN })).default([]),
  labourPerUnit: DecNN.optional(), overheadPerUnit: DecNN.optional(),
});
export const MoCancelReq = z.object({ reason: z.string().trim().min(1) });
export const MoMaterial = z.object({
  productId: z.string(), name: z.string(), unitName: z.string(), stdQty: Dec, issueQty: Dec, returnedQty: Dec,
  cost: Dec.nullable(), returnedCost: Dec.nullable(), lots: z.array(z.object({ ref: z.string(), receivedAt: z.string(), qty: Dec, unitCost: Dec.nullable() })),
});
export const Mo = z.object({
  id: z.string(), no: z.string(), date: z.string(), productId: z.string(), productName: z.string(), unitName: z.string(), bomVersion: z.number().int(),
  planQty: Dec, issueWarehouse: z.object({ id: z.string(), name: z.string() }), outputWarehouse: z.object({ id: z.string(), name: z.string() }),
  status: z.enum(['wip', 'closed', 'cancelled']),
  materials: z.array(MoMaterial),
  outputs: z.array(z.object({ id: z.string(), good: Dec, reject: Dec, note: z.string(), by: z.string(), at: z.string() })),
  goodQty: Dec, rejectQty: Dec, yieldPct: Dec,
  labourPerUnit: Dec.nullable(), overheadPerUnit: Dec.nullable(),
  materialsCost: Dec.nullable(), labourCost: Dec.nullable(), overheadCost: Dec.nullable(), unitCost: Dec.nullable(),
  note: z.string(), createdBy: z.string(), createdAt: z.string(), closedBy: z.string().nullable(), closedAt: z.string().nullable(), cancelReason: z.string().nullable(),
});
export type Mo = z.infer<typeof Mo>;
export const MoSummary = Mo.pick({ id: true, no: true, date: true, productId: true, productName: true, unitName: true, planQty: true, status: true, goodQty: true, rejectQty: true, yieldPct: true, materialsCost: true, unitCost: true, createdBy: true, closedBy: true });
export const MoListQuery = pageQuery.extend({ status: z.enum(['wip', 'closed', 'cancelled']).optional() });
/** REQ-M16-04 per-MO report (BOM standard vs issued, yield, unit cost) for group E. */
export const MoReportQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional() });
export const MoReportRow = z.object({
  no: z.string(), date: z.string(), productName: z.string(), status: z.enum(['wip', 'closed', 'cancelled']), planQty: Dec, goodQty: Dec, rejectQty: Dec, yieldPct: Dec,
  materials: z.array(z.object({ name: z.string(), stdQty: Dec, usedQty: Dec, varianceQty: Dec, cost: Dec.nullable() })),
  stdUnitCost: Dec.nullable(), unitCost: Dec.nullable(),
});
export const MoReport = z.object({ items: z.array(MoReportRow) });

export const retailRoutes = {
  promos: 'GET /api/promos', promoCreate: 'POST /api/promos', promoCheck: 'POST /api/promos/check', promoPnl: 'GET /api/promos/pnl',
  promo: 'GET /api/promos/:id', promoUpdate: 'PATCH /api/promos/:id', promoClose: 'POST /api/promos/:id/close', promoActivate: 'POST /api/promos/:id/activate',
  posPricing: 'GET /api/pos/pricing',
  heldBills: 'GET /api/pos/held', heldCreate: 'POST /api/pos/held', heldResume: 'POST /api/pos/held/:id/resume', heldDiscard: 'POST /api/pos/held/:id/discard',
  priceLists: 'GET /api/price-lists', priceListCreate: 'POST /api/price-lists', priceResolve: 'GET /api/price-lists/resolve',
  priceList: 'GET /api/price-lists/:id', priceListUpdate: 'PATCH /api/price-lists/:id',
  productImages: 'GET /api/product-images', productImage: 'GET /api/product-images/:productId',
  productImagePut: 'POST /api/product-images/:productId', productImageRemove: 'POST /api/product-images/:productId/remove',
  posDevices: 'GET /api/pos-devices', posDeviceCreate: 'POST /api/pos-devices', posDeviceUpdate: 'PATCH /api/pos-devices/:id',
  boms: 'GET /api/boms', bomSave: 'POST /api/boms', bomActivate: 'POST /api/boms/:id/activate',
  mos: 'GET /api/mos', moSuggest: 'POST /api/mos/suggest', moCreate: 'POST /api/mos', moReport: 'GET /api/mos/report',
  mo: 'GET /api/mos/:no', moOutput: 'POST /api/mos/:no/outputs', moClose: 'POST /api/mos/:no/close', moCancel: 'POST /api/mos/:no/cancel',
} as const;

/** Routes registered on one edition only, e.g. { key: 'cloud' }. Unlisted routes must exist on both. */
export const retailRouteEditions: RouteEditions<typeof retailRoutes> = {};
