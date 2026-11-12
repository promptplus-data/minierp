/** Shared steps of the sales e2e specs. */
import { expect, type Locator } from '@playwright/test';

/** Choose the row containing `contains`: a SearchSelect picker (type to search, click the row) or a plain <select>. */
export async function pick(sel: Locator, contains: string, typed = contains) {
  await expect(sel).toBeVisible();
  if ((await sel.evaluate((e) => e.tagName)) !== 'SELECT') {
    const input = sel.locator('input[role="combobox"]');
    await input.click();
    await input.fill(typed);
    // the list is portalled to <body>: reach it through the combobox's aria-controls
    const list = sel.page().locator(`[id="${await input.getAttribute('aria-controls')}"]`);
    const row = list.locator('li[role="option"]').filter({ hasText: contains }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(list).toHaveCount(0);
    return;
  }
  await expect(sel.locator('option').filter({ hasText: contains }).first()).toBeAttached();
  const opts = await sel.locator('option').allTextContents();
  const hit = opts.find((o) => o.includes(contains));
  if (!hit) throw new Error(`"${contains}" not in ${opts.join(' | ')}`);
  await sel.selectOption({ label: hit });
}

