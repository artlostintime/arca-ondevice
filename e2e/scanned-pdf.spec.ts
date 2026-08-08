/**
 * E2E for the scanned-PDF path: a real PDF whose pages are pure images (no
 * text layer) built in-browser, dropped through the drop zone. Exercises
 * pdf-inspector (page classify), main-thread pdfjs render, per-page OCR, and
 * merge — the full pipeline. Downloads PP-OCR models (~11 MB) on first run.
 */
import { test, expect } from '@playwright/test';

test('OCRs a scanned multi-page PDF page by page', async ({ page }) => {
  await page.goto('/');
  const pdf = await page.evaluate(() => {
    const enc = new TextEncoder();
    const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
      const o = new Uint8Array(a.length + b.length);
      o.set(a, 0);
      o.set(b, a.length);
      return o;
    };
    const mk = (text: string): { w: number; h: number; rgb: Uint8Array } => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 160;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 640, 160);
      g.fillStyle = '#000000';
      g.font = 'bold 52px sans-serif';
      g.textBaseline = 'middle';
      g.fillText(text, 24, 90);
      const d = g.getImageData(0, 0, 640, 160).data;
      const rgb = new Uint8Array(640 * 160 * 3);
      for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
        rgb[j] = d[i];
        rgb[j + 1] = d[i + 1];
        rgb[j + 2] = d[i + 2];
      }
      return { w: 640, h: 160, rgb };
    };

    // Minimal PDF: one image-only page per entry, uncompressed RGB.
    const images = [mk('PAGE ONE SCAN'), mk('PAGE TWO SCAN')];
    const n = images.length;
    const pageObj = (i: number) => 3 + 3 * i;
    const contObj = (i: number) => 4 + 3 * i;
    const imgObj = (i: number) => 5 + 3 * i;
    const bodies: (Uint8Array | null)[] = [null];
    bodies[1] = enc.encode('<< /Type /Catalog /Pages 2 0 R >>');
    bodies[2] = enc.encode(
      `<< /Type /Pages /Kids [${images.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${n} >>`,
    );
    for (let i = 0; i < n; i++) {
      const img = images[i];
      const content = `q\n${img.w} 0 0 ${img.h} 0 0 cm\n/Im${i} Do\nQ\n`;
      bodies[pageObj(i)] = enc.encode(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.w} ${img.h}] /Resources << /XObject << /Im${i} ${imgObj(i)} 0 R >> >> /Contents ${contObj(i)} 0 R >>`,
      );
      bodies[contObj(i)] = enc.encode(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
      bodies[imgObj(i)] = join(
        enc.encode(
          `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${img.rgb.length} >>\nstream\n`,
        ),
        join(img.rgb, enc.encode('\nendstream')),
      );
    }

    const chunks: Uint8Array[] = [enc.encode('%PDF-1.4\n')];
    const offsets: number[] = [];
    let pos = chunks[0].length;
    for (let o = 1; o < bodies.length; o++) {
      offsets[o] = pos;
      const head = enc.encode(`${o} 0 obj\n`);
      const tail = enc.encode('\nendobj\n');
      chunks.push(head, bodies[o]!, tail);
      pos += head.length + bodies[o]!.length + tail.length;
    }
    const xrefPos = pos;
    let xref = `xref\n0 ${bodies.length}\n0000000000 65535 f \n`;
    for (let o = 1; o < bodies.length; o++) xref += `${String(offsets[o]).padStart(10, '0')} 00000 n \n`;
    chunks.push(enc.encode(`${xref}trailer\n<< /Size ${bodies.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`));

    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  });

  await page.setInputFiles('input[type="file"]', {
    name: 'scan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf),
  });
  await expect(page.locator('.card')).toHaveCount(1, { timeout: 180_000 });

  await expect(page.locator('.card .badge').first()).toContainText('PDF document');
  const body = page.locator('.card .body');
  await expect(body).toContainText(/PAGE\s*ONE/i);
  await expect(body).toContainText(/PAGE\s*TWO/i);
});
