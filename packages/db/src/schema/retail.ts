/**
 * Drizzle table definitions for the "retail" module group (Agent C): M15 promotions, M16 production (BOM/MO),
 * held POS bills, customer price lists, product images. Created by migrations/0300_retail.sql; keep in sync.
 * The promo / bundle snapshot columns on doc_lines are declared with docLines in ./core.ts.
 */
import { bigint, boolean, customType, date, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, money, qty, tenantId } from './columns';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const retailPromos = pgTable('retail_promos', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** 'disc' | 'bundle' */
  kind: text('kind').notNull(),
  /** Discount promos: 'pct' | 'amt' (baht per base unit) | 'fixed' (promo price per base unit). */
  mode: text('mode'),
  value: qty('value'),
  /** Bundle: price of one set. */
  setPrice: money('set_price'),
  sku: text('sku'),
  /** [{ productId }] or, for bundles, [{ productId, qtyPerSet }]. */
  items: jsonb('items').notNull(),
  channels: text('channels').array().notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  /** 'draft' | 'active' | 'closed' */
  status: text('status').notNull().default('active'),
  /** REQ-M15-03: the owner confirmed a below-cost promo at creation. */
  belowCost: boolean('below_cost').notNull().default(false),
  belowCostBy: uuid('below_cost_by'),
  belowCostDetail: text('below_cost_detail'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const retailPriceLists = pgTable('retail_price_lists', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  customerId: uuid('customer_id'),
  customerGroup: text('customer_group'),
  vatIncluded: boolean('vat_included').notNull().default(true),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

export const retailPriceListItems = pgTable('retail_price_list_items', {
  id: id(),
  tenantId: tenantId(),
  listId: uuid('list_id').notNull(),
  productId: uuid('product_id').notNull(),
  unitIdx: integer('unit_idx').notNull().default(0),
  minQty: qty('min_qty').notNull().default('0'),
  price: money('price').notNull(),
  active: boolean('active').notNull().default(true),
});

export const retailHeldBills = pgTable('retail_held_bills', {
  id: id(),
  tenantId: tenantId(),
  shiftId: uuid('shift_id').notNull(),
  deviceId: text('device_id').notNull(),
  userId: uuid('user_id').notNull(),
  label: text('label').notNull(),
  customerId: uuid('customer_id'),
  cart: jsonb('cart').notNull(),
  itemCount: integer('item_count').notNull(),
  total: money('total').notNull(),
  /** 'held' | 'resumed' | 'discarded' */
  status: text('status').notNull().default('held'),
  createdAt: createdAt(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
});

export const retailProductImages = pgTable('retail_product_images', {
  productId: uuid('product_id').primaryKey(),
  tenantId: tenantId(),
  mime: text('mime').notNull(),
  data: bytea('data'),
  bytes: integer('bytes').notNull().default(0),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const retailBoms = pgTable('retail_boms', {
  id: id(),
  tenantId: tenantId(),
  productId: uuid('product_id').notNull(),
  version: integer('version').notNull(),
  /** [{ productId, qtyPerUnit }] */
  components: jsonb('components').notNull(),
  labourPerUnit: qty('labour_per_unit').notNull().default('0'),
  overheadPerUnit: qty('overhead_per_unit').notNull().default('0'),
  note: text('note').notNull().default(''),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

export const retailMos = pgTable('retail_mos', {
  id: id(),
  tenantId: tenantId(),
  no: text('no').notNull(),
  date: date('date').notNull(),
  productId: uuid('product_id').notNull(),
  bomId: uuid('bom_id').notNull(),
  planQty: qty('plan_qty').notNull(),
  issueWh: uuid('issue_wh').notNull(),
  outputWh: uuid('output_wh').notNull(),
  /** 'wip' | 'closed' | 'cancelled' */
  status: text('status').notNull().default('wip'),
  labourPerUnit: qty('labour_per_unit').notNull().default('0'),
  overheadPerUnit: qty('overhead_per_unit').notNull().default('0'),
  materialsCost: money('materials_cost').notNull().default('0'),
  returnedCost: money('returned_cost').notNull().default('0'),
  labourCost: money('labour_cost'),
  overheadCost: money('overhead_cost'),
  goodQty: qty('good_qty').notNull().default('0'),
  rejectQty: qty('reject_qty').notNull().default('0'),
  unitCost: qty('unit_cost'),
  lotId: bigint('lot_id', { mode: 'number' }),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  closedBy: uuid('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
});

export const retailMoMaterials = pgTable('retail_mo_materials', {
  id: id(),
  tenantId: tenantId(),
  moId: uuid('mo_id').notNull(),
  lineNo: integer('line_no').notNull(),
  productId: uuid('product_id').notNull(),
  stdQty: qty('std_qty').notNull(),
  issueQty: qty('issue_qty').notNull(),
  cost: money('cost').notNull().default('0'),
  returnedQty: qty('returned_qty').notNull().default('0'),
  returnedCost: money('returned_cost').notNull().default('0'),
});

export const retailMoOutputs = pgTable('retail_mo_outputs', {
  id: id(),
  tenantId: tenantId(),
  moId: uuid('mo_id').notNull(),
  goodQty: qty('good_qty').notNull(),
  rejectQty: qty('reject_qty').notNull().default('0'),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

export const retailPosDevices = pgTable('retail_pos_devices', {
  id: id(),
  tenantId: tenantId(),
  /** Device name a shift is opened on (shifts.device_id). */
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** POS ID issued by the Revenue Department (ภ.พ.06). */
  rdPosId: text('rd_pos_id'),
  approvedOn: date('approved_on'),
  /** 'pending' | 'approved' | 'retired' */
  status: text('status').notNull().default('pending'),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});
