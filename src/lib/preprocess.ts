/**
 * Pure image-preprocessing helpers for OCR. No DOM/worker dependencies, so
 * they are directly unit-testable in Node. Everything operates on flat
 * grayscale arrays + dimensions; the worker packs results into ImageData.
 */

/** BT.601 luma of RGBA (stride 4) → [0..255] grayscale. */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
  }
  return out;
}

/** Otsu's method: threshold maximizing between-class variance. */
export function otsuThreshold(gray: Uint8Array, w: number, h: number): number {
  const hist = new Uint32Array(256);
  const n = w * h;
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0;
  let maxVar = -1, best = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    // `>=` keeps the upper bound of the flat maximum region, so ink
    // (`gray < thresh`) is never dropped at the threshold boundary.
    if (between >= maxVar) {
      maxVar = between;
      best = t;
    }
  }
  return best;
}

/** Binary ink map: 1 where below threshold (dark), 0 elsewhere. */
export function binarize(gray: Uint8Array, w: number, h: number, thresh: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = gray[i] < thresh ? 1 : 0;
  return out;
}

/** Bounding box of ink pixels with a small margin, or null when empty. */
export function inkBox(
  bin: Uint8Array,
  w: number,
  h: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (bin[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const margin = Math.max(4, Math.round(Math.min(w, h) * 0.02));
  return {
    x0: Math.max(0, minX - margin),
    y0: Math.max(0, minY - margin),
    x1: Math.min(w - 1, maxX + margin),
    y1: Math.min(h - 1, maxY + margin),
  };
}

/** 3×3 median filter — removes salt-and-pepper noise while keeping edges. */
export function median3(gray: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const win = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) win[k++] = gray[yy * w + xx];
        }
      }
      for (let i = 1; i < k; i++) {
        const v = win[i];
        let j = i - 1;
        while (j >= 0 && win[j] > v) {
          win[j + 1] = win[j];
          j--;
        }
        win[j + 1] = v;
      }
      out[y * w + x] = win[k >> 1];
    }
  }
  return out;
}

/**
 * Estimate page skew (degrees) by sweeping rotation angles and scoring how
 * "stripey" the horizontal projection gets: aligned text rows line up, giving
 * high variance across row sums. Negative = needs CW rotation to fix.
 */
export function estimateSkew(bin: Uint8Array, w: number, h: number): number {
  const ROT_STEP = 0.5;
  const MAX_ANGLE = 10;
  let bestAngle = 0;
  let bestScore = -1;
  for (let a = -MAX_ANGLE; a <= MAX_ANGLE; a += ROT_STEP) {
    const rot = rotateBinary(bin, w, h, (a * Math.PI) / 180);
    const rows = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) s += rot[y * w + x];
      rows[y] = s;
    }
    const mean = rows.reduce((a2, b2) => a2 + b2, 0) / h;
    let score = 0;
    for (let y = 0; y < h; y++) score += (rows[y] - mean) * (rows[y] - mean);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = a;
    }
  }
  return bestAngle;
}

/** Rotate a binary image by `rad` (counter-clockwise), 0-filling. */
export function rotateBinary(bin: Uint8Array, w: number, h: number, rad: number): Uint8Array {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = Math.round(cx + dx * cos - dy * sin);
      const sy = Math.round(cy + dx * sin + dy * cos);
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * w + x] = bin[sy * w + sx];
    }
  }
  return out;
}

/** Rotate grayscale by `rad` (counter-clockwise), 255-filling. */
export function rotateGray(gray: Uint8Array, w: number, h: number, rad: number): Uint8Array {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const out = new Uint8Array(w * h);
  out.fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = Math.round(cx + dx * cos - dy * sin);
      const sy = Math.round(cy + dx * sin + dy * cos);
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * w + x] = gray[sy * w + sx];
    }
  }
  return out;
}

/** Auto-contrast stretch so faint ink becomes clearly black/white. */
export function contrastStretch(gray: Uint8Array): Uint8Array {
  let min = 255, max = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 40) return gray;
  const out = new Uint8Array(gray.length);
  const scale = 255 / (max - min);
  for (let i = 0; i < out.length; i++) out[i] = Math.round((gray[i] - min) * scale);
  return out;
}
