import { test, expect } from '@playwright/test';

test('desktop screenshot of converter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'test-results/shot-desktop.png', fullPage: true });
});

test('mobile screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.mobile-btn')).toBeVisible();
  await page.screenshot({ path: 'test-results/shot-mobile.png', fullPage: true });
  // Open the menu and screenshot it open
  await page.locator('.mobile-btn').click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: 'test-results/shot-mobile-menu.png', fullPage: true });
});

test('settings view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.click('a.nav-link:has-text("Settings")');
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'test-results/shot-settings.png', fullPage: true });
});

test('with results visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('# Hello\nThis is a sample document.\n\n## Section two\nMore text here.\n', 'utf8'),
  });
  await expect(page.locator('.card')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/shot-results.png', fullPage: true });
});
