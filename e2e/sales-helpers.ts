/** Shared steps of the sales e2e specs. */
import { expect, type Locator } from '@playwright/test';

/** Choose the row containing `contains`: a SearchSelect picker (type to search, click the row) or a plain <select>. */
export async function pick(sel: Locator, contains: string, typed = contains) {
  await expect(sel).toBeVisible();
  if ((await sel.evaluate((e) => e.tagName)) !== 'SELECT') {
    const input = sel.locator('input[role="combobox"]');
    await input.click();
    await input.fill(typed);
    const row = sel.locator('li[role="option"]').filter({ hasText: contains }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(sel.locator('[role="listbox"]')).toHaveCount(0);
    return;
  }
  await expect(sel.locator('option').filter({ hasText: contains }).first()).toBeAttached();
  const opts = await sel.locator('option').allTextContents();
  const hit = opts.find((o) => o.includes(contains));
  if (!hit) throw new Error(`"${contains}" not in ${opts.join(' | ')}`);
  await sel.selectOption({ label: hit });
}

