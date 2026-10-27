/**
 * M02 terms of use and consent (BR-15). The legal text is a PLACEHOLDER: the wording waits for SCG Legal and the
 * PDPA question OQ-04. Changing TERMS_VERSION makes every flagged shop's owner accept again before further use.
 */
export const TERMS_VERSION = '1.0-draft';
export const TERMS_TITLE = 'สัญญาการใช้งานและการยินยอมให้ข้อมูล';
export const TERMS_PLACEHOLDER = true;
export const TERMS_BODY: readonly string[] = [
  'ข้อ 1 ขอบเขตบริการ: SCG ให้บริการระบบบริหารร้านโดยไม่คิดค่าใช้จ่าย …',
  'ข้อ 2 ข้อมูลของร้าน: ร้านเป็นเจ้าของข้อมูล และส่งออกข้อมูลทั้งหมดได้ทุกเมื่อ …',
  'ข้อ 3 การใช้ข้อมูลโดย SCG: … (ข้อความรอฝ่ายกฎหมายร่าง)',
  'ข้อ 4 การเลิกใช้บริการ: …',
];
export interface TermsConsentDef { id: string; label: string; required: boolean }
export const TERMS_CONSENTS: readonly TermsConsentDef[] = [
  { id: 'terms', label: 'ยอมรับสัญญาการใช้งาน (จำเป็น)', required: true },
  { id: 'shareData', label: 'ยินยอมให้ SCG ใช้ข้อมูลขาย ซื้อ และสต็อกของร้าน ตามข้อ 3', required: false },
  { id: 'customerData', label: 'ยินยอมให้ส่งข้อมูลลูกค้าของร้าน (ข้อความรอฝ่ายกฎหมาย · OQ-04)', required: false },
];

/** Missing required consent ids (empty = acceptable). Unknown ids are ignored. */
export function missingConsents(consents: Readonly<Record<string, boolean>>, defs: readonly TermsConsentDef[] = TERMS_CONSENTS): string[] {
  return defs.filter((c) => c.required && consents[c.id] !== true).map((c) => c.id);
}
