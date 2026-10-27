# SCG Family Integration Spec (M13)

สถานะ: **Draft v0.1 (2026-10-27)** · Cloud edition เท่านั้น (OQ-A2) · ยังไม่เชื่อมจริง
อ่านคู่กับ: [`README.md`](README.md) (auth, idempotency, retry, signature, error format, PDPA), [`openapi/scgfamily.yaml`](openapi/scgfamily.yaml), [`schemas/scgfamily/`](schemas/scgfamily/)

SCG Family คือแอปสมาชิก/คูปอง/คะแนนของ SCG สำหรับช่างและเจ้าของบ้าน ERP ใช้ที่หน้า POS (และใบขายเงินสดเต็มรูป) เพื่อ:

| REQ / Rule | เรื่อง | ทิศทาง | Realtime? |
|---|---|---|---|
| M13 (member) | ค้นสมาชิกด้วย SCG Family ID / เบอร์โทร / QR | ERP → SF | ใช่ (3 s) |
| M13 (coupon) | ดึงคูปองของสมาชิก + ให้ SF ตรวจเงื่อนไขกับตะกร้า | ERP → SF | ใช่ (3 s) |
| M13 (coupon) | จองคูปองเมื่อเลือก | ERP → SF | ใช่ (3 s) |
| M13 + BR-11 | ตัดคูปองตอนปิดบิล (dedupe: เลขบิล + รหัสคูปอง) | ERP → SF | ใช่ (3 s) |
| M13 | คืนสิทธิ์: เอาคูปองออก / พักบิลหมดเวลา / void | ERP → SF | async |
| OQ-02 (ตอบแล้ว) | คืนสินค้าบางส่วน **ไม่** ยกเลิกคูปอง | — | — |
| OQ-01 (ตอบแล้ว) | การเบิกคืนค่าคูปองให้ร้าน SCG Family ทำนอกระบบเรา | — | — |
| REQ-M11-05 | รายงานการใช้คูปอง (ใน ERP) | ERP internal | — |
| REQ-M13-07 | Reconciliation รายวัน | SF → ERP (และ ERP → SF) | batch |
| BR-12 | ส่งบิลที่มีสมาชิกเพื่อคิดคะแนน รายวัน; SF map สินค้าที่ได้คะแนนเอง | ERP → SF | batch |

---

## 1. Endpoint list

### 1.1 SCG Family จัดให้ (ERP เรียก) — proposed

| Method | Path | Scope | Timeout ERP |
|---|---|---|---|
| POST | `/oauth2/token` | — | 3 s (cache token) |
| POST | `/v1/members/lookup` | `sf.members.read` | 3 s |
| POST | `/v1/members/{memberId}/coupons/evaluate` | `sf.coupons.evaluate` | 3 s |
| POST | `/v1/coupon-reservations` | `sf.coupons.redeem` | 3 s |
| POST | `/v1/coupon-reservations/{reservationId}/redeem` | `sf.coupons.redeem` | 3 s |
| POST | `/v1/coupon-reservations/{reservationId}/release` | `sf.coupons.redeem` | async, 10 s |
| POST | `/v1/redemptions/{redemptionId}/reverse` | `sf.coupons.redeem` | async, 10 s |
| GET | `/v1/redemptions?shop_id=&date=&idempotency_key=&cursor=` | `sf.reconciliation.read` | batch, 30 s |
| POST | `/v1/points/batches` | `sf.points.write` | batch, 60 s |
| GET | `/v1/points/batches/{batchId}` | `sf.points.write` | batch |

### 1.2 ERP จัดให้ (SCG Family เรียก)

| Method | Path | Scope | ใช้ใน |
|---|---|---|---|
| GET | `/partner/scgfamily/v1/coupon-usages?shop_id=&date=&cursor=` | `erp.partner.reconciliation.read` | REQ-M13-07 |
| POST | `/hooks/scgfamily/v1/events` | HMAC signature | `points.batch.completed`, `member.erased` (เสนอ) |

### 1.3 ERP internal (web ↔ server) — เสนอเพิ่มใน `packages/contracts`

| Method | Path | หมายเหตุ |
|---|---|---|
| POST | `/api/scgfamily/members/lookup` | proxy + mask; ไม่บันทึกชื่อ/เบอร์ |
| POST | `/api/scgfamily/coupons/evaluate` | ERP สร้าง cart payload จากตะกร้า POS |
| POST | `/api/scgfamily/coupons/reserve` / `release` | |
| POST | `/api/sales/pos` | มีแล้ว — **เพิ่ม** `member` และ `coupon` ใน `PosSaleReq` (§6.1) |
| GET | `/api/reports/coupon-usage?from=&to=` | REQ-M11-05 (CSV/XLSX export) |

---

## 2. Identifiers

| แนวคิด | SCG Family | ERP |
|---|---|---|
| ร้าน | `shop_id` เช่น `SFM-CM-00871` | `tenant_integrations(provider='scgfamily', external_id)` (ใหม่); mockup ตั้งค่าร้าน "รหัสร้านค้า SCG Family" |
| สมาชิก | `member_id` เช่น `SF22018834` | `docs.member_id` (มีแล้ว) |
| คูปอง | `coupon_code` เช่น `SFC-100-1K` | `coupon_redemptions.coupon_code` (ใหม่) |
| การจอง | `reservation_id` | `coupon_redemptions.reservation_id` |
| การตัดใช้ | `redemption_id` | `coupon_redemptions.redemption_id` |
| บิล | `bill_no` = `SalesDoc.no` เช่น `ABB2610-0233` | `docs.no` |
| สินค้า SCG | `scg_code` (รหัสเดียวกับ Prompt Plus — SF-Q04) | `products.scg_code` (ใหม่), `products.is_scg` |

ตารางใหม่ที่เสนอ `coupon_redemptions`: `tenant_id`, `doc_id`, `bill_no`, `member_id`, `coupon_code`, `title`, `reservation_id`, `redemption_id`, `amount`, `status` (`reserved|redeemed|released|reversed|reverse_pending|unknown`), `idempotency_key`, timestamps — **unique `(tenant_id, bill_no, coupon_code)` (BR-11)**; และ `docs.coupon_amount` (ใหม่) เก็บยอดคูปองที่ใช้จริง (`DocTotals.coupon`)

---

## 3. ค้นสมาชิก (member lookup)

**ทิศทาง:** ERP → SF · **Trigger:** แคชเชียร์สแกน QR จากแอป, กรอกรหัส SCG Family หรือเบอร์โทร แล้วกด "ตรวจสอบ"

### 3.1 `POST /v1/members/lookup`
ใช้ POST เพื่อไม่ให้เบอร์โทร/QR token อยู่ใน URL และ access log

```json
{ "shop_id": "SFM-CM-00871", "by": "sf_id", "value": "SF22018834" }
```
```json
{ "shop_id": "SFM-CM-00871", "by": "phone", "value": "0812345678" }
```
```json
{ "shop_id": "SFM-CM-00871", "by": "qr", "value": "sfqr.eyJtIjoiU0YyMjAxODgzNCIsImV4cCI6MTc2MTUyODE4MH0.Xc9..." }
```

Response `200`:
```json
{
  "member_id": "SF22018834",
  "display_name": "ช่างสมชาย ใ.",
  "member_type": "contractor",
  "member_type_label": "ช่าง",
  "tier": "Gold",
  "status": "active",
  "phone_masked": "081-xxx-5678",
  "coupon_count": 3
}
```

ERP แสดง `✓ ช่างสมชาย ใ. · ช่าง · Gold · SF22018834` (ชื่อ mask บางส่วนตามที่ SF ส่งมา) และ **เก็บเฉพาะ `member_id`** ลงบิล

### 3.2 Errors

| HTTP | `code` | POS แสดง |
|---|---|---|
| 404 | `MEMBER_NOT_FOUND` | "ไม่พบรหัสสมาชิก SF2201883 ตรวจสอบตัวเลขอีกครั้ง หรือให้ลูกค้าเปิดบัตรในแอป SCG Family" |
| 409 | `PHONE_AMBIGUOUS` | "เบอร์นี้มีหลายบัญชี ให้ลูกค้าสแกน QR แทน" |
| 410 | `QR_EXPIRED` | "QR หมดอายุ ให้ลูกค้ากดรีเฟรชในแอป" |
| 422 | `MEMBER_INACTIVE` | "บัญชีสมาชิกถูกระงับ" |
| timeout 3 s / 5xx / circuit open | — | "ระบบ SCG Family ไม่ตอบภายใน 3 วินาที ขายต่อได้ ระบบจะเก็บรหัส … ไว้ส่งให้ภายหลัง" → บิลเก็บ `member_id` แบบ **ยังไม่ยืนยัน** (`member_verified = false`) เพื่อส่งใน points batch; ใช้คูปองไม่ได้ |

### 3.3 Acceptance tests
- **AT-SF-01** กรอก `SF22018834` → แสดงสมาชิก Gold, คูปอง 3 ใบ ภายใน 3 วินาที
- **AT-SF-02** สแกน QR ที่หมดอายุ → `QR_EXPIRED`
- **AT-SF-03** SF ไม่ตอบ (sandbox delay 5 s) → POS แสดงข้อความภายใน 3 วินาที ขายต่อได้ บิลมี `member_id` ยังไม่ยืนยัน และอยู่ใน points batch คืนนั้นพร้อม `member_verified: false`
- **AT-SF-04** ตรวจ DB/log: ไม่มีชื่อ เบอร์โทร หรือ QR token ถูกบันทึก

---

## 4. ดึงคูปองพร้อมตรวจเงื่อนไข (evaluate)

**ทิศทาง:** ERP → SF · **Trigger:** กด "ใช้คูปองส่วนลด" (มีสมาชิกและมีสินค้าในตะกร้า) · **หลักการ:** เงื่อนไขและมูลค่าคูปอง **SF เป็นผู้คำนวณ** ERP ไม่ hard-code กฎคูปอง

### 4.1 `POST /v1/members/{memberId}/coupons/evaluate`

```json
{
  "shop_id": "SFM-CM-00871",
  "cart_id": "c2b8f9a4-3e1d-4f6a-9b0c-7d5e2a1f8c33",
  "currency": "THB",
  "vat_mode": "inc",
  "lines": [
    { "line_no": 1, "sku": "SCG-CEM-T50", "scg_code": "SCG-CEM-T50", "is_scg": true, "name": "ปูนซีเมนต์ตราเสือ 50 กก.", "category": "ปูนซีเมนต์", "qty": "20", "unit_name": "ถุง", "base_qty": "20", "unit_price": "145.00", "line_discount": "0.00", "line_net": "2900.00", "vat": "v7" },
    { "line_no": 2, "sku": "SCG-ADH-20", "scg_code": "SCG-ADH-20", "is_scg": true, "name": "กาวซีเมนต์ปูกระเบื้อง 20 กก.", "category": "กาว/ยาแนว", "qty": "2", "unit_name": "ถุง", "base_qty": "2", "unit_price": "199.50", "line_discount": "0.00", "line_net": "399.00", "vat": "v7" },
    { "line_no": 3, "sku": "TP-PVC-05", "scg_code": null, "is_scg": false, "name": "ท่อ PVC 1/2 นิ้ว ชั้น 8.5", "category": "ประปา", "qty": "10", "unit_name": "เส้น", "base_qty": "10", "unit_price": "38.00", "line_discount": "0.00", "line_net": "380.00", "vat": "v7" }
  ],
  "totals": { "gross": "3679.00", "line_discount": "0.00", "sub": "3679.00", "shop_bill_discount": "0.00" }
}
```

- `line_net` = หลังส่วนลดรายการ ก่อนส่วนลดท้ายบิลและคูปอง (ตรง `core.lineNet`); `sub` = Σ `line_net`
- ราคาเป็นราคาตาม `vat_mode` ของบิล (`inc` = รวม VAT)
- `shop_bill_discount` ส่งเพื่อข้อมูล — ใน ERP คูปองถูกหักก่อนส่วนลดท้ายบิล (`core.calcDoc`: คูปองไม่เกิน `sub`, ส่วนลดท้ายบิลไม่เกิน `sub − coupon`) — SF-Q04

Response `200`:
```json
{
  "member_id": "SF22018834",
  "max_coupons_per_bill": 1,
  "coupons": [
    { "coupon_code": "SFC-100-1K", "title": "ลด 100 บาท", "conditions_text": "ซื้อสินค้า SCG ร่วมรายการครบ 1,000 บาท", "expires_at": "2026-11-30T23:59:59+07:00", "eligible": true, "discount_amount": "100.00", "applies_to_lines": [1, 2], "ineligible_code": null, "ineligible_message": null },
    { "coupon_code": "SFC-T50-5", "title": "ลด 5% ปูนตราเสือ", "conditions_text": "มีปูนตราเสือในบิล ลดสูงสุด 200 บาท", "expires_at": "2026-10-31T23:59:59+07:00", "eligible": true, "discount_amount": "145.00", "applies_to_lines": [1], "ineligible_code": null, "ineligible_message": null },
    { "coupon_code": "SFC-300-5K", "title": "ลด 300 บาท", "conditions_text": "ยอดสินค้า SCG ร่วมรายการครบ 5,000 บาท", "expires_at": "2026-12-31T23:59:59+07:00", "eligible": false, "discount_amount": "0.00", "applies_to_lines": [], "ineligible_code": "MIN_SPEND_NOT_MET", "ineligible_message": "ยอดสินค้า SCG ร่วมรายการ 3,299.00 บาท ยังไม่ถึง 5,000 บาท" }
  ]
}
```

POS แสดงรายการ: คูปองที่ `eligible` มีปุ่ม "ใช้ −100.00", ที่ไม่ผ่านแสดง `ineligible_message` และปุ่มถูกปิด (ตาม mockup)

### 4.2 Acceptance tests
- **AT-SF-10** ตะกร้าข้างบน → `SFC-100-1K` eligible 100.00, `SFC-300-5K` ไม่ผ่านพร้อมเหตุผล
- **AT-SF-11** SF ไม่ตอบใน 3 วินาที → "ใช้คูปองไม่ได้ตอนนี้ ปิดบิลต่อได้โดยไม่ใช้คูปอง"
- **AT-SF-12** ERP ไม่คำนวณมูลค่าคูปองเอง — ใช้ `discount_amount` จาก SF เท่านั้น

---

## 5. จองคูปอง (reserve)

**Trigger:** แคชเชียร์เลือกคูปอง 1 ใบ

### 5.1 `POST /v1/coupon-reservations`
Header `Idempotency-Key: erp:SFM-CM-00871:reserve:c2b8f9a4-3e1d-4f6a-9b0c-7d5e2a1f8c33:SFC-100-1K`

```json
{
  "shop_id": "SFM-CM-00871",
  "member_id": "SF22018834",
  "coupon_code": "SFC-100-1K",
  "cart_id": "c2b8f9a4-3e1d-4f6a-9b0c-7d5e2a1f8c33",
  "cart": { "lines": [ "… เหมือน evaluate …" ], "totals": { "sub": "3679.00", "shop_bill_discount": "0.00" } },
  "terminal_id": "POS-01",
  "cashier_ref": "u-prae"
}
```
Response `201`:
```json
{ "reservation_id": "rsv_01JBE2M4P6R8T0V2X4Z6B8D0F2", "coupon_code": "SFC-100-1K", "discount_amount": "100.00", "expires_at": "2026-10-27T11:12:00+07:00" }
```

- อายุ reservation ฝั่ง SF (safety net) เสนอ 60 นาที (SF-Q05) — ERP ปล่อยเองก่อนเสมอตาม §8
- ตะกร้าเปลี่ยนหลังจอง (เพิ่ม/ลดสินค้า) → ERP เรียก evaluate ใหม่ (ไม่ต้องจองใหม่) และใช้ `discount_amount` ล่าสุด; ตอน redeem SF คำนวณจาก cart สุดท้ายอีกครั้ง
- 1 บิลใช้ได้ 1 ใบ (mockup) — เลือกใบใหม่ = release ใบเดิมก่อน

### 5.2 Errors
| HTTP | `code` | POS |
|---|---|---|
| 409 | `COUPON_ALREADY_RESERVED` (`details.terminal_id`) | "คูปองนี้ถูกจองที่เครื่องอื่น" |
| 410 | `COUPON_ALREADY_USED`, `COUPON_EXPIRED` | เอาออกจากรายการ |
| 422 | `COUPON_NOT_ELIGIBLE`, `ONE_COUPON_PER_BILL` | แสดง `message` |
| timeout | — | ไม่ใส่คูปอง; ERP ส่ง release ด้วย key เดียวกันแบบ async (ถ้าจองสำเร็จจริงจะถูกปล่อย) |

---

## 6. ตัดคูปองตอนปิดบิล (redeem) — BR-11

**หลัก:** ตัดจริงแบบ realtime ตอนปิดบิล; **ถ้าตัดไม่สำเร็จ บิลจะไม่ถูกปิดพร้อมส่วนลดคูปองนั้น**

### 6.1 ส่วนขยาย `PosSaleReq` (เสนอ)

```json
{
  "idempotencyKey": "9a7d3f52-6c1b-4e0a-8f2d-1b3c5e7a9d04",
  "shiftId": "…", "warehouseId": "…", "docKind": "abb",
  "lines": [ "…" ],
  "billDiscount": "0",
  "payments": [ { "method": "cash", "amount": "3579.00" } ],
  "member": { "memberId": "SF22018834", "verified": true },
  "coupon": { "reservationId": "rsv_01JBE2M4P6R8T0V2X4Z6B8D0F2", "code": "SFC-100-1K", "expectedAmount": "100.00" }
}
```

### 6.2 ลำดับใน server (`POST /api/sales/pos`)
1. เปิด transaction ตามปกติ, ตรวจ shift/stock/below-cost (BR-16 **ไม่รวม** คูปอง — `core.netUnitPricesExVat`)
2. คำนวณ `calcDoc(lines, vatMode, billDiscount, coupon = expectedAmount)` และตรวจ `payments` = total
3. ออกเลขบิล (BR-04) เช่น `ABB2610-0233`
4. เรียก `POST /v1/coupon-reservations/{reservationId}/redeem` (timeout 3 s) ด้วย `Idempotency-Key: SFM-CM-00871:ABB2610-0233:SFC-100-1K`
5. สำเร็จ และ `discount_amount == expectedAmount` → insert `coupon_redemptions` (unique `tenant + bill_no + coupon_code`) แล้ว COMMIT
6. ไม่สำเร็จ / timeout / ยอดไม่ตรง → **ROLLBACK ทั้งบิล** (เลขบิลไม่หายเพราะ counter rollback ด้วย — BR-04) แล้วตอบ `409` ให้ POS:
   - `code: CONFLICT`, `details.reason: COUPON_REDEEM_FAILED | COUPON_AMOUNT_CHANGED | COUPON_TIMEOUT`, `details.newAmount` (ถ้ามี)
   - POS ให้เลือก: **"ลองอีกครั้ง"** (ส่งซ้ำด้วย idempotencyKey เดิม) หรือ **"ปิดบิลโดยไม่ใช้คูปอง"** (ERP release reservation แบบ async แล้วปิดบิลใหม่ไม่มีคูปอง)
7. Replay ของ `POST /api/sales/pos` ด้วย idempotencyKey เดิมหลัง COMMIT → คืนบิลเดิม ไม่เรียก SF ซ้ำ

**กรณี timeout แต่ SF ตัดสำเร็จจริง:** การลองใหม่ด้วยเลขบิลเดิม + คูปองเดิม + reservation เดิม จะได้ผลเดิมจาก SF (idempotent) ถ้าแคชเชียร์เลือกปิดโดยไม่ใช้คูปอง ERP มี job ถามสถานะด้วย `GET /v1/redemptions?idempotency_key=…` แล้ว `reverse` ภายใน 15 นาที และ reconciliation รายวันจับกรณีที่หลุด ถ้าเลขบิลเดียวกันถูกใช้กับตะกร้าอื่น body hash จะต่าง → SF ตอบ `409 IDEMPOTENCY_KEY_REUSED` ซึ่งไม่ตัดซ้ำ

> ERP-Q01: ขั้นตอน 4 ล็อกแถว `doc_counters` ไว้นานสุด 3 วินาที (บิลอื่นของร้านเดียวกันต้องรอ) — ยอมรับได้สำหรับร้านขนาดนี้ ถ้าไม่ได้ ให้เปลี่ยนเป็น redeem ด้วย `idempotencyKey` ของ POS ก่อนออกเลข แล้ว `PATCH` เลขบิลภายหลัง (ต้องให้ SF ยอมรับ key แบบอื่นนอกจาก BR-11)

### 6.3 `POST /v1/coupon-reservations/{reservationId}/redeem`

```json
{
  "shop_id": "SFM-CM-00871",
  "member_id": "SF22018834",
  "coupon_code": "SFC-100-1K",
  "bill_no": "ABB2610-0233",
  "bill_type": "ABB",
  "bill_closed_at": "2026-10-27T10:20:45+07:00",
  "expected_discount_amount": "100.00",
  "cart": {
    "lines": [ "… เหมือน evaluate …" ],
    "totals": { "gross": "3679.00", "line_discount": "0.00", "sub": "3679.00", "shop_bill_discount": "0.00", "coupon": "100.00", "total": "3579.00", "vat": "234.14" }
  }
}
```
Response `200`:
```json
{ "redemption_id": "rdm_01JBE2Q8S0U2W4Y6A8C0E2G4J6", "coupon_code": "SFC-100-1K", "bill_no": "ABB2610-0233", "discount_amount": "100.00", "redeemed_at": "2026-10-27T10:20:46+07:00" }
```

Errors: `409 COUPON_AMOUNT_CHANGED` (`details.discount_amount`), `410 RESERVATION_EXPIRED`, `410 COUPON_ALREADY_USED`, `422 COUPON_NOT_ELIGIBLE` (ตะกร้าสุดท้ายไม่ผ่านแล้ว), `409 IDEMPOTENCY_KEY_REUSED`

### 6.4 Acceptance tests
- **AT-SF-20** ปิดบิลพร้อม `SFC-100-1K` → บิล `ABB2610-0233` total 3,579.00, `coupon_redemptions` 1 แถว status `redeemed`, mock SF ได้ redeem 1 ครั้งด้วย key `SFM-CM-00871:ABB2610-0233:SFC-100-1K`
- **AT-SF-21** SF ตอบ `410 COUPON_ALREADY_USED` → ไม่มีบิล, ไม่มีสต็อกออก, เลข `ABB2610-0233` ยังว่างให้บิลถัดไป (BR-04)
- **AT-SF-22** SF timeout → ไม่มีบิล; เลือก "ปิดบิลโดยไม่ใช้คูปอง" → บิลใหม่ total 3,679.00 ไม่มีคูปอง; job พบว่า SF ตัดไปแล้ว → reverse; reconciliation วันถัดไปไม่พบส่วนต่าง
- **AT-SF-23** ส่ง redeem ซ้ำ key เดิม body เดิม → SF ตอบ redemption เดิม; DB มีแถวเดียว (BR-11 unique)
- **AT-SF-24** POS ส่ง `POST /api/sales/pos` ซ้ำหลัง COMMIT → 200 replay, SF ไม่ถูกเรียกอีก
- **AT-SF-25** `COUPON_AMOUNT_CHANGED` (ตะกร้าลดลงจนลดได้ 50) → POS แสดงยอดใหม่ ให้ยืนยันก่อนปิด

---

## 7. คูปองบนใบกำกับภาษี / ใบเสร็จ

ตามที่ระบบคำนวณอยู่ใน `packages/core/src/vat.ts` (`calcDoc`):
- คูปองแสดง **แยกบรรทัด** จากส่วนลดของร้าน: `คูปอง SCG Family SFC-100-1K  −100.00` (ต่อจาก "ส่วนลดรายการ" และ "ส่วนลดท้ายบิล") ใบเสร็จ/ABB ท้ายบิลแสดง `สมาชิก SCG Family SF22018834`
- คูปองถูกหักก่อนส่วนลดท้ายบิล (คูปอง ≤ `sub`, ส่วนลดท้ายบิล ≤ `sub − คูปอง`) และ **กระจายตามสัดส่วนลงทุกบรรทัด → ลดฐาน VAT** (`base7`)
- BR-16 ราคาต่ำกว่าทุน **ไม่นับคูปอง** (`core.netUnitPricesExVat`) — คูปองเป็นต้นทุนของ SCG Family ไม่ใช่ของร้าน
- บัญชี: ผังบัญชีใน mockup มี "ส่วนลดคูปอง SCG Family" `410901`

ตัวอย่าง (`vat_mode = inc`) — ปูน 20 × 145.00 + กาว 2 × 199.50 + ท่อ PVC 10 × 38.00:

| รายการ | จำนวนเงิน |
|---|---|
| รวมเป็นเงิน | 3,679.00 |
| คูปอง SCG Family SFC-100-1K | −100.00 |
| ราคาหลังหักส่วนลด | 3,579.00 |
| มูลค่าที่คำนวณภาษี 7% | 3,344.86 |
| ภาษีมูลค่าเพิ่ม 7% | 234.14 |
| **รวมทั้งสิ้น** | **3,579.00** |

> **ต้องยืนยันกับทีมภาษี SCG (TX-Q01/Q02/Q03):** เนื่องจาก SCG Family เบิกคืนค่าคูปองให้ร้าน คูปองอาจต้องถือเป็น "วิธีชำระเงิน/เงินที่ได้รับจากบุคคลที่สาม" ซึ่ง **ไม่ลดฐาน VAT** (ร้านต้องออก VAT เต็ม 3,679.00) ถ้าทีมภาษีตัดสินแบบนั้น ERP ต้องเปลี่ยน `calcDoc` ให้คูปองเป็น payment method `scgfamily_coupon` แทน — mockup มีคำเตือนนี้อยู่แล้ว ("การแสดงคูปองในใบกำกับภาษี (เป็นส่วนลดหรือวิธีชำระ) รอทีมภาษียืนยัน")

---

## 8. คืนสิทธิ์คูปอง (release / reverse)

| เหตุการณ์ | ก่อน redeem (มี reservation) | หลัง redeem (บิลปิดแล้ว) |
|---|---|---|
| แคชเชียร์กด "เอาออก" | `release` reason `removed` | — |
| เปลี่ยนสมาชิก / ล้างตะกร้า | `release` reason `member_changed` / `cart_cleared` | — |
| พักบิล (held bill) เกินเวลา | `release` reason `held_timeout` — ERP ตั้งค่าเริ่มต้น 30 นาที (ตั้งได้ ≤ อายุ reservation ของ SF) | — |
| ปิดกะทั้งที่มีบิลพัก | `release` reason `shift_closed` | — |
| redeem ล้มเหลวแล้วปิดบิลโดยไม่ใช้คูปอง | `release` reason `redeem_aborted` | — |
| **Void บิล** (`POST /api/sales/docs/:no/void`) | — | `reverse` reason `bill_void` — void ใน ERP สำเร็จเสมอ, reverse ส่งแบบ async พร้อม retry 72 ชม. (status `reverse_pending` จนสำเร็จ) |
| **คืนสินค้าบางส่วน** (CN) | — | **ไม่คืนสิทธิ์** (OQ-02) — ยอดคืนเงินคิดจาก `doc_lines.net_after_bill` ซึ่งหักส่วนแบ่งคูปองแล้ว; รายการ CN ส่งใน points batch เป็นค่าติดลบ |
| คืนสินค้าทั้งบิล (CN ครบทุกรายการ) | — | เสนอ: ไม่คืนสิทธิ์ (สอดคล้อง OQ-02) — รอ SF-Q06 |

### 8.1 `POST /v1/coupon-reservations/{reservationId}/release`
Header `Idempotency-Key: erp:SFM-CM-00871:release:rsv_01JBE2M4P6R8T0V2X4Z6B8D0F2`
```json
{ "shop_id": "SFM-CM-00871", "reason": "held_timeout" }
```
Response `200` `{ "reservation_id": "rsv_01JBE2M4P6R8T0V2X4Z6B8D0F2", "status": "released" }` — release ซ้ำหรือ reservation หมดอายุแล้วก็ตอบ 200 (idempotent)

### 8.2 `POST /v1/redemptions/{redemptionId}/reverse`
Header `Idempotency-Key: erp:SFM-CM-00871:reverse:rdm_01JBE2Q8S0U2W4Y6A8C0E2G4J6`
```json
{ "shop_id": "SFM-CM-00871", "bill_no": "ABB2610-0233", "reason": "bill_void", "voided_at": "2026-10-27T14:02:00+07:00" }
```
Response `200` `{ "redemption_id": "rdm_01JBE2Q8S0U2W4Y6A8C0E2G4J6", "status": "reversed", "coupon_status": "available" }` · Error `422 REDEMPTION_NOT_REVERSIBLE` (เช่น เลยรอบเบิกคืนไปแล้ว) → ERP แสดงในรายงานให้ร้าน/SF จัดการนอกระบบ

### 8.3 Acceptance tests
- **AT-SF-30** เลือกคูปองแล้วกด "เอาออก" → SF ได้ release 1 ครั้ง
- **AT-SF-31** พักบิลที่มีคูปอง 31 นาที → release `held_timeout`; เรียกบิลคืน → ต้องเลือกคูปองใหม่
- **AT-SF-32** void `ABB2610-0233` → บิล void ทันที; SF ได้ reverse; ถ้า SF ล่ม status `reverse_pending` และ retry จนสำเร็จ
- **AT-SF-33** คืนปูน 5 ถุงจากบิลที่ใช้คูปอง → ไม่มี release/reverse; คืนเงิน = net หลังหักส่วนแบ่งคูปอง; คืนนั้น points batch มีรายการ CN ติดลบ

---

## 9. คะแนนสะสมรายวัน (points batch) — BR-12

**ทิศทาง:** ERP → SF · **Trigger:** ทุกวัน 01:00 (Asia/Bangkok) สำหรับวันทำการก่อนหน้า · **หลัก:** ERP ส่ง **ทุกรายการ** ของบิลที่มีสมาชิก SF เป็นผู้ตัดสินว่าสินค้าใดได้คะแนนและได้เท่าไร (ERP ไม่เก็บกฎคะแนน)

รวมในแต่ละ batch:
- บิล `ABB`/`INV`/`RC` ที่มี `member_id` (รวมที่ยังไม่ยืนยันตอน SF ล่ม — `member_verified: false`)
- `CN` ที่อ้างอิงบิลที่มีสมาชิก → `kind: "return"` จำนวน/ยอดติดลบ
- บิลที่ void หลังจากถูกส่งไปแล้วใน batch ก่อน → `kind: "void"`
- บิลที่สร้างและ void ในวันเดียวกัน → ไม่ส่ง

### 9.1 `POST /v1/points/batches`
Header `Idempotency-Key: SFM-CM-00871:2026-10-26:1`
```json
{
  "batch_id": "SFM-CM-00871-2026-10-26",
  "shop_id": "SFM-CM-00871",
  "business_date": "2026-10-26",
  "chunk_no": 1,
  "chunk_count": 1,
  "bills": [
    {
      "bill_no": "ABB2610-0232",
      "kind": "sale",
      "bill_type": "ABB",
      "ref_bill_no": null,
      "closed_at": "2026-10-26T15:31:02+07:00",
      "member_id": "SF22018834",
      "member_verified": true,
      "coupon_code": "SFC-100-1K",
      "total": "7860.00",
      "lines": [
        { "line_no": 1, "sku": "SCG-ROOF-DL-GY", "scg_code": "SCG-ROOF-DL-GY", "is_scg": true, "name": "กระเบื้องหลังคาลอนคู่ 50×120 ซม. สีเทา", "base_qty": "200", "unit_name": "แผ่น", "amount_incl_vat": "4723.29", "amount_excl_vat": "4414.29" }
      ]
    },
    {
      "bill_no": "CN2610-0004",
      "kind": "return",
      "bill_type": "CN",
      "ref_bill_no": "ABB2610-0198",
      "closed_at": "2026-10-26T17:05:00+07:00",
      "member_id": "SF19872210",
      "member_verified": true,
      "coupon_code": null,
      "total": "-290.00",
      "lines": [
        { "line_no": 1, "sku": "SCG-CEM-T50", "scg_code": "SCG-CEM-T50", "is_scg": true, "name": "ปูนซีเมนต์ตราเสือ 50 กก.", "base_qty": "-2", "unit_name": "ถุง", "amount_incl_vat": "-290.00", "amount_excl_vat": "-271.03" }
      ]
    }
  ],
  "summary": { "bill_count": 2, "total": "7570.00" }
}
```
- `amount_*` = ยอดหลังส่วนลดรายการ ส่วนลดท้ายบิล **และ** ส่วนแบ่งคูปอง (`DocTotals.lines[].after`) — SF-Q08 ยืนยันว่าคิดคะแนนจากยอดไหน
- ตัวอย่างข้างบนตัดบรรทัดอื่นของ `ABB2610-0232` ออกเพื่อความสั้น — ในไฟล์จริง Σ `lines[].amount_incl_vat` ต้องเท่ากับ `total`
- ≤ 5,000 บิลต่อ chunk; ส่งซ้ำ chunk เดิมได้ (idempotent)
- Response `202` `{ "batch_id": "SFM-CM-00871-2026-10-26", "status": "received" }`

### 9.2 Webhook `points.batch.completed` (SF → ERP)
`POST /hooks/scgfamily/v1/events` — schema [`schemas/scgfamily/points.batch.completed.schema.json`](schemas/scgfamily/points.batch.completed.schema.json)
```json
{
  "id": "evt_sf_01JBF0A2C4E6G8J0K2M4N6P8Q0",
  "type": "points.batch.completed",
  "api_version": "2026-10-01",
  "occurred_at": "2026-10-27T03:12:00+07:00",
  "shop_id": "SFM-CM-00871",
  "data": {
    "batch_id": "SFM-CM-00871-2026-10-26",
    "status": "completed_with_errors",
    "accepted_bills": 1,
    "rejected_bills": [ { "bill_no": "CN2610-0004", "code": "REF_BILL_NOT_FOUND", "message": "ไม่พบบิลอ้างอิง ABB2610-0198 ในระบบคะแนน" } ],
    "points_awarded_total": 78
  }
}
```
ERP แสดงสถานะใน Admin monitor ("ไฟล์คะแนนรายวัน") และ retry บิลที่ถูกปฏิเสธด้วยเหตุชั่วคราวใน batch ถัดไป ถ้าไม่ได้รับ webhook ภายใน 06:00 → ERP poll `GET /v1/points/batches/{batchId}` และ alert

### 9.3 Acceptance tests
- **AT-SF-40** วันที่มี 2 บิลสมาชิก + 1 CN + 1 บิลไม่มีสมาชิก → batch มี 3 รายการ (ไม่มีบิลที่ไม่มีสมาชิก)
- **AT-SF-41** ส่ง batch ซ้ำ → SF ไม่คิดคะแนนซ้ำ
- **AT-SF-42** บิลที่ void หลังส่งไปแล้ว → batch วันถัดไปมี `kind: void`
- **AT-SF-43** บิลที่บันทึกตอน SF ล่ม → `member_verified: false`; ถ้า SF ปฏิเสธ `MEMBER_NOT_FOUND` แสดงในรายงาน

---

## 10. รายงานการใช้คูปอง (REQ-M11-05) และ Reconciliation (REQ-M13-07)

การเบิกคืนค่าคูปองให้ร้าน **SCG Family ทำนอกระบบเรา** (OQ-01) ERP ให้ข้อมูลสองทาง:

### 10.1 รายงานใน ERP — `GET /api/reports/coupon-usage?from=2026-10-01&to=2026-10-31`
หน้า "คูปอง SCG Family ที่ใช้" (mockup) + export CSV/XLSX; สิทธิ์ `rep.view`

| คอลัมน์ | ที่มา |
|---|---|
| เลขบิล, วันที่, ประเภท | `docs.no`, `docs.date`, `docs.type` |
| สมาชิก | `docs.member_id` |
| รหัสคูปอง, ชื่อคูปอง | `coupon_redemptions.coupon_code`, `title` |
| ยอดคูปอง | `coupon_redemptions.amount` (= `docs.coupon_amount`) |
| สถานะ | `redeemed` / `reversed` / `reverse_pending` |
| Redemption ID | `coupon_redemptions.redemption_id` (ใช้อ้างอิงกับ SF ตอนเบิกคืน) |
| สถานะบิล / คืนสินค้า | `docs.status`, มี CN อ้างอิงหรือไม่ |
| รวม | จำนวนใบ, ยอดรวมที่ `redeemed` |

### 10.2 ERP partner endpoint — `GET /partner/scgfamily/v1/coupon-usages?shop_id=SFM-CM-00871&date=2026-10-26`
SF เรียกด้วย client credentials ที่ ERP ออกให้ (scope `erp.partner.reconciliation.read`) — ให้ข้อมูลเฉพาะร้านที่ผูกกับ SF แล้ว

```json
{
  "shop_id": "SFM-CM-00871",
  "business_date": "2026-10-26",
  "items": [
    {
      "bill_no": "ABB2610-0232",
      "bill_type": "ABB",
      "bill_status": "active",
      "closed_at": "2026-10-26T15:31:02+07:00",
      "member_id": "SF22018834",
      "coupon_code": "SFC-100-1K",
      "reservation_id": "rsv_01JBD7…",
      "redemption_id": "rdm_01JBD7…",
      "discount_amount": "100.00",
      "status": "redeemed",
      "reversed_at": null,
      "returned": "none"
    }
  ],
  "summary": { "redeemed_count": 1, "redeemed_amount": "100.00", "reversed_count": 0, "reversed_amount": "0.00" },
  "next_cursor": null,
  "generated_at": "2026-10-27T02:00:00+07:00"
}
```

### 10.3 Reconciliation job ฝั่ง ERP (ทุกวัน 02:00)
ดึง `GET /v1/redemptions?shop_id=…&date=…` เทียบกับ `coupon_redemptions` ด้วย key `bill_no + coupon_code`:

| ผลเทียบ | ERP ทำ |
|---|---|
| ตรงกัน | — |
| SF มี redemption แต่ ERP ไม่มีบิล/บิลไม่มีคูปอง (timeout ที่หลุด) | เรียก `reverse` reason `orphan_redemption` อัตโนมัติ + log |
| ERP มี `redeemed` แต่ SF ไม่มี | alert admin (ห้ามแก้บิลอัตโนมัติ) |
| ยอดไม่ตรง | alert admin |
| ERP `reverse_pending` | retry reverse |

### 10.4 Acceptance tests
- **AT-SF-50** รายงานเดือนตุลาคมแสดง `ABB2610-0232 · SF22018834 · SFC-100-1K · 100.00` และยอดรวมตรงกับ endpoint partner
- **AT-SF-51** SF เรียก partner endpoint ด้วย token ของร้านอื่น → 403
- **AT-SF-52** จำลอง orphan redemption → job reverse อัตโนมัติ และรายงานวันถัดไปไม่มีส่วนต่าง

---

## 11. Timeouts และพฤติกรรมเมื่อ SF ไม่พร้อม

| การเรียก | Timeout | Retry | ถ้าล้มเหลว |
|---|---|---|---|
| member lookup | 3 s รวม | ไม่ retry (ผู้ใช้กดใหม่ได้) | ขายต่อ, เก็บรหัสแบบยังไม่ยืนยัน |
| evaluate | 3 s | ไม่ | ขายต่อโดยไม่มีคูปอง |
| reserve | 3 s | ไม่ (release async ด้วย key เดิม) | ไม่ใส่คูปอง |
| redeem | 3 s | ผู้ใช้กด "ลองอีกครั้ง" (key เดิม) | บิลไม่ถูกปิดพร้อมคูปอง (§6.2) |
| release / reverse | 10 s | background 72 ชม. | `reverse_pending`, reconciliation |
| points batch | 60 s ต่อ chunk | background จนถึง 06:00 แล้ว alert | ส่งรวมใน batch ถัดไป |

Circuit breaker ตาม README §9: เมื่อเปิด POS แสดง "SCG Family ไม่พร้อม" ทันที

---

## 12. Field mapping สรุป

| SCG Family | ERP contract / DB | หมายเหตุ |
|---|---|---|
| `member_id` | `docs.member_id`, `SalesDoc` (เสนอเพิ่ม `memberId`) | |
| `display_name`, `tier`, `member_type_label` | ไม่บันทึก (แสดงผล) | PDPA |
| `lines[].sku` | `Product.sku` | |
| `lines[].scg_code` / `is_scg` | `products.scg_code` (ใหม่) / `Product.isScg` | |
| `lines[].line_net` | `core.lineNet` = `DocLine.net` | |
| `totals.sub` | `DocTotals.sub` | |
| `totals.shop_bill_discount` | `PosSaleReq.billDiscount` → `DocTotals.billDisc` | |
| `discount_amount` (redeem) | `DocTotals.coupon` → `docs.coupon_amount` (ใหม่) | |
| `bill_no` | `SalesDoc.no` | |
| `reservation_id`, `redemption_id` | `coupon_redemptions.*` (ใหม่) | |
| points `amount_incl_vat` | `DocTotals.lines[].after` | |
| points `kind = return` | `SalesDoc.type = CN`, `ref` | |

## 13. Error codes (SCG Family)

| HTTP | `code` | ใช้ที่ |
|---|---|---|
| 404 | `MEMBER_NOT_FOUND` | lookup |
| 409 | `PHONE_AMBIGUOUS` | lookup |
| 410 | `QR_EXPIRED` | lookup |
| 422 | `MEMBER_INACTIVE` | lookup, evaluate |
| 422 | `COUPON_NOT_ELIGIBLE`, `ONE_COUPON_PER_BILL` | reserve, redeem |
| 409 | `COUPON_ALREADY_RESERVED`, `COUPON_AMOUNT_CHANGED` | reserve, redeem |
| 410 | `COUPON_ALREADY_USED`, `COUPON_EXPIRED`, `RESERVATION_EXPIRED` | reserve, redeem |
| 422 | `REDEMPTION_NOT_REVERSIBLE` | reverse |
| 409 | `IDEMPOTENCY_KEY_REUSED`, `IN_PROGRESS` | ทุก POST |
| 422 | `BATCH_DATE_CLOSED` | points |

## 14. Open questions
ดู [`README.md` §15.2](README.md#152-ทีม-scg-family) (SF-Q01 … SF-Q11), §15.3 ทีมภาษี (TX-Q01 … TX-Q03) และ ERP-Q01/Q02
