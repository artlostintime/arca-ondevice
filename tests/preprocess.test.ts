import { describe, expect, it } from 'vitest';
import {
  binarize,
  contrastStretch,
  estimateSkew,
  inkBox,
  median3,
  otsuThreshold,
  rotateBinary,
  rotateGray,
  toGray,
} from '../src/lib/preprocess';

function gray(width: number, height: number, fill: number): Uint8Array {
  return new Uint8Array(width * height).fill(fill);
}

/** Paint solid ink rectangles into a grayscale array (value = ink shade). */
function paintInk(g: Uint8Array, w: number, rects: { x: number; y: number; w: number; h: number; v: number }[]): void {
  for (const r of rects) {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        g[(r.y + y) * w + (r.x + x)] = r.v;
      }
    }
  }
}

describe('otsuThreshold', () => {
  it('separates dark ink from light paper', () => {
    const g = gray(100, 100, 250);
    paintInk(g, 100, [{ x: 10, y: 10, w: 40, h: 20, v: 20 }]);
    const t = otsuThreshold(g, 100, 100);
    expect(t).toBeGreaterThanOrEqual(20);
    expect(t).toBeLessThanOrEqual(250);
  });

  it('returns a sane value for a flat image', () => {
    const t = otsuThreshold(gray(50, 50, 200), 50, 50);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(255);
  });
});

describe('binarize', () => {
  it('marks dark pixels as ink (1)', () => {
    const g = new Uint8Array([250, 30, 250, 250]);
    const b = binarize(g, 2, 2, 128);
    expect(Array.from(b)).toEqual([0, 1, 0, 0]);
  });
});

describe('inkBox', () => {
  it('finds the ink bounding box with a margin', () => {
    const g = gray(100, 100, 250);
    paintInk(g, 100, [{ x: 20, y: 30, w: 10, h: 10, v: 10 }]);
    const box = inkBox(binarize(g, 100, 100, 128), 100, 100);
    expect(box).not.toBeNull();
    expect(box!.x0).toBeLessThanOrEqual(20);
    expect(box!.x1).toBeGreaterThanOrEqual(29);
    expect(box!.y0).toBeLessThanOrEqual(30);
    expect(box!.y1).toBeGreaterThanOrEqual(39);
  });

  it('returns null for an all-white image', () => {
    expect(inkBox(binarize(gray(20, 20, 255), 20, 20, 128), 20, 20)).toBeNull();
  });
});

describe('median3', () => {
  it('removes isolated salt-and-pepper noise', () => {
    const g = gray(5, 5, 200);
    g[2 * 5 + 2] = 0; // single dark speck on a light field
    const m = median3(g, 5, 5);
    expect(m[2 * 5 + 2]).toBeGreaterThan(100);
  });

  it('preserves a solid ink region', () => {
    const g = gray(9, 9, 250);
    paintInk(g, 9, [{ x: 3, y: 3, w: 3, h: 3, v: 10 }]);
    const m = median3(g, 9, 9);
    expect(m[4 * 9 + 4]).toBeLessThan(128);
  });
});

describe('contrastStretch', () => {
  it('spreads a narrow dynamic range to full scale', () => {
    const g = new Uint8Array([100, 100, 200, 200, 150, 150, 130, 130]);
    const s = contrastStretch(g);
    expect(Math.min(...s)).toBe(0);
    expect(Math.max(...s)).toBe(255);
  });

  it('leaves flat images untouched', () => {
    const g = gray(10, 10, 210);
    expect(contrastStretch(g)).toEqual(g);
  });
});

describe('rotateBinary / rotateGray', () => {
  it('rotating by 2π keeps the content (white fill)', () => {
    const g = gray(8, 8, 250);
    paintInk(g, 8, [{ x: 2, y: 2, w: 4, h: 4, v: 10 }]);
    const r = rotateGray(g, 8, 8, 2 * Math.PI);
    expect(r[3 * 8 + 3]).toBe(10);
  });

  it('rotating 90° counter-clockwise moves ink from the top row to the left column', () => {
    const bin = new Uint8Array(8 * 8);
    for (let x = 0; x < 8; x++) bin[x] = 1; // top row
    const r = rotateBinary(bin, 8, 8, Math.PI / 2);
    let leftCol = 0;
    for (let y = 0; y < 8; y++) if (r[y * 8]) leftCol++;
    expect(leftCol).toBeGreaterThan(5);
  });
});

describe('estimateSkew', () => {
  it('reports ~0° for a straight text block', () => {
    const w = 200, h = 120;
    const g = gray(w, h, 250);
    // Five straight, equally spaced text lines.
    for (let row = 0; row < 5; row++) {
      paintInk(g, w, [{ x: 20, y: 10 + row * 20, w: 160, h: 6, v: 10 }]);
    }
    const bin = binarize(g, w, h, 128);
    const angle = estimateSkew(bin, w, h);
    expect(Math.abs(angle)).toBeLessThanOrEqual(1);
  });

  it('detects a skewed text block', () => {
    const w = 200, h = 120;
    const g = gray(w, h, 250);
    for (let row = 0; row < 5; row++) {
      paintInk(g, w, [{ x: 20, y: 10 + row * 20, w: 160, h: 6, v: 10 }]);
    }
    const skew = (4 * Math.PI) / 180;
    const bin = binarize(g, w, h, 128);
    const skewed = rotateBinary(bin, w, h, skew);
    const angle = estimateSkew(skewed, w, h);
    // The rotation makes the lines slanted; the estimator should correct
    // towards the opposite sign (and never pick 0° as the best).
    expect(Math.abs(angle)).toBeGreaterThanOrEqual(1);
    expect(Math.sign(angle)).not.toBe(Math.sign((skew * 180) / Math.PI));
  });
});

describe('toGray', () => {
  it('computes BT.601 luma', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const g = toGray(rgba, 2, 1);
    expect(g[0]).toBeCloseTo(76, -1); // pure red → dark
    expect(g[1]).toBeCloseTo(150, -1); // pure green → brighter
  });
});
