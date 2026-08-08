/**
 * End-to-end smoke tests against the real app in a real browser (Chromium).
 * Covers the critical user paths without model downloads: page load, text
 * conversion (direct decode), office conversion (doc worker + anydoc-wasm),
 * error surfacing, and history persistence across reloads.
 */
import { test, expect, type Page } from '@playwright/test';
import { makeDocx } from './fixtures';

const fileInput = 'input[type="file"]';
const cardBody = (page: Page, n = 0) => page.locator('.card .body').nth(n);

async function convertFile(
  page: Page,
  payload: { name: string; buffer: Buffer; mimeType: string },
  opts: { timeout?: number } = {},
): Promise<void> {
  await page.setInputFiles(fileInput, payload);
  await expect(page.locator('.card')).toHaveCount(1, { timeout: opts.timeout ?? 15_000 });
}

test('app loads and shows the drop zone', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Arca/);
  await expect(page.locator('.dropzone')).toBeVisible();
  await expect(page.locator('.dropzone')).toContainText('Drop files here or click to browse');
  await expect(page.locator('.empty')).toContainText('No conversions yet');
});

test('converts a plain text file into a markdown card', async ({ page }) => {
  await page.goto('/');
  await convertFile(page, {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('line one\nline two\n', 'utf8'),
  });
  const body = cardBody(page);
  await expect(body).toContainText('line one');
  await expect(body).toContainText('line two');
  await expect(page.locator('.card .badge').first()).toContainText('text');
  await expect(page.locator('.card')).toContainText('Copy');
  await expect(page.locator('.card')).toContainText('Download');
});

test('shows an error card for unrecognizable content', async ({ page }) => {
  await page.goto('/');
  await convertFile(page, {
    name: 'garbage.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff]),
  });
  await expect(page.locator('.card.error')).toHaveCount(1);
  await expect(page.locator('.card.error .error-msg')).toBeVisible();
  await expect(page.locator('.card.error .error-msg')).toContainText(/unsupported|support/i);
});

test('extracts text from a docx through the office worker', async ({ page }) => {
  await page.goto('/');
  await convertFile(page, {
    name: 'sample.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(makeDocx('Hello from the e2e docx fixture')),
  }, { timeout: 45_000 });
  await expect(cardBody(page)).toContainText('Hello from the e2e docx fixture');
  await expect(page.locator('.card .badge').first()).toContainText('Word document');
});

test('persists conversion history across reload', async ({ page }) => {
  await page.goto('/');
  await convertFile(page, {
    name: 'keep.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('persist me', 'utf8'),
  });
  await expect(cardBody(page)).toContainText('persist me');

  await page.reload();
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(cardBody(page)).toContainText('persist me');
});

test('reports conversion progress while a job runs', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles(fileInput, {
    name: 'slow.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(makeDocx('progress fixture')),
  });
  await expect(page.locator('.job')).toHaveCount(1);
  await expect(page.locator('.job .bar')).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(1, { timeout: 45_000 });
  await expect(cardBody(page)).toContainText('progress fixture');
});

test('downloads all results as a ZIP archive', async ({ page }) => {
  await page.goto('/');
  await convertFile(page, {
    name: 'zipme.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('zip me up', 'utf8'),
  });
  await expect(cardBody(page)).toContainText('zip me up');

  const downloadPromise = page.waitForEvent('download');
  await page.click('.dlall-btn');
  await page.click('.dlall-menu button:has-text("ZIP archive")');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^arca-conversions-.*\.zip$/);
  const stream = await download.createReadStream();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream!.on('data', (c) => chunks.push(Buffer.from(c)));
    stream!.on('end', () => resolve(Buffer.concat(chunks)));
    stream!.on('error', reject);
  });
  // Local file header signature + "zipme.md" entry name, stored (method 0).
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
  expect(bytes.toString('latin1')).toContain('zipme.md');
  expect(bytes.toString('latin1')).toContain('zip me up');
});

test('downloads all results as combined Markdown', async ({ page }) => {
  await page.goto('/');
  await convertFile(page, {
    name: 'combine.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('combined body', 'utf8'),
  });
  await expect(cardBody(page)).toContainText('combined body');

  const downloadPromise = page.waitForEvent('download');
  await page.click('.dlall-btn');
  await page.click('.dlall-menu button:has-text("Combined Markdown")');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^arca-conversions-.*\.md$/);
  const stream = await download.createReadStream();
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream!.on('data', (c) => chunks.push(Buffer.from(c)));
    stream!.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream!.on('error', reject);
  });
  expect(text).toContain('## combine.txt');
  expect(text).toContain('combined body');
});

test('edits a result and persists the change', async ({ page }) => {
  await page.goto('/');
  await convertFile(page, {
    name: 'editable.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('original text', 'utf8'),
  });
  await expect(cardBody(page)).toContainText('original text');

  await page.click('button:has-text("Edit")');
  const area = page.locator('.card .edit-area');
  await expect(area).toBeVisible();
  await area.fill('edited text');
  await page.click('button:has-text("Save")');

  await expect(page.locator('.card .body')).toContainText('edited text');
  await expect(page.locator('.card .body')).not.toContainText('original text');

  // Persisted: survives reload.
  await page.reload();
  await expect(page.locator('.card .body')).toContainText('edited text');
});

test('cancels editing without keeping the draft', async ({ page }) => {
  await page.goto('/');
  await convertFile(page, {
    name: 'cancel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('keep me', 'utf8'),
  });
  await expect(cardBody(page)).toContainText('keep me');

  await page.click('button:has-text("Edit")');
  await page.locator('.card .edit-area').fill('discarded draft');
  await page.click('button:has-text("Cancel")');

  await expect(page.locator('.card .body')).toContainText('keep me');
  await expect(page.locator('.card .body')).not.toContainText('discarded draft');
});

test('routes a pasted PNG through the converter', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    ]);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
  });
  // The pasted file was detected (PNG magic bytes) and routed into a job; the
  // tiny undecodable payload surfaces as an error card, which is still proof
  // the clipboard path fed the converter.
  await expect(page.locator('.job')).toHaveCount(1);
  await expect(page.locator('.card.error')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('.card .card-title')).toContainText(/^pasted-/);
});
