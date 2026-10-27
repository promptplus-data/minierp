# Prompt Plus Integration Spec

สถานะ: **Draft v0.1 (2026-10-27)** · Cloud edition เท่านั้น · ยังไม่เชื่อมจริง (OQ-16)
อ่านคู่กับ: [`README.md`](README.md) (auth, idempotency, retry, signature, error format), [`openapi/promptplus.yaml`](openapi/promptplus.yaml), [`schemas/promptplus/`](schemas/promptplus/)

Prompt Plus คือแพลตฟอร์มสั่งซื้อของร้านค้าย่อย (sub-dealer) จากผู้แทนจำหน่าย SCG (dealer) การจัดส่งดำเนินการโดย DM (ระบบขนส่ง) ERP ต้องการ 6 เรื่อง:

| REQ | เรื่อง | ทิศทาง | กลไก |
|---|---|---|---|
| REQ-M01-01 | เจ้าของร้านเข้า ERP จากเมนู Prompt Plus (SSO) | PP → ERP (browser) | OIDC Authorization Code + PKCE |
| REQ-M03-02 | Product master สินค้า SCG + ผู้แทนจำหน่าย → vendors | PP → ERP | ERP pull (delta) + webhook `product.updated` (optional) |
| REQ-M05-01 | สินค้ากำลังมา | PP → ERP | webhook `order.approved` / `order.status_changed` + ERP pull |
| REQ-M05-02 | ส่งสำเร็จ → ใบรับของร่าง 1 ใบต่อ DN | PP → ERP | webhook `delivery.succeeded` (+ polling fallback) |
| REQ-M05-05 | ยืนยันรับจาก order เมื่อไม่มีข้อมูลจัดส่ง | ERP (→ PP optional) | ERP internal + `POST .../receipts` |
| REQ-M08-11 | สร้างคำสั่งซื้อ Prompt Plus จากใบเสนอราคา/ใบสั่งขาย | ERP → PP | `POST /v1/shops/{shopId}/orders` |
| OQ-09 | DN ของ DM ชนกับการจัดส่งที่ผู้แทนบันทึกเอง | PP → ERP | กฎ match + `supersedes` |

---

## 1. Endpoint list

### 1.1 Prompt Plus จัดให้ (ERP เรียก) — proposed

| Method | Path | Scope | ใช้ใน |
|---|---|---|---|
| GET | `/.well-known/openid-configuration` (issuer) | — | M01-01 |
| GET | `/oauth2/authorize` (issuer) | — | M01-01 |
| POST | `/oauth2/token` (issuer) | — | M01-01, ทุก API |
| GET | `/oauth2/jwks` (issuer) | — | M01-01 |
| GET | `/v1/catalog/products?updated_since=&cursor=&limit=` | `pp.catalog.read` | M03-02 |
| GET | `/v1/catalog/products/{scgCode}` | `pp.catalog.read` | M03-02, map สินค้าใน DN |
| GET | `/v1/shops/{shopId}` | `pp.dealers.read` | onboarding |
| GET | `/v1/shops/{shopId}/dealers` | `pp.dealers.read` | M03-02 |
| GET | `/v1/shops/{shopId}/orders?status=&updated_since=&cursor=` | `pp.orders.read` | M05-01, M08-11 (incoming qty) |
| GET | `/v1/shops/{shopId}/orders/{orderNo}` | `pp.orders.read` | M05-01, M05-05 |
| POST | `/v1/shops/{shopId}/orders` | `pp.orders.write` | M08-11 |
| GET | `/v1/shops/{shopId}/deliveries?updated_since=&cursor=` | `pp.deliveries.read` | M05-02 polling fallback |
| GET | `/v1/shops/{shopId}/deliveries/{deliveryNo}` | `pp.deliveries.read` | M05-02 |
| POST | `/v1/shops/{shopId}/orders/{orderNo}/receipts` | `pp.receipts.write` | M05-05 (optional, PP-Q08) |

### 1.2 ERP จัดให้ (Prompt Plus เรียก)

| Method | Path | ใช้ใน |
|---|---|---|
| GET | `/api/auth/sso/promptplus/start?iss=&login_hint=&target_link_uri=` | M01-01 (initiate_login_uri) |
| GET | `/api/auth/sso/promptplus/callback?code=&state=` | M01-01 (redirect_uri) |
| POST | `/hooks/promptplus/v1/events` | webhook ทุก event |

### 1.3 ERP internal (web ↔ server) — เสนอเพิ่มใน `packages/contracts` ภายหลัง

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `/api/promptplus/incoming` | มีแล้ว (stub) — คืน order ที่ยังไม่ถึง + ใบรับของร่าง |
| GET | `/api/promptplus/inbound` | รายการใบรับของร่าง (draft GR) |
| POST | `/api/promptplus/inbound/:id/confirm` | ตรวจรับ → GR (สิทธิ์ `inv.receive`) |
| POST | `/api/promptplus/inbound/:id/resolve` | ตัดสินกรณี conflict (OQ-09, M05-05) |
| POST | `/api/promptplus/orders/:orderNo/confirm-receipt` | M05-05 |
| GET | `/api/promptplus/orders/suggest?sourceDocNo=` | M08-11 จำนวนแนะนำ |
| POST | `/api/promptplus/orders` | มีแล้ว (stub, `ppOrderFromDoc`) — M08-11 |

---

## 2. Identifiers และ external references

| แนวคิด | Prompt Plus | ERP (ปัจจุบัน) | ERP (เสนอเพิ่ม) |
|---|---|---|---|
| ร้าน | `shop_id` เช่น `PP-SHOP-104552` | `tenants.code` (`charoen`) | `tenant_integrations(tenant_id, provider='promptplus', external_id)` unique ทั้งสองทาง |
| เจ้าของร้าน | OIDC `sub` | `users.id` (role `owner`) | `user_identities(tenant_id, provider, sub, user_id)` |
| สินค้า SCG | `scg_code` เช่น `SCG-CEM-T50` (PP-Q03) | `products.sku`, `products.is_scg` | `products.scg_code` (unique ต่อ tenant เมื่อไม่ null) |
| ผู้แทนจำหน่าย | `dealer_id` เช่น `DLR-0017` | `vendors.code` | `vendors.pp_dealer_id` |
| คำสั่งซื้อ | `order_no` เช่น `PP-2610-00871` | — | `pp_orders` (cache), `docs.pp_order_no` (QT/SO ที่สร้าง order) |
| ใบส่งของ | `delivery_no` เช่น `8100234561` (DM) หรือ `MAN-TW-1022` (ผู้แทนบันทึก) | `stock_docs.delivery_no` | `inbound_deliveries`, `inbound_delivery_lines(tenant_id, delivery_no, line_no)` **unique (BR-01)** |

---

## 3. REQ-M01-01 — Owner SSO จากเมนู Prompt Plus

**ทิศทาง:** Prompt Plus (OP) → ERP (RP) ผ่าน browser · **Trigger:** เจ้าของร้านกดเมนู "SCG Shop ERP" ใน Prompt Plus

### 3.1 Flow
1. Prompt Plus redirect browser ไป `GET https://app.scgshop-erp.example/api/auth/sso/promptplus/start?iss={issuer}&login_hint=PP-SHOP-104552&target_link_uri=/dash`
2. ERP ตรวจว่า `iss` ตรง config, สร้าง `state`, `nonce`, `code_verifier` (เก็บใน cookie HttpOnly, SameSite=Lax, อายุ 10 นาที), redirect ไป `/oauth2/authorize?response_type=code&client_id=scg-shop-erp&redirect_uri=.../callback&scope=openid profile pp.shop&state=..&nonce=..&code_challenge=..&code_challenge_method=S256&login_hint=PP-SHOP-104552`
3. Prompt Plus redirect กลับ `/api/auth/sso/promptplus/callback?code=...&state=...`
4. ERP แลก code ที่ `/oauth2/token`, ตรวจ `id_token` (RS256/ES256 จาก JWKS, `iss`, `aud`, `exp`, `nonce`)
5. หา tenant จาก `pp_shop_id` → หา user จาก `user_identities(provider='promptplus', sub)`
   - ไม่พบ identity แต่ tenant ผูกแล้ว และ `pp_role = owner` → ผูกกับ user owner ของ tenant (ครั้งแรก) และ audit `sso-linked`
   - tenant ยังไม่ผูก → หน้า "ร้านนี้ยังไม่ได้เปิดใช้ SCG Shop ERP" (onboarding ทำโดยทีม SCG ใน M14)
6. ERP ออก JWT ของตัวเอง (เหมือน `LoginRes`) และ audit `login` พร้อม `method=sso-promptplus`

### 3.2 id_token claims (ตัวอย่าง)

```json
{
  "iss": "https://id.promptplus.example",
  "sub": "ppu_7d1f0c2a9b",
  "aud": "scg-shop-erp",
  "exp": 1761528720,
  "iat": 1761528120,
  "nonce": "n-0S6_WzA2Mj",
  "amr": ["pwd", "otp"],
  "name": "คุณเจริญ ศรีสุข",
  "email": "charoen@example.com",
  "pp_shop_id": "PP-SHOP-104552",
  "pp_shop_name": "ร้านวัสดุเจริญชัย",
  "pp_role": "owner"
}
```

### 3.3 Mapping

| Claim | ERP |
|---|---|
| `sub` | `user_identities.sub` (ใหม่) |
| `pp_shop_id` | `tenant_integrations.external_id` → `tenants.id` |
| `pp_role` | ต้องเป็น `owner` → ERP role `owner`; ค่าอื่นปฏิเสธในเฟสนี้ |
| `name` | แสดงผลเท่านั้น (ไม่ทับ `users.name`) |

### 3.4 Error cases

| กรณี | ผล |
|---|---|
| `state` ไม่ตรง / cookie หมดอายุ | หน้า error "ลิงก์เข้าระบบหมดอายุ กรุณากดเมนูจาก Prompt Plus อีกครั้ง", audit `login-failed` |
| `id_token` signature/aud/nonce ผิด | 401, audit |
| `pp_role` ≠ `owner` | 403 "เข้าจาก Prompt Plus ได้เฉพาะเจ้าของร้าน พนักงานใช้ชื่อผู้ใช้ของร้าน" |
| tenant ยังไม่ผูก | หน้า onboarding |
| user owner ถูกล็อก/ลาออก | ปฏิเสธเหมือน login ปกติ (`LOCKED`) |
| Prompt Plus ล่ม | ผู้ใช้ยัง login ด้วย username/password ของ ERP ได้ตามปกติ |

### 3.5 Acceptance tests
- **AT-PP-01** เจ้าของร้าน `PP-SHOP-104552` กดเมนู → เข้าแดชบอร์ด `charoen` โดยไม่กรอกรหัส; audit มี `login` method `sso-promptplus`
- **AT-PP-02** `nonce` ใน id_token ไม่ตรง → 401 และไม่มี session
- **AT-PP-03** `pp_role = staff` → 403
- **AT-PP-04** `pp_shop_id` ที่ไม่มี tenant → หน้า onboarding, ไม่สร้าง tenant อัตโนมัติ
- **AT-PP-05** On-prem build ไม่มี route `/api/auth/sso/promptplus/*` (`check-onprem.mjs` ผ่าน) และ `meta.capabilities.promptPlusSso = false`

---

## 4. REQ-M03-02 — Product master สินค้า SCG + dealer → vendor sync

**ทิศทาง:** PP → ERP · **Trigger:** (1) ตอน onboarding ร้าน (full sync), (2) ทุกคืน 02:00 delta ด้วย `updated_since`, (3) webhook `product.updated` (ถ้า PP รองรับ), (4) on-demand เมื่อ DN มีสินค้าที่ยังไม่ผูก (ปุ่ม "เพิ่มจาก master SCG")

### 4.1 `GET /v1/catalog/products?updated_since=2026-10-26T02:00:00+07:00&limit=100`

Response `200`:
```json
{
  "items": [
    {
      "scg_code": "SCG-CEM-T50",
      "name": "ปูนซีเมนต์ตราเสือ 50 กก.",
      "brand": "ตราเสือ",
      "category_code": "CEMENT",
      "category_name": "ปูนซีเมนต์",
      "barcode": "8850001000101",
      "image_url": "https://cdn.promptplus.example/p/SCG-CEM-T50.jpg",
      "vat": "v7",
      "units": [
        { "unit_code": "BAG", "unit_name": "ถุง", "base_factor": "1", "barcode": "8850001000101" },
        { "unit_code": "PAL", "unit_name": "พาเลท", "base_factor": "40", "barcode": null }
      ],
      "suggested_retail_price": "145.00",
      "status": "active",
      "updated_at": "2026-10-26T08:15:00+07:00"
    }
  ],
  "next_cursor": null
}
```

### 4.2 `GET /v1/shops/{shopId}/dealers`

```json
{
  "items": [
    {
      "dealer_id": "DLR-0017",
      "name": "หจก. ทวีพัฒนาวัสดุ",
      "tax_id": "0503546001234",
      "branch": "00000",
      "phone": "053-123456",
      "address": "88 ถ.เชียงใหม่-ลำปาง ต.ท่าศาลา อ.เมือง จ.เชียงใหม่ 50000",
      "link_status": "active",
      "updated_at": "2026-10-01T10:00:00+07:00"
    }
  ],
  "next_cursor": null
}
```

### 4.3 Field mapping

| Prompt Plus | ERP contract (`Product`) / DB | กฎ |
|---|---|---|
| `scg_code` | `products.scg_code` (ใหม่); `Product.sku` = `scg_code` เมื่อสร้างใหม่ | key ในการ upsert; ร้านเปลี่ยน `sku` ไม่ได้สำหรับสินค้า SCG |
| `name` | `Product.name` | ทับทุกครั้ง (ร้านแก้ชื่อสินค้า SCG ไม่ได้) |
| — | `Product.isScg = true` | |
| `category_name` | `Product.category` | ใช้เฉพาะตอนสร้าง — ร้านย้ายหมวดได้และ sync ไม่ทับ |
| `barcode` | `Product.barcode` | ทับถ้าร้านยังไม่ได้แก้ |
| `vat` | `Product.vat` (`v7`/`exempt`) | |
| `units[]` | `Product.units[]` (`name` ← `unit_name`, `factor` ← `base_factor`) | index 0 ต้องเป็น `base_factor = 1`; เพิ่มหน่วยใหม่ได้ ไม่ลบหน่วยที่มีสต็อก/เอกสารอ้างอิง |
| `suggested_retail_price` | `Product.price` | ใช้เฉพาะตอนสร้าง (ERP-Q03) — ราคาขายเป็นของร้าน |
| — | `Product.kind = 'stock'`, `reorderPoint = '0'` | ค่าเริ่มต้น |
| `status = discontinued` | `Product.active` ไม่เปลี่ยนอัตโนมัติ | แสดงป้าย "SCG เลิกผลิต" ให้ร้านตัดสินใจ |
| `image_url` | `product_images` (ใหม่) | cache ฝั่ง ERP |
| `dealer_id` | `vendors.pp_dealer_id` (ใหม่) | key ในการ upsert |
| `name`, `tax_id`, `branch`, `phone` | `Vendor.name`, `taxId`, `branch`, `phone` | ทับทุกครั้ง; `Vendor.code` ERP ออกเอง (`V0000n`) |
| — | `vendors.term` | ไม่ทับ (ร้านตั้งเงื่อนไขชำระเงินเอง) |
| `link_status = inactive` | vendor ไม่ถูกลบ (no-delete) | ซ่อนจากตัวเลือกสั่งซื้อ |

### 4.4 Error cases
- `scg_code` ซ้ำกับ `sku` ของสินค้าที่ร้านสร้างเองแต่ `is_scg = false` → ไม่ทับ, สร้าง task ให้ admin "ผูกสินค้า" (merge) ใน M14
- หน่วยฐานเปลี่ยน factor → ปฏิเสธการ sync ของสินค้านั้น + alert (กระทบต้นทุน FIFO)
- 429/5xx → retry ตาม README §9; job ทำต่อจาก `next_cursor` ที่บันทึกไว้ (idempotent)

### 4.5 Acceptance tests
- **AT-PP-10** Full sync ร้านใหม่ → สินค้า SCG ทุกตัวมี `is_scg = true`, `sku = scg_code`, หน่วยตรง
- **AT-PP-11** ร้านย้าย `SCG-CEM-T50` ไปหมวด "งานหล่อคอนกรีต" → delta sync ไม่ย้ายกลับ แต่ชื่อใหม่จาก PP ถูกอัปเดต
- **AT-PP-12** Delta sync ถูกตัดกลางคัน → รันใหม่ได้ผลเท่าเดิม ไม่มีสินค้าซ้ำ
- **AT-PP-13** Dealer ใหม่ `DLR-0017` → สร้าง vendor ใหม่ 1 รายการ; sync ซ้ำไม่สร้างเพิ่ม; ร้านแก้ term แล้ว sync ไม่ทับ

---

## 5. REQ-M05-01 — สินค้ากำลังมา (incoming orders)

**ทิศทาง:** PP → ERP · **Trigger:** webhook `order.approved` (ผู้แทนอนุมัติ), `order.status_changed` (เตรียมจัดส่ง/กำลังจัดส่ง/ETA เปลี่ยน), `order.cancelled`; ERP pull `GET /v1/shops/{shopId}/orders?status=approved,preparing,shipping&updated_since=` ทุก 30 นาทีเป็น reconciliation

### 5.1 Order resource

```json
{
  "order_no": "PP-2610-00895",
  "shop_id": "PP-SHOP-104552",
  "dealer_id": "DLR-0017",
  "dealer_name": "หจก. ทวีพัฒนาวัสดุ",
  "status": "shipping",
  "status_label": "กำลังจัดส่ง",
  "ordered_at": "2026-10-21T10:05:00+07:00",
  "approved_at": "2026-10-21T13:30:00+07:00",
  "eta_date": "2026-10-24",
  "ship_to": { "type": "shop", "address": "ร้านวัสดุเจริญชัย 12 ถ.โชตนา อ.เมือง จ.เชียงใหม่" },
  "external_ref": { "system": "scg-shop-erp", "doc_type": "SO", "doc_no": "SO2610-0009" },
  "lines": [
    {
      "line_no": 1,
      "scg_code": "SCG-AAC-75",
      "name": "อิฐมวลเบา 7.5 ซม.",
      "unit_code": "PAL",
      "unit_name": "พาเลท",
      "base_factor": "100",
      "qty_ordered": "4",
      "qty_delivered": "0",
      "unit_price": "2150.00",
      "vat": "v7"
    }
  ],
  "updated_at": "2026-10-23T07:10:00+07:00"
}
```

`status` (enum เสนอ): `pending_dealer` · `approved` · `preparing` · `shipping` · `partially_delivered` · `delivered` · `cancelled` · `closed` — ค่าที่ไม่รู้จักแสดงเป็น "อื่น ๆ"

### 5.2 Mapping (ERP `pp_orders` — ใหม่, แสดงใน "ของที่กำลังมาจาก Prompt Plus")

| Prompt Plus | ERP | หมายเหตุ |
|---|---|---|
| `order_no` | `pp_orders.order_no` unique ต่อ tenant | mockup `incoming[].pp` |
| `status_label` | `pp_orders.status_label` | mockup `incoming[].st` |
| `eta_date` | `pp_orders.eta_date` | mockup `incoming[].eta` |
| `lines[].scg_code` | `products.scg_code` → `product_id` | ไม่พบ → แสดงชื่อจาก PP, ป้าย "ยังไม่ผูก" |
| `qty_ordered − qty_delivered` × `base_factor` | `pp_order_lines.open_base_qty` | ใช้คำนวณ incoming ใน M08-11 |
| `external_ref.doc_no` | `pp_orders.source_doc_no` | mockup "จาก SO2610-0009 · ส่งตรงลูกค้า" |
| `ship_to.type` | `pp_orders.ship_to` (`shop`/`site`) | `site` ไม่นับเป็น incoming ของสต็อกร้าน |

### 5.3 Acceptance tests
- **AT-PP-20** `order.approved` ของ `PP-2610-00895` → ภายใน 1 นาทีแดชบอร์ดแสดงแถว "กำลังจัดส่ง · อิฐมวลเบา 4 พาเลท · 24/10/2569"
- **AT-PP-21** `order.cancelled` → แถวหายจาก "สินค้ากำลังมา", incoming qty ลดลง, ใบรับของร่างที่ยังไม่ยืนยันของ order นั้นถูก mark `cancelled`
- **AT-PP-22** event มาไม่ตามลำดับ (`shipping` ก่อน `approved`) → ERP เก็บสถานะตาม `updated_at` ล่าสุด ไม่ย้อนกลับ

---

## 6. REQ-M05-02 — Delivery สำเร็จ → ใบรับของร่าง (1 ใบต่อ DN)

**ทิศทาง:** PP → ERP · **Trigger:** DM แจ้งส่งสำเร็จ → PP ส่ง `delivery.succeeded` · **SLA:** ร้านเห็นใบรับของร่างและได้รับแจ้งเตือน **ภายใน 5 นาที** นับจาก `occurred_at` (PP ส่ง ≤ 1 นาที, ERP ประมวลผล ≤ 1 นาที, polling fallback ทุก 10 นาทีสำหรับ event ที่ตกหล่น — ถ้า webhook ล่มทั้งระบบ SLA จะเป็น ≤ 10 นาที)

### 6.1 Webhook `delivery.succeeded`

`POST /hooks/promptplus/v1/events` · Schema: [`schemas/promptplus/delivery.succeeded.schema.json`](schemas/promptplus/delivery.succeeded.schema.json)

```http
POST /hooks/promptplus/v1/events HTTP/1.1
Content-Type: application/json
X-Webhook-Id: evt_01JBC6Z8Q4M2N7T5V9X3Y1K0AB
X-Webhook-Timestamp: 1761100931
X-Webhook-Signature: v1=3b6f0a...c41d
```
```json
{
  "id": "evt_01JBC6Z8Q4M2N7T5V9X3Y1K0AB",
  "type": "delivery.succeeded",
  "api_version": "2026-10-01",
  "occurred_at": "2026-10-22T09:42:11+07:00",
  "shop_id": "PP-SHOP-104552",
  "data": {
    "delivery_no": "8100234561",
    "source": "dm",
    "order_no": "PP-2610-00871",
    "dealer_id": "DLR-0017",
    "dealer_name": "หจก. ทวีพัฒนาวัสดุ",
    "delivered_at": "2026-10-22T09:40:00+07:00",
    "proof": { "receiver_name": "ชัย", "photo_url": "https://cdn.promptplus.example/pod/8100234561.jpg" },
    "supersedes": null,
    "lines": [
      { "line_no": 10, "order_line_no": 1, "scg_code": "SCG-CEM-T50", "name": "ปูนซีเมนต์ตราเสือ 50 กก.", "unit_code": "BAG", "unit_name": "ถุง", "base_factor": "1", "qty": "200", "unit_price": "121.00", "vat": "v7" },
      { "line_no": 20, "order_line_no": 2, "scg_code": "SCG-ROOF-DL-GY", "name": "กระเบื้องหลังคาลอนคู่ 50×120 ซม. สีเทา", "unit_code": "SHT", "unit_name": "แผ่น", "base_factor": "1", "qty": "300", "unit_price": "43.50", "vat": "v7" },
      { "line_no": 30, "order_line_no": 3, "scg_code": "SCG-RIDGE-C", "name": "ครอบสันโค้ง ลอนคู่ สีเทา", "unit_code": "PCS", "unit_name": "ชิ้น", "base_factor": "1", "qty": "40", "unit_price": "38.00", "vat": "v7" }
    ],
    "bill_discount": "0.00",
    "currency": "THB"
  }
}
```

Response: `202 Accepted` `{ "status": "accepted" }` (ใหม่) หรือ `200 OK` `{ "status": "duplicate" }` (event id เคยรับแล้ว)

### 6.2 การประมวลผลฝั่ง ERP
1. ตรวจลายเซ็น/timestamp (README §10), บันทึก `integration_events` (unique `source + event_id`) → ตอบ 202
2. Worker: หา tenant จาก `shop_id`; ไม่พบ → `ignored` + alert admin
3. **Dedupe BR-01:** key = `(tenant_id, delivery_no, line_no)`
   - ทุก line มีอยู่แล้ว และใบร่างยังไม่ยืนยัน → อัปเดตเฉพาะ field ที่เปลี่ยน (เช่น qty ที่ DM แก้) และ log
   - ใบร่างยืนยันแล้ว (มี GR) → **ไม่สร้าง GR ใหม่ ไม่เพิ่มสต็อก**; ถ้าข้อมูลต่าง → mark `conflict` แจ้งร้าน
   - ใหม่ → สร้าง `inbound_deliveries` 1 ใบต่อ `delivery_no` (status `draft`) + lines
4. ตรวจ M05-05: order นี้มี GR แบบ "ยืนยันรับจาก order" แล้วหรือไม่ → §7.3
5. ตรวจ OQ-09: มี delivery ของ order เดียวกันจาก source อื่นหรือไม่ → §8
6. map สินค้า: `scg_code` → `products.scg_code`; ไม่พบ → line `product_id = null`, ปุ่ม "เพิ่มจาก master SCG" (เรียก `GET /v1/catalog/products/{scgCode}`); ยืนยันรับได้เมื่อผูกครบทุกรายการ (ตาม mockup)
7. แจ้งเตือนผู้มีสิทธิ์ `inv.receive` (in-app badge "ของรอยืนยันรับ" + push/LINE ถ้าตั้งไว้) — **ภายใน 5 นาที**
8. สต็อก **ไม่เปลี่ยน** จนกว่าร้านกด "ยืนยันรับเข้าสต็อก"; ใบร่างค้าง ≥ `GR_ALERT_DAYS` วันแสดงเตือนแดง

### 6.3 Field mapping (ใบรับของร่าง → GR ตอนยืนยัน)

| Prompt Plus (`data.`) | ใบรับของร่าง (ใหม่) | GR ตอนยืนยัน (`stock_docs` / `StockDoc`) |
|---|---|---|
| `delivery_no` | `inbound_deliveries.delivery_no` | `stock_docs.delivery_no` |
| `order_no` | `inbound_deliveries.pp_order_no` | `stock_docs.pp_order_no` (ใหม่) |
| `dealer_id` | → `vendors.pp_dealer_id` → `vendor_id` | `stock_docs.vendor_id` |
| — | — | `stock_docs.vendor_invoice_no` = null (ตั้งเจ้าหนี้ "รอใบกำกับผู้แทน (DN …)") |
| `source` | `inbound_deliveries.source` (`dm`/`dealer`/`order_confirm`) | audit detail |
| `lines[].line_no` | `inbound_delivery_lines.line_no` (unique กับ DN) | — |
| `lines[].scg_code` | `product_id` | `lines[].productId` |
| `lines[].qty` × `base_factor` | `qty_doc` (หน่วยฐาน) | ค่าเริ่มต้นของ "รับจริง" |
| — (ร้านกรอก) | `qty_received`, `qty_damaged`, `warehouse_id` | `lines[].qty` = รับจริง − เสียหาย, `warehouse_id` |
| `lines[].unit_price` ÷ `base_factor` | `unit_cost` | `lines[].unitCost` (หลังกระจายส่วนลดท้ายบิลตามนโยบายร้าน `pdisc`) |
| `bill_discount` | ค่าเริ่มต้นช่อง "ส่วนลดท้ายบิล" | `billDiscount` |
| `occurred_at` / `delivered_at` | `delivered_at` | `stock_lots.received_at` = เวลายืนยัน |

### 6.4 Error cases

| กรณี | ERP ตอบ | ผล |
|---|---|---|
| signature ผิด / timestamp เกิน 5 นาที | 401 | PP ไม่ retry (ต้องแก้ config) |
| JSON ผิด schema | 400 `VALIDATION` | บันทึก event `failed` + alert |
| `shop_id` ไม่ผูกกับ tenant | 202 | event `ignored`, alert admin |
| DB ล่ม | 503 | PP retry |
| `delivery_no` + `line_no` ซ้ำ (event id ใหม่) | 202 | ไม่สร้างใบซ้ำ (BR-01), นับใน "ซ้ำถูกข้าม" |
| qty ≤ 0 หรือ `base_factor` ไม่ตรงหน่วยของสินค้า | 202 | line `needs_attention` ให้ร้านแก้ก่อนยืนยัน |

### 6.5 Acceptance tests
- **AT-PP-30** ส่ง `delivery.succeeded` DN `8100234561` (3 lines) → ภายใน 5 นาทีมีใบรับของร่าง 1 ใบ 3 รายการ และ badge "ของรอยืนยันรับ" +1; สต็อกไม่เปลี่ยน
- **AT-PP-31** ส่ง event เดิมซ้ำ (id เดิม) → 200 duplicate; ส่ง event id ใหม่ DN/lines เดิม → ไม่มีใบร่างใบที่ 2 (BR-01)
- **AT-PP-32** ยืนยันรับ 200/300/40 → GR `GR2610-xxxx`, lot ต้นทุน 121.00/43.50/38.00, เจ้าหนี้ "รอใบกำกับผู้แทน (DN 8100234561)"; ส่ง event ซ้ำหลังยืนยัน → ไม่มีสต็อกเพิ่ม
- **AT-PP-33** line `SCG-RIDGE-C` ยังไม่ผูก → ปุ่มยืนยันถูกปิด; กด "เพิ่มจาก master SCG" → สร้างสินค้าแล้วยืนยันได้
- **AT-PP-34** signature ผิด → 401, ไม่มี event ใน DB; timestamp เก่ากว่า 301 วินาที → 401
- **AT-PP-35** ปิด webhook แล้วสร้าง DN ใน sandbox → polling fallback สร้างใบร่างภายใน 10 นาที และไม่ซ้ำเมื่อ webhook ส่งตามมาทีหลัง
- **AT-PP-36** รับจริง 295, เสียหาย 5 → ต้องกรอกเหตุผล; GR บันทึก 290 (ถ้า PP-Q08 = ใช่ ส่ง receipt กลับพร้อมเหตุผล)

---

## 7. REQ-M05-05 — ยืนยันรับจาก order เมื่อไม่มีข้อมูลจัดส่ง

**บริบท:** บาง order ไม่มี DN จาก DM (เช่น ผู้แทนส่งเองโดยไม่บันทึก) ร้านต้องรับของเข้าสต็อกได้ด้วยการกด "ยืนยันรับของ" จากรายการคำสั่งซื้อ Prompt Plus ในหน้า ERP

**ทิศทาง:** ERP internal (+ แจ้ง PP ถ้า PP-Q08 ตอบรับ) · **Trigger:** ผู้มีสิทธิ์ `inv.receive` กดยืนยันรับบน order สถานะ `approved`/`preparing`/`shipping`

### 7.1 ERP internal: `POST /api/promptplus/orders/:orderNo/confirm-receipt`

```json
{
  "idempotencyKey": "0b6d3c9e-1f7a-4a52-9c1e-6f0f7d1f8a11",
  "warehouseId": "wh-2",
  "lines": [ { "orderLineNo": 1, "qtyReceived": "80", "qtyDamaged": "0" } ],
  "billDiscount": "0",
  "note": "ผู้แทนส่งเอง ไม่มีใบส่งของจาก DM"
}
```

ผล: GR ทันที (`source = order_confirm`), `inbound_delivery_lines` ใช้ key สังเคราะห์ `delivery_no = "ORD:" + orderNo`, `line_no = order_line_no` เพื่อให้ dedupe กับ order เดิมได้, ต้นทุนจาก `unit_price` ของ order

### 7.2 แจ้ง Prompt Plus (optional): `POST /v1/shops/{shopId}/orders/{orderNo}/receipts`

Header `Idempotency-Key: erp:charoen:receipt:GR2610-0007`

```json
{
  "receipt_no": "GR2610-0007",
  "received_at": "2026-10-26T15:20:00+07:00",
  "basis": "order",
  "lines": [ { "order_line_no": 1, "scg_code": "SCG-ADH-20", "qty_received": "80", "qty_damaged": "0", "reason": null } ]
}
```
Response `201` `{ "receipt_id": "rcp_9f2c", "order_status": "delivered" }`

### 7.3 DN มาทีหลัง → เตือน ไม่รับซ้ำ
เมื่อ `delivery.succeeded`/`delivery.recorded_by_dealer` ของ order ที่มี GR `source = order_confirm` อยู่แล้ว:
1. สร้างใบรับของร่างตามปกติแต่ status `possible_duplicate` พร้อมแสดง GR เดิม เทียบจำนวนรายสินค้า
2. ปุ่มหลัก: **"ผูกกับใบรับเดิม (ไม่เพิ่มสต็อก)"** → ใบร่าง `linked`, `stock_docs.delivery_no` ของ GR เดิมถูกเติม DN (ถ้ายังว่าง), audit
3. ปุ่มรอง: **"รับเพิ่ม (ของมาจริงอีกรอบ)"** → ต้องมีสิทธิ์ `inv.receive` + ระบุเหตุผล → GR ใหม่
4. ถ้าจำนวนใน DN > ที่ยืนยันไว้ → แสดงส่วนต่าง ให้รับเฉพาะส่วนต่างได้
5. **ไม่มีการรับซ้ำอัตโนมัติไม่ว่ากรณีใด**

### 7.4 Acceptance tests
- **AT-PP-40** order `PP-2610-00901` ไม่มี DN → ยืนยันรับ 80 ถุง → GR + สต็อก +80, order หายจาก "สินค้ากำลังมา"
- **AT-PP-41** ต่อจาก AT-PP-40 DN `8100235100` ของ order เดียวกันเข้ามา 80 ถุง → ใบร่าง `possible_duplicate`, สต็อกยัง +80 เท่าเดิม; กด "ผูกกับใบรับเดิม" → ไม่มี GR ใหม่
- **AT-PP-42** DN เข้ามา 100 ถุง → แสดงส่วนต่าง 20; รับส่วนต่าง → GR ใหม่ 20
- **AT-PP-43** กดยืนยันรับซ้ำด้วย `idempotencyKey` เดิม → ได้ GR เดิม (200 replay)

---

## 8. OQ-09 — DN ของ DM ชนกับการจัดส่งที่ผู้แทนบันทึกเอง

**ปัญหา:** order เดียวอาจมีทั้ง (ก) `delivery.recorded_by_dealer` (ผู้แทนบันทึกเอง เช่น `MAN-TW-1022`) และ (ข) `delivery.succeeded` จาก DM (เช่น `8100234561`) ของการส่งครั้งเดียวกัน ถ้ารับทั้งสองจะได้สต็อกซ้ำ

### 8.1 ข้อเสนอ (ต้องให้ PP ยืนยัน — PP-Q07)
1. **PP ส่ง `supersedes`**: เมื่อ DM DN แทนที่การบันทึกของผู้แทน ให้ใส่ `data.supersedes = ["MAN-TW-1022"]` (และกลับกัน) — ถ้ามี field นี้ ERP ใช้ตัดสินโดยตรง
2. **ถ้าไม่มี `supersedes`** ERP match ด้วย `order_no` + `scg_code` (และ `order_line_no` ถ้ามี):
   - ใบแรกยัง `draft` → ใบที่สองจาก **DM ถือเป็นข้อมูลหลัก (authoritative)**: ใบของผู้แทนถูก mark `superseded` (เก็บไว้ดูประวัติ) ใบ DM เป็นใบร่างที่ใช้งาน; ถ้าใบแรกเป็น DM และใบที่สองเป็นของผู้แทน → ใบผู้แทน `superseded` ทันที
   - ใบแรก **ยืนยันแล้ว** → ใบที่สอง status `conflict` ใช้ UI เดียวกับ §7.3 (ผูกกับใบรับเดิม / รับเพิ่มเฉพาะส่วนต่าง)
   - จำนวนรวมของทุก delivery ต่อ order line > `qty_ordered` → เตือน "เกินจำนวนสั่ง" เสมอ
3. Admin monitor นับกรณี conflict ต่อร้าน

### 8.2 Webhook `delivery.recorded_by_dealer`
Payload เหมือน `delivery.succeeded` แต่ `source = "dealer"`, ไม่มี `proof` จาก DM, `recorded_by` = ชื่อผู้บันทึกฝั่งผู้แทน — schema: [`schemas/promptplus/delivery.recorded_by_dealer.schema.json`](schemas/promptplus/delivery.recorded_by_dealer.schema.json)

```json
{
  "id": "evt_01JB8T2K7R5W3Y6Z9A1C4E7G0H",
  "type": "delivery.recorded_by_dealer",
  "api_version": "2026-10-01",
  "occurred_at": "2026-10-19T16:05:00+07:00",
  "shop_id": "PP-SHOP-104552",
  "data": {
    "delivery_no": "MAN-TW-1022",
    "source": "dealer",
    "order_no": "PP-2610-00880",
    "dealer_id": "DLR-0017",
    "dealer_name": "หจก. ทวีพัฒนาวัสดุ",
    "delivered_at": "2026-10-19T15:30:00+07:00",
    "recorded_by": "สมศักดิ์ (ทวีพัฒนา)",
    "supersedes": null,
    "lines": [
      { "line_no": 1, "order_line_no": 1, "scg_code": "SCG-ADH-20", "name": "กาวซีเมนต์ปูกระเบื้อง 20 กก.", "unit_code": "BAG", "unit_name": "ถุง", "base_factor": "1", "qty": "60", "unit_price": "175.00", "vat": "v7" }
    ],
    "bill_discount": "0.00",
    "currency": "THB"
  }
}
```

### 8.3 Acceptance tests
- **AT-PP-50** `recorded_by_dealer` MAN-TW-1022 (ยังไม่ยืนยัน) แล้ว `delivery.succeeded` 8100234999 ของ order เดียวกัน → ใบ MAN `superseded`, เหลือใบร่างที่ใช้งาน 1 ใบ (DM)
- **AT-PP-51** ยืนยัน MAN-TW-1022 แล้ว จากนั้น DM DN เข้ามา → ใบ DM `conflict`, สต็อกไม่เพิ่มจนกว่าร้านเลือก
- **AT-PP-52** DM DN มี `supersedes: ["MAN-TW-1022"]` → ERP ใช้ค่านี้แทนการ match
- **AT-PP-53** DN สองใบของ order เดียวกันแต่คนละสินค้า (ส่งแยกเที่ยว) → ไม่ถือเป็น conflict

---

## 9. REQ-M08-11 — สร้างคำสั่งซื้อ Prompt Plus จากใบเสนอราคา / ใบสั่งขาย

**ทิศทาง:** ERP → PP · **Trigger:** ผู้ใช้สิทธิ์ `sales.doc` กด "สั่งของ Prompt Plus" บน QT/SO ที่ยัง active, ยังไม่มี `pp_order_no`, ยังไม่แปลง และมีสินค้า SCG อย่างน้อย 1 รายการ (mockup `ppEligible`)

### 9.1 จำนวนแนะนำ (ERP คำนวณ)

```
suggested_qty(product) = max(0, need − on_hand − incoming)
  need     = ผลรวม qty × unit factor ของบรรทัดสินค้านั้นในเอกสาร (หน่วยฐาน)
             (SO ที่ส่งบางส่วน: ใช้จำนวนที่ยังไม่ส่ง)
  on_hand  = สต็อกคงเหลือทุกคลังที่ active (หน่วยฐาน) — GET /api/stock
  incoming = Σ pp_order_lines.open_base_qty ของ order สถานะ approved/preparing/shipping ที่ ship_to = shop
             + ใบรับของร่างที่ยังไม่ยืนยัน
```
- เฉพาะสินค้า `is_scg = true` และมี `scg_code`; สินค้าอื่นแสดงหมายเหตุ "สั่งผ่าน Prompt Plus ไม่ได้ (ไม่ใช่สินค้า SCG)"
- แสดงทั้งหน่วยฐานและหน่วยใหญ่ (≈ พาเลท) ผู้ใช้แก้จำนวนได้; บรรทัดที่เป็น 0 ไม่ถูกส่ง
- ส่งตรงหน้างานลูกค้า (`ship_to = site`) → `suggested = need` (ไม่หักสต็อกร้าน) และ order นี้ไม่นับเป็น incoming ของร้าน

ERP internal `GET /api/promptplus/orders/suggest?sourceDocNo=SO2610-0009`:
```json
{
  "sourceDocNo": "SO2610-0009",
  "lines": [
    { "productId": "p1", "sku": "SCG-CEM-T50", "scgCode": "SCG-CEM-T50", "name": "ปูนซีเมนต์ตราเสือ 50 กก.", "baseUnit": "ถุง", "need": "400", "onHand": "180", "incoming": "120", "suggested": "100" }
  ],
  "excluded": [ { "name": "ค่าขนส่ง", "reason": "NOT_SCG" } ]
}
```

### 9.2 `POST /v1/shops/{shopId}/orders`

Headers: `Authorization: Bearer …`, `Idempotency-Key: erp:charoen:pporder:SO2610-0009:7c0e2f7a-5d1b-4e8a-9f61-0c3a5b7d2e44`

```json
{
  "dealer_id": "DLR-0017",
  "requested_date": "2026-10-29",
  "ship_to": { "type": "shop" },
  "external_ref": { "system": "scg-shop-erp", "doc_type": "SO", "doc_no": "SO2610-0009", "url": "https://app.scgshop-erp.example/docs/SO2610-0009" },
  "note": "สั่งจาก SCG Shop ERP",
  "lines": [
    { "scg_code": "SCG-CEM-T50", "unit_code": "BAG", "qty": "100" }
  ]
}
```

ส่งตรงหน้างาน:
```json
{ "ship_to": { "type": "site", "name": "บ้านพักคุณอรุณ หมู่บ้านลดาวัลย์ แปลง 21", "address": "ต.หนองจ๊อม อ.สันทราย จ.เชียงใหม่ 50210", "contact_name": "คุณอรุณ", "contact_phone": "0812345678" } }
```

Response `201 Created`:
```json
{
  "order_no": "PP-2610-00910",
  "status": "pending_dealer",
  "status_label": "รอผู้แทนยืนยัน",
  "created_at": "2026-10-27T10:12:00+07:00",
  "lines": [ { "line_no": 1, "scg_code": "SCG-CEM-T50", "qty": "100", "unit_price": null } ],
  "web_url": "https://app.promptplus.example/orders/PP-2610-00910"
}
```
ราคาเป็นของผู้แทนใน Prompt Plus (`unit_price` อาจเป็น null จนผู้แทนอนุมัติ — PP-Q09) ERP ไม่ส่งราคา

### 9.3 Mapping

| ERP | Prompt Plus request | หมายเหตุ |
|---|---|---|
| `SalesDoc.no` (`QT`/`SO`) | `external_ref.doc_no`, `doc_type` | |
| vendor ที่เลือก → `vendors.pp_dealer_id` | `dealer_id` | เลือกได้เฉพาะ vendor ที่มี `pp_dealer_id` |
| `products.scg_code` | `lines[].scg_code` | |
| จำนวนที่ผู้ใช้ยืนยัน (หน่วยฐาน) | `lines[].qty` + `unit_code` ของหน่วยฐาน | ERP ส่งหน่วยฐานเสมอ |
| ที่อยู่ลูกค้า (`Customer`) | `ship_to` (`site`) | |
| response `order_no` | `docs.pp_order_no` (ใหม่) + `pp_orders` | mockup ป้าย "PP PP-2610-00910" บนเอกสาร; audit `pporder-created` |

### 9.4 Error cases

| HTTP / code | ความหมาย | ERP ทำ |
|---|---|---|
| 422 `SKU_NOT_ORDERABLE` (`details.scg_codes`) | สินค้าสั่งไม่ได้กับผู้แทนนี้ | แสดงรายการ ให้แก้แล้วส่งใหม่ |
| 422 `DEALER_NOT_LINKED` | ร้านไม่ได้ผูกผู้แทนนี้ | sync dealers ใหม่ |
| 409 `IDEMPOTENCY_KEY_REUSED` | key เดิม body ต่าง | สร้าง attemptUuid ใหม่ |
| 409 `DUPLICATE_EXTERNAL_REF` (`details.order_no`) | เอกสารนี้มี order แล้ว | ผูก `pp_order_no` ตามที่ PP ตอบ |
| timeout / 5xx | ไม่รู้ผล | retry ด้วย key เดิม (ปลอดภัย); เกิน 5 ครั้ง → แสดง "ยังไม่ทราบผล" + ปุ่มตรวจสอบ (`GET orders?external_ref=`) |
| void QT/SO ต้นทาง | — | **ไม่ยกเลิก order อัตโนมัติ** แจ้งให้ติดต่อผู้แทน (mockup) |

### 9.5 Acceptance tests
- **AT-PP-60** SO มีปูน 400 ถุง, สต็อก 180, incoming 120 → แนะนำ 100
- **AT-PP-61** สต็อก 500 → แนะนำ 0 และบรรทัดนี้ไม่ถูกส่งถ้าผู้ใช้ไม่แก้
- **AT-PP-62** สินค้าไม่ใช่ SCG ไม่อยู่ใน request และแสดงหมายเหตุ
- **AT-PP-63** สร้างสำเร็จ → `SO2610-0009` มี `pp_order_no = PP-2610-00910`, ปุ่ม "สั่งของ Prompt Plus" หายไป, แถวใหม่ใน "สินค้ากำลังมา" เมื่อ `order.approved`
- **AT-PP-64** timeout แล้ว retry ด้วย key เดิม → PP มี order เดียว
- **AT-PP-65** ผู้ใช้ไม่มีสิทธิ์ `sales.doc` → 403; on-prem → route ไม่มี (`NOT_FOUND`)

---

## 10. Webhook event catalog

ทุก event ส่งไปที่ `POST /hooks/promptplus/v1/events` ใช้ envelope + signature ตาม README §10

| `type` | เมื่อไร | Business dedupe key | ERP ทำ | Schema |
|---|---|---|---|---|
| `order.approved` | ผู้แทนอนุมัติ order | `order_no` + `updated_at` | upsert `pp_orders` → สินค้ากำลังมา | [`order.approved`](schemas/promptplus/order.approved.schema.json) |
| `order.status_changed` *(เสนอ)* | สถานะ/ETA เปลี่ยน | `order_no` + `updated_at` | อัปเดตสถานะ (ไม่ย้อนตาม `updated_at`) | ใช้ schema เดียวกับ `order.approved` |
| `order.cancelled` | ยกเลิก order | `order_no` | เอาออกจาก incoming; ใบร่างที่ยังไม่ยืนยัน → `cancelled`; ถ้ามี GR แล้ว → แจ้งเตือนเท่านั้น | [`order.cancelled`](schemas/promptplus/order.cancelled.schema.json) |
| `delivery.succeeded` | DM ส่งสำเร็จ | `delivery_no` + `line_no` (BR-01) | ใบรับของร่าง | [`delivery.succeeded`](schemas/promptplus/delivery.succeeded.schema.json) |
| `delivery.recorded_by_dealer` | ผู้แทนบันทึกการส่งเอง | `delivery_no` + `line_no` | ใบรับของร่าง (กฎ OQ-09) | [`delivery.recorded_by_dealer`](schemas/promptplus/delivery.recorded_by_dealer.schema.json) |
| `product.updated` *(optional)* | master เปลี่ยน | `scg_code` + `updated_at` | sync สินค้านั้น | — (ใช้ product resource §4.1) |

ตัวอย่าง `order.cancelled`:
```json
{
  "id": "evt_01JBD0QZ3N8M6K4J2H1G9F7E5D",
  "type": "order.cancelled",
  "api_version": "2026-10-01",
  "occurred_at": "2026-10-23T11:00:00+07:00",
  "shop_id": "PP-SHOP-104552",
  "data": {
    "order_no": "PP-2610-00901",
    "cancelled_at": "2026-10-23T10:58:00+07:00",
    "cancelled_by": "dealer",
    "reason": "สินค้าหมดสต็อกที่ผู้แทน",
    "external_ref": null
  }
}
```

---

## 11. Error cases รวม (ฝั่ง Prompt Plus API)

| HTTP | `code` | ERP ทำ |
|---|---|---|
| 401 | `UNAUTHORIZED` | ขอ token ใหม่ 1 ครั้งแล้ว retry |
| 403 | `SHOP_NOT_LINKED` | ปิด integration ของร้านนั้น + alert admin |
| 404 | `NOT_FOUND` (order/DN/product) | แสดง "ไม่พบใน Prompt Plus" |
| 409 | `IDEMPOTENCY_KEY_REUSED`, `IN_PROGRESS`, `DUPLICATE_EXTERNAL_REF` | ตาม §9.4 |
| 422 | `SKU_NOT_ORDERABLE`, `DEALER_NOT_LINKED`, `INVALID_UNIT`, `ORDER_NOT_RECEIVABLE` | แสดง `message` ให้ผู้ใช้ |
| 429 | `RATE_LIMITED` | เคารพ `Retry-After` |
| 5xx | `INTERNAL`, `UNAVAILABLE` | retry + backoff; งาน background ทำต่อภายหลัง |

## 12. Non-functional
- ERP timeout ต่อ call ไป Prompt Plus: 5 วินาที (ตรงกับ `PromptPlusClient.timeoutMs`), งาน background retry ตาม README §9
- การกระทำที่ผู้ใช้รอ (สร้าง order): timeout รวม 15 วินาที แล้วแสดงสถานะ "ยังไม่ทราบผล"
- ทุก event/การเรียกถูก audit (BR-18) ด้วย action: `pp-event-received`, `gr-draft-created`, `gr-confirmed`, `pporder-created`, `pp-conflict-resolved`

## 13. Open questions
ดู [`README.md` §15.1](README.md#151-ทีม-prompt-plus) (PP-Q01 … PP-Q11) และ ERP-Q02/Q03
