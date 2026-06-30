import { test, expect } from '@playwright/test';

/**
 * Editor smoke: it boots, and the newer editor features (absorber tool + the
 * beacon/absorber goal-mode selector) are present in the DOM. Kept light.
 */
test('editor boots with the absorber tool and goal-mode selector', async ({ page }) => {
  await page.goto('/editor.html');

  await expect(page.locator('#canvas')).toBeVisible();

  // New editor features.
  await expect(page.locator('button.tool[data-tool="absorber"]')).toBeVisible();
  const goalMode = page.locator('#goal-mode');
  await expect(goalMode).toBeVisible();
  await expect(goalMode.locator('option[value="beacon"]')).toHaveCount(1);
  await expect(goalMode.locator('option[value="absorber"]')).toHaveCount(1);

  // Core tools + save/export are reachable (serialize path exists).
  await expect(page.locator('button.tool[data-tool="beacon"]')).toBeVisible();
  await expect(page.locator('#btn-export')).toBeVisible();
});
