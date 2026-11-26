import {
  decodeToCanvas, detectQuad, defaultQuad, prepare, rotatePrepared, binarize, drawBits,
} from './scan.js';
import { buildPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);

// Alle Seiten liegen nur im Arbeitsspeicher. Nichts wird gespeichert oder gesendet.
// page: { blob, quad, rot, sens, bits, w, h, thumb }
const pages = [];
const queue = [];
let edit = null; // { blob, img, quad, rot, sens, index, prepared, result }

/* ---------- Hilfen ---------- */

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

async function busy(text, fn) {
  $('busy-text').textContent = text;
  $('busy').hidden = false;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    alert('Das hat leider nicht geklappt: ' + (err && err.message ? err.message : err));
    return undefined;
  } finally {
    $('busy').hidden = true;
  }
}

/* ---------- Startseite ---------- */

function renderPages() {
  const list = $('pages');
  list.textContent = '';
  pages.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'page';
    const img = document.createElement('img');
    img.src = p.thumb;
    img.alt = `Seite ${i + 1}`;
    img.addEventListener('click', () => openEditor(p.blob, i));
    const tools = document.createElement('div');
    tools.className = 'page-tools';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `Seite ${i + 1}`;
    tools.append(num,
      toolBtn('◀', 'Nach vorne', i === 0, () => move(i, -1)),
      toolBtn('▶', 'Nach hinten', i === pages.length - 1, () => move(i, 1)),
      toolBtn('✕', 'Löschen', false, () => remove(i), 'del'));
    li.append(img, tools);
    list.append(li);
  });
  $('empty').hidden = pages.length > 0;
  $('btn-clear').hidden = pages.length === 0;
  $('btn-export').disabled = pages.length === 0;
  $('btn-export').textContent = pages.length ? `PDF (${pages.length})` : 'PDF';
}

function toolBtn(label, title, disabled, onClick, cls = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.disabled = disabled;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function move(i, d) {
  const [p] = pages.splice(i, 1);
  pages.splice(i + d, 0, p);
  renderPages();
}

function remove(i) {
  if (!confirm(`Seite ${i + 1} löschen?`)) return;
  pages.splice(i, 1);
  renderPages();
}

$('btn-clear').addEventListener('click', () => {
  if (!confirm('Alle Seiten löschen?')) return;
  pages.length = 0;
  renderPages();
});

function onFiles(e) {
  const files = [...e.target.files].filter((f) => f.type.startsWith('image/') || !f.type);
  e.target.value = '';
  if (!files.length) return;
  queue.push(...files);
  nextInQueue();
}
$('in-camera').addEventListener('change', onFiles);
$('in-library').addEventListener('change', onFiles);

function nextInQueue() {
  const f = queue.shift();
  if (f) openEditor(f, -1);
  else show('home');
}

/* ---------- Ecken-Editor ---------- */

const cv = $('ed-canvas');
const view = { s: 1, ox: 0, oy: 0, dpr: 1 };
let drag = -1;

async function openEditor(blob, index) {
  await busy('Foto wird geladen …', async () => {
    const img = await decodeToCanvas(blob, 1600);
    const old = index >= 0 ? pages[index] : null;
    edit = {
      blob, img, index,
      quad: old ? old.quad.map((p) => [...p]) : detectQuad(img),
      rot: old ? old.rot : 0,
      sens: old ? old.sens : 0.35,
    };
    show('editor');
    layoutEditor();
  });
}

function layoutEditor() {
  if (!edit) return;
  const r = cv.getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * view.dpr);
  cv.height = Math.round(r.height * view.dpr);
  const pad = 28 * view.dpr;
  view.s = Math.min((cv.width - 2 * pad) / edit.img.width, (cv.height - 2 * pad) / edit.img.height);
  view.ox = (cv.width - edit.img.width * view.s) / 2;
  view.oy = (cv.height - edit.img.height * view.s) / 2;
  drawEditor();
}

const toScreen = ([x, y]) => [view.ox + x * edit.img.width * view.s, view.oy + y * edit.img.height * view.s];

function drawEditor(focus = -1) {
  const ctx = cv.getContext('2d');
  const { img } = edit;
  const dpr = view.dpr;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, view.ox, view.oy, img.width * view.s, img.height * view.s);

  const pts = edit.quad.map(toScreen);
  // Außerhalb abdunkeln
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cv.width, cv.height);
  ctx.moveTo(...pts[0]);
  for (let i = 1; i < 4; i++) ctx.lineTo(...pts[i]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill('evenodd');
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (let i = 1; i < 4; i++) ctx.lineTo(...pts[i]);
  ctx.closePath();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = '#4c9aff';
  ctx.stroke();

  pts.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, (i === focus ? 16 : 12) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(76,154,255,0.25)';
    ctx.fill();
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  });

  if (focus >= 0) drawLoupe(ctx, pts[focus], edit.quad[focus]);
}

// Lupe, damit man die Ecke unter dem Finger genau sieht
function drawLoupe(ctx, [sx, sy], [nx, ny]) {
  const dpr = view.dpr;
  const R = 62 * dpr;
  const zoom = 2.5;
  const leftSide = sx > cv.width / 2;
  const cx = leftSide ? R + 16 * dpr : cv.width - R - 16 * dpr;
  const cy = R + 16 * dpr;
  const { img } = edit;
  const px = nx * img.width, py = ny * img.height;
  const srcR = R / (view.s * zoom);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#222';
  ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  ctx.drawImage(img, px - srcR, py - srcR, 2 * srcR, 2 * srcR, cx - R, cy - R, 2 * R, 2 * R);
  // Viereck-Kanten auch in der Lupe zeigen
  ctx.beginPath();
  edit.quad.forEach(([qx, qy], i) => {
    const X = cx + (qx * img.width - px) * view.s * zoom;
    const Y = cy + (qy * img.height - py) * view.s * zoom;
    if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
  });
  ctx.closePath();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = '#4c9aff';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 10 * dpr, cy); ctx.lineTo(cx + 10 * dpr, cy);
  ctx.moveTo(cx, cy - 10 * dpr); ctx.lineTo(cx, cy + 10 * dpr);
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = '#ff3b30';
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function eventPoint(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) * view.dpr, (e.clientY - r.top) * view.dpr];
}

cv.addEventListener('pointerdown', (e) => {
  if (!edit) return;
  const [x, y] = eventPoint(e);
  let best = -1, bestD = 48 * view.dpr;
  edit.quad.map(toScreen).forEach(([qx, qy], i) => {
    const d = Math.hypot(qx - x, qy - y);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best < 0) return;
  drag = best;
  cv.setPointerCapture(e.pointerId);
  drawEditor(drag);
  e.preventDefault();
});

cv.addEventListener('pointermove', (e) => {
  if (drag < 0) return;
  const [x, y] = eventPoint(e);
  const nx = (x - view.ox) / (edit.img.width * view.s);
  const ny = (y - view.oy) / (edit.img.height * view.s);
  edit.quad[drag] = [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))];
  drawEditor(drag);
  e.preventDefault();
});

function endDrag() {
  if (drag < 0) return;
  drag = -1;
  drawEditor();
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => { if ($('editor').classList.contains('active')) layoutEditor(); });

$('ed-auto').addEventListener('click', () => { edit.quad = detectQuad(edit.img); drawEditor(); });
$('ed-full').addEventListener('click', () => { edit.quad = defaultQuad(0); drawEditor(); });
$('ed-cancel').addEventListener('click', () => { closeEdit(); nextInQueue(); });
$('ed-next').addEventListener('click', openResult);

function closeEdit() {
  if (edit && edit.img) { edit.img.width = 0; edit.img.height = 0; }
  edit = null;
}

/* ---------- Schwarz-Weiß-Vorschau ---------- */

const rs = $('rs-canvas');

async function openResult() {
  await busy('Seite wird gescannt …', async () => {
    edit.prepared = await prepare(edit.blob, edit.quad, edit.rot);
    $('rs-sens').value = Math.round(edit.sens * 100);
    show('result');
    updateResult();
  });
}

function updateResult() {
  edit.result = binarize(edit.prepared, edit.sens);
  const stage = rs.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  drawBits(edit.result, rs, (stage.width - 24) * dpr, (stage.height - 24) * dpr);
  rs.style.width = `${rs.width / dpr}px`;
  rs.style.height = `${rs.height / dpr}px`;
}

let sensFrame = 0;
$('rs-sens').addEventListener('input', (e) => {
  edit.sens = e.target.value / 100;
  cancelAnimationFrame(sensFrame);
  sensFrame = requestAnimationFrame(updateResult);
});

$('rs-rotate').addEventListener('click', () => busy('Wird gedreht …', async () => {
  edit.rot = (edit.rot + 1) % 4;
  edit.prepared = rotatePrepared(edit.prepared);
  updateResult();
}));

$('rs-back').addEventListener('click', () => {
  edit.prepared = null;
  show('editor');
  layoutEditor();
});

$('rs-ok').addEventListener('click', () => {
  const thumbCanvas = document.createElement('canvas');
  drawBits(edit.result, thumbCanvas, 360);
  const page = {
    blob: edit.blob,
    quad: edit.quad,
    rot: edit.rot,
    sens: edit.sens,
    ...edit.result,
    thumb: thumbCanvas.toDataURL('image/png'),
  };
  if (edit.index >= 0) pages[edit.index] = page;
  else pages.push(page);
  closeEdit();
  renderPages();
  nextInQueue();
});

/* ---------- PDF-Export ---------- */

let pdfUrl = null;
let pdfFile = null;

function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Scan_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function resetExport() {
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = null;
  pdfFile = null;
  $('ex-make').hidden = false;
  $('ex-share').hidden = true;
  $('ex-download').hidden = true;
}

$('btn-export').addEventListener('click', () => {
  resetExport();
  $('ex-name').value = defaultName();
  $('ex-info').textContent = `${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'}, Schwarz-Weiß, 200 dpi`;
  $('export').showModal();
});

$('ex-name').addEventListener('input', resetExport);

$('ex-make').addEventListener('click', () => busy('PDF wird erstellt …', async () => {
  let name = $('ex-name').value.trim().replace(/[\\/:*?"<>|]+/g, '-') || defaultName();
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  const blob = await buildPdf(pages, name.replace(/\.pdf$/i, ''));
  pdfFile = new File([blob], name, { type: 'application/pdf' });
  pdfUrl = URL.createObjectURL(blob);
  const dl = $('ex-download');
  dl.href = pdfUrl;
  dl.download = name;
  dl.hidden = false;
  $('ex-make').hidden = true;
  $('ex-share').hidden = !(navigator.canShare && navigator.canShare({ files: [pdfFile] }));
  $('ex-info').textContent = `${name} · ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
}));

$('ex-share').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [pdfFile], title: pdfFile.name });
  } catch (err) {
    if (err.name !== 'AbortError') alert('Teilen nicht möglich: ' + err.message);
  }
});

$('ex-close').addEventListener('click', () => $('export').close());

window.addEventListener('beforeunload', (e) => {
  if (pages.length) e.preventDefault();
});

renderPages();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
