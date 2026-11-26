// Bildverarbeitung: Dokument finden, entzerren, in Schwarz-Weiß umwandeln.
// Läuft komplett lokal im Browser, ohne Bibliotheken und ohne Netzwerk.

export const DPI = 200;
const A4_LONG = 2339; // 297 mm bei 200 dpi
const A4_SHORT = 1654; // 210 mm bei 200 dpi
const A4_RATIO = A4_LONG / A4_SHORT;

/** Bild-Datei dekodieren und auf maxSide verkleinert in ein Canvas zeichnen. */
export async function decodeToCanvas(blob, maxSide) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function freeCanvas(c) {
  c.width = 0;
  c.height = 0;
}

/** Ecken in Reihenfolge oben-links, oben-rechts, unten-rechts, unten-links bringen. */
export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)
  );
  let first = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i][0] + sorted[i][1] < sorted[first][0] + sorted[first][1]) first = i;
  }
  return [0, 1, 2, 3].map((i) => sorted[(first + i) % 4]);
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function defaultQuad(inset = 0.06) {
  const a = inset;
  const b = 1 - inset;
  return [[a, a], [b, a], [b, b], [a, b]];
}

/**
 * Dokument im Bild suchen. Gibt normierte Ecken (0..1) zurück.
 * Idee: Papier ist hell und wenig farbig. Größte helle Fläche suchen,
 * dann ihre äußersten Punkte als Ecken nehmen.
 */
export function detectQuad(canvas) {
  const S = 360;
  const s = Math.min(1, S / Math.max(canvas.width, canvas.height));
  const w = Math.max(8, Math.round(canvas.width * s));
  const h = Math.max(8, Math.round(canvas.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  freeCanvas(c);

  const n = w * h;
  let g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], gg = d[j + 1], b = d[j + 2];
    const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
    const sat = Math.max(r, gg, b) - Math.min(r, gg, b);
    g[i] = lum - 0.6 * sat;
  }
  g = boxBlur(g, w, h, 2);

  // Otsu-Schwelle
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }

  // Größte zusammenhängende helle Fläche
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  let bestLabel = 0, bestCount = 0, label = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] || g[i] <= thr) continue;
    label++;
    let sp = 0, count = 0;
    stack[sp++] = i;
    labels[i] = label;
    while (sp) {
      const p = stack[--sp];
      count++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !labels[p - 1] && g[p - 1] > thr) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && !labels[p + 1] && g[p + 1] > thr) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && !labels[p - w] && g[p - w] > thr) { labels[p - w] = label; stack[sp++] = p - w; }
      if (y < h - 1 && !labels[p + w] && g[p + w] > thr) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    if (count > bestCount) { bestCount = count; bestLabel = label; }
  }
  if (bestCount < 0.08 * n) return defaultQuad();

  let tl, tr, br, bl, top, right, bottom, left;
  let mins = Infinity, maxs = -Infinity, mind = Infinity, maxd = -Infinity;
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== bestLabel) continue;
      const sm = x + y, df = x - y;
      if (sm < mins) { mins = sm; tl = [x, y]; }
      if (sm > maxs) { maxs = sm; br = [x, y]; }
      if (df > maxd) { maxd = df; tr = [x, y]; }
      if (df < mind) { mind = df; bl = [x, y]; }
      if (y < minY) { minY = y; top = [x, y]; }
      if (y > maxY) { maxY = y; bottom = [x, y]; }
      if (x < minX) { minX = x; left = [x, y]; }
      if (x > maxX) { maxX = x; right = [x, y]; }
    }
  }
  const candA = [tl, tr, br, bl];
  const candB = orderQuad([top, right, bottom, left]);
  const q = quadArea(candB) > quadArea(candA) * 1.05 ? candB : candA;
  return q.map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) { s += src[y * w + xx]; c++; }
      }
      tmp[y * w + x] = s / c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; }
      }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

/** Projektive Abbildung Einheitsquadrat -> Viereck (Heckbert). */
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  let g = 0, h = 0;
  if (Math.abs(den) > 1e-9 && (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9)) {
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return {
    a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
    d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0,
    g, h,
  };
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Größe der entzerrten Seite. Fast-A4 wird auf exakt A4 gesetzt. */
function outputSize(q) {
  const w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const r = h / w;
  if (Math.abs(r / A4_RATIO - 1) < 0.12) return { w: A4_SHORT, h: A4_LONG };
  if (Math.abs(1 / r / A4_RATIO - 1) < 0.12) return { w: A4_LONG, h: A4_SHORT };
  const s = A4_LONG / Math.max(w, h);
  return { w: Math.max(16, Math.round(w * s)), h: Math.max(16, Math.round(h * s)) };
}

function warpGray(src, sw, sh, q, ow, oh) {
  const H = squareToQuad(q);
  const out = new Uint8Array(ow * oh);
  const maxX = sw - 1, maxY = sh - 1;
  for (let y = 0; y < oh; y++) {
    const v = (y + 0.5) / oh;
    const bx = H.b * v + H.c, by = H.e * v + H.f, bd = H.h * v + 1;
    for (let x = 0; x < ow; x++) {
      const u = (x + 0.5) / ow;
      const den = H.g * u + bd;
      let sx = (H.a * u + bx) / den - 0.5;
      let sy = (H.d * u + by) / den - 0.5;
      if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
      if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = sx - x0, fy = sy - y0;
      const r0 = y0 * sw, r1 = y1 * sw;
      const top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * fx;
      const bot = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * fx;
      out[y * ow + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

function rotate90(g, w, h) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w, col = h - 1 - y;
    for (let x = 0; x < w; x++) o[x * h + col] = g[row + x];
  }
  return { g: o, w: h, h: w };
}

function integralOf(g, w, h) {
  const W1 = w + 1;
  const I = new Uint32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row;
    }
  }
  return I;
}

/**
 * Foto -> entzerrte Graustufen-Seite. Ergebnis wird für die Vorschau
 * zwischengespeichert, damit der Schwellen-Regler flüssig reagiert.
 */
export async function prepare(blob, quadNorm, rot) {
  const c = await decodeToCanvas(blob, 3200);
  const sw = c.width, sh = c.height;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  freeCanvas(c);
  const src = new Uint8Array(sw * sh);
  for (let i = 0, j = 0; i < src.length; i++, j += 4) {
    src[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  }
  const q = orderQuad(quadNorm.map(([x, y]) => [x * sw, y * sh]));
  const { w, h } = outputSize(q);
  let page = { g: warpGray(src, sw, sh, q, w, h), w, h };
  for (let i = 0; i < (rot & 3); i++) page = rotate90(page.g, page.w, page.h);
  page.I = integralOf(page.g, page.w, page.h);
  return page;
}

export function rotatePrepared(p) {
  const r = rotate90(p.g, p.w, p.h);
  r.I = integralOf(r.g, r.w, r.h);
  return r;
}

/**
 * Schwarz-Weiß wie ein Bürokopierer (adaptive Schwelle nach Bradley).
 * sens: 0..1, höher = mehr wird schwarz.
 * Rückgabe: 1 Bit pro Pixel, gepackt (1 = weiß), Zeilen auf Bytes aufgefüllt.
 */
export function binarize(p, sens) {
  const { g, w, h, I } = p;
  const W1 = w + 1;
  const r = Math.max(8, Math.round(Math.min(w, h) / 24));
  const k = 1 - (0.04 + sens * 0.3);
  const absDark = 40 + sens * 40;
  const bw = new Uint8Array(w * h); // 1 = schwarz
  for (let y = 0; y < h; y++) {
    const y0 = y > r ? y - r : 0;
    const y1 = y + r < h ? y + r : h - 1;
    const rowA = y0 * W1, rowB = (y1 + 1) * W1, hh = y1 - y0 + 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > r ? x - r : 0;
      const x1 = x + r < w ? x + r : w - 1;
      const sum = I[rowB + x1 + 1] - I[rowA + x1 + 1] - I[rowB + x0] + I[rowA + x0];
      const v = g[y * w + x];
      if (v * (x1 - x0 + 1) * hh < sum * k || v < absDark) bw[y * w + x] = 1;
    }
  }
  // Einzelne Störpixel entfernen
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!bw[i]) continue;
      if (!(bw[i - w - 1] | bw[i - w] | bw[i - w + 1] | bw[i - 1] | bw[i + 1] |
            bw[i + w - 1] | bw[i + w] | bw[i + w + 1])) bw[i] = 0;
    }
  }
  // Schmaler weißer Rand, damit keine Tischkante mitkommt
  const m = Math.round(Math.min(w, h) * 0.008);
  const rowBytes = (w + 7) >> 3;
  const bits = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const edgeY = y < m || y >= h - m;
    for (let x = 0; x < w; x++) {
      if (edgeY || x < m || x >= w - m || !bw[y * w + x]) {
        bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { bits, w, h };
}

/** Gepackte Bits in ein Canvas zeichnen, auf maxW Breite verkleinert. */
export function drawBits(page, target, maxW, maxH = Infinity) {
  const { bits, w, h } = page;
  const full = document.createElement('canvas');
  full.width = w;
  full.height = h;
  const fctx = full.getContext('2d');
  const img = fctx.createImageData(w, h);
  const px = new Uint32Array(img.data.buffer);
  const rowBytes = (w + 7) >> 3;
  const WHITE = 0xffffffff, BLACK = 0xff000000;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      px[y * w + x] = bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? WHITE : BLACK;
    }
  }
  fctx.putImageData(img, 0, 0);
  const s = Math.min(1, maxW / w, maxH / h);
  target.width = Math.max(1, Math.round(w * s));
  target.height = Math.max(1, Math.round(h * s));
  const ctx = target.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, target.width, target.height);
  freeCanvas(full);
}
