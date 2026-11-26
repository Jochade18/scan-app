// Minimaler PDF-Schreiber: eine Seite pro Bild, 1-Bit-Schwarz-Weiß, verlustfrei komprimiert.
import { DPI } from './scan.js';

const enc = new TextEncoder();

async function deflate(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** pages: [{bits, w, h}] -> Blob (application/pdf) */
export async function buildPdf(pages, title = 'Scan') {
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (data) => {
    const u = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(u);
    pos += u.length;
  };
  const obj = (num, body) => {
    offsets[num] = pos;
    push(`${num} 0 obj\n${body}\nendobj\n`);
  };
  const streamObj = (num, dict, data) => {
    offsets[num] = pos;
    push(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
    push(data);
    push('\nendstream\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  const safeTitle = title.replace(/[\\()]/g, '').replace(/[^\x20-\x7E]/g, '_');
  obj(3, `<< /Title (${safeTitle}) /Producer (Scan App) /CreationDate (${pdfDate(new Date())}) >>`);

  for (let i = 0; i < n; i++) {
    const { bits, w, h } = pages[i];
    const base = 4 + i * 3;
    const pw = ((w * 72) / DPI).toFixed(2);
    const ph = ((h * 72) / DPI).toFixed(2);
    obj(base, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
      `/Resources << /XObject << /Im0 ${base + 2} 0 R >> >> /Contents ${base + 1} 0 R >>`);
    streamObj(base + 1, '', enc.encode(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`));
    const packed = await deflate(bits);
    const imgDict = `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 1` + (packed ? ' /Filter /FlateDecode' : '');
    streamObj(base + 2, imgDict, packed || bits);
  }

  const total = 4 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
