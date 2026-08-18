import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFString,
  PDFHexString,
  PDFFont,
  PDFOperator,
  beginText,
  endText,
  moveText,
  setFontAndSize,
  setFillingRgbColor,
  showText,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  fill,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FreeTextSystemFontAnnotation } from '@/types';

interface LocalFontQueryResult {
  postscriptName: string;
  blob: () => Promise<Blob>;
}

type QueryLocalFonts = (opts?: {
  postscriptNames?: string[];
}) => Promise<LocalFontQueryResult[]>;

export function extractTtcFace(
  bytes: Uint8Array,
  postscriptName: string
): Uint8Array {
  const u16 = (o: number) => ((bytes[o] ?? 0) << 8) | (bytes[o + 1] ?? 0);
  const u32 = (o: number) =>
    (((bytes[o] ?? 0) << 24) |
      ((bytes[o + 1] ?? 0) << 16) |
      ((bytes[o + 2] ?? 0) << 8) |
      (bytes[o + 3] ?? 0)) >>>
    0;
  if (bytes.length < 16 || u32(0) !== 0x74746366) return bytes;

  const numFonts = u32(8);
  if (numFonts === 0 || numFonts > 64) return bytes;
  const want = postscriptName.replace(/[\s-]/g, '').toLowerCase();

  const nameOf = (faceOff: number, nameId: number): string => {
    const numTables = u16(faceOff + 4);
    for (let i = 0; i < numTables; i++) {
      const rec = faceOff + 12 + i * 16;
      const tag = String.fromCharCode(
        bytes[rec] ?? 0,
        bytes[rec + 1] ?? 0,
        bytes[rec + 2] ?? 0,
        bytes[rec + 3] ?? 0
      );
      if (tag !== 'name') continue;
      const nt = u32(rec + 8);
      const count = u16(nt + 2);
      const strBase = nt + u16(nt + 4);
      for (let r = 0; r < count; r++) {
        const nr = nt + 6 + r * 12;
        if (u16(nr + 6) !== nameId) continue;
        const platform = u16(nr);
        const len = u16(nr + 8);
        const off = strBase + u16(nr + 10);
        if (platform === 3 || platform === 0) {
          let out = '';
          for (let k = 0; k + 1 < len; k += 2)
            out += String.fromCharCode(u16(off + k));
          return out;
        }
        let out = '';
        for (let k = 0; k < len; k++)
          out += String.fromCharCode(bytes[off + k] ?? 0);
        return out;
      }
    }
    return '';
  };

  let best = u32(12);
  let bestScore = -1;
  for (let f = 0; f < numFonts; f++) {
    const off = u32(12 + f * 4);
    if (off + 12 > bytes.length) continue;
    const ps = nameOf(off, 6).replace(/[\s-]/g, '').toLowerCase();
    const fam = nameOf(off, 1).replace(/[\s-]/g, '').toLowerCase();
    let score = 0;
    if (want && ps === want) score = 4;
    else if (want && fam && (want.startsWith(fam) || fam.startsWith(want)))
      score = 2;
    if (score > bestScore) {
      bestScore = score;
      best = off;
    }
  }

  const numTables = u16(best + 4);
  if (numTables === 0 || numTables > 64) return bytes;
  const records: Array<{ tag: string; sum: number; off: number; len: number }> =
    [];
  for (let i = 0; i < numTables; i++) {
    const rec = best + 12 + i * 16;
    records.push({
      tag: String.fromCharCode(
        bytes[rec] ?? 0,
        bytes[rec + 1] ?? 0,
        bytes[rec + 2] ?? 0,
        bytes[rec + 3] ?? 0
      ),
      sum: u32(rec + 4),
      off: u32(rec + 8),
      len: u32(rec + 12),
    });
  }
  const headerSize = 12 + numTables * 16;
  let total = headerSize;
  const placed = new Map<string, number>();
  for (const r of records) {
    const key = r.off + ':' + r.len;
    if (!placed.has(key)) {
      placed.set(key, total);
      total += (r.len + 3) & ~3;
    }
  }
  const out = new Uint8Array(total);
  const w16 = (o: number, v: number) => {
    out[o] = (v >> 8) & 0xff;
    out[o + 1] = v & 0xff;
  };
  const w32 = (o: number, v: number) => {
    out[o] = (v >>> 24) & 0xff;
    out[o + 1] = (v >>> 16) & 0xff;
    out[o + 2] = (v >>> 8) & 0xff;
    out[o + 3] = v & 0xff;
  };
  w32(0, u32(best));
  w16(4, numTables);
  let pow2 = 1;
  let entSel = 0;
  while (pow2 * 2 <= numTables) {
    pow2 *= 2;
    entSel++;
  }
  w16(6, pow2 * 16);
  w16(8, entSel);
  w16(10, (numTables - pow2) * 16);
  records.forEach((r, i) => {
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[rec + k] = r.tag.charCodeAt(k);
    w32(rec + 4, r.sum);
    const newOff = placed.get(r.off + ':' + r.len);
    if (newOff === undefined) return;
    w32(rec + 8, newOff);
    w32(rec + 12, r.len);
    out.set(bytes.subarray(r.off, r.off + r.len), newOff);
    if (r.tag === 'head' && r.len >= 12) w32(newOff + 8, 0);
  });
  return out;
}

async function fetchFontBytes(
  postscriptName: string
): Promise<Uint8Array | null> {
  const qlf = (window as unknown as { queryLocalFonts?: QueryLocalFonts })
    .queryLocalFonts;
  if (typeof qlf !== 'function') return null;
  try {
    const list = await qlf({ postscriptNames: [postscriptName] });
    if (list.length === 0) return null;
    const blob = await list[0].blob();
    return extractTtcFace(
      new Uint8Array(await blob.arrayBuffer()),
      postscriptName
    );
  } catch {
    return null;
  }
}

function subsetPrefix(postscriptName: string): string {
  let h = 0x811c9dc5;
  for (const c of postscriptName) {
    h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  }
  let prefix = '';
  for (let i = 0; i < 6; i++) {
    prefix += String.fromCharCode(65 + (((h >>> (i * 4)) & 0x0f) % 26));
    h = Math.imul(h, 0x01000193);
  }
  return prefix;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return m
    ? {
        r: parseInt(m[1], 16) / 255,
        g: parseInt(m[2], 16) / 255,
        b: parseInt(m[3], 16) / 255,
      }
    : { r: 0, g: 0, b: 0 };
}

interface EmbeddedFontMetrics {
  ascent: number;
  descent: number;
  unitsPerEm: number;
}

function fontMetrics(font: PDFFont): EmbeddedFontMetrics {
  const carrier = font as unknown as {
    embedder?: {
      font?: { ascent?: number; descent?: number; unitsPerEm?: number };
    };
  };
  const f = carrier.embedder?.font;
  const unitsPerEm =
    typeof f?.unitsPerEm === 'number' && f.unitsPerEm > 0 ? f.unitsPerEm : 1000;
  const ascent =
    typeof f?.ascent === 'number' && f.ascent > 0 ? f.ascent : unitsPerEm * 0.8;
  const descent =
    typeof f?.descent === 'number' && f.descent <= 0
      ? f.descent
      : -unitsPerEm * 0.2;
  return { ascent, descent, unitsPerEm };
}

function breakLongToken(
  font: PDFFont,
  token: string,
  size: number,
  maxWidth: number,
  out: string[]
): string {
  let cur = '';
  for (const ch of token) {
    const candidate = cur + ch;
    if (cur !== '' && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      out.push(cur);
      cur = ch;
    } else {
      cur = candidate;
    }
  }
  return cur;
}

function wrapLine(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number
): string[] {
  if (!text) return [''];
  const tokens = text.match(/\s+|\S+/g) ?? [];
  const out: string[] = [];
  let cur = '';
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      cur += token;
      continue;
    }
    const candidate = cur + token;
    if (font.widthOfTextAtSize(candidate.trimEnd(), size) <= maxWidth) {
      cur = candidate;
      continue;
    }
    if (cur.trim() !== '') {
      out.push(cur.trimEnd());
    }
    if (font.widthOfTextAtSize(token, size) <= maxWidth) {
      cur = token;
    } else {
      cur = breakLongToken(font, token, size, maxWidth, out);
    }
  }
  out.push(cur.trimEnd());
  return out;
}

function findFreeTextDict(
  doc: PDFDocument,
  pageIndex: number,
  id: string
): PDFDict | null {
  if (pageIndex < 0 || pageIndex >= doc.getPageCount()) return null;
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return null;
  for (let i = 0; i < annots.size(); i++) {
    const obj = annots.lookup(i);
    if (!(obj instanceof PDFDict)) continue;
    const subtype = obj.lookup(PDFName.of('Subtype'));
    if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'FreeText') {
      continue;
    }
    const nm = obj.lookup(PDFName.of('NM'));
    const nmStr =
      nm instanceof PDFString
        ? nm.asString()
        : nm instanceof PDFHexString
          ? nm.decodeText()
          : '';
    if (nmStr === id) return obj;
  }
  return null;
}

function bakeAppearance(
  doc: PDFDocument,
  dict: PDFDict,
  annot: FreeTextSystemFontAnnotation,
  font: PDFFont
): void {
  const w = annot.rect.size.width;
  const h = annot.rect.size.height;
  if (!(w > 0) || !(h > 0)) return;
  const size = annot.fontSize > 0 ? annot.fontSize : 12;
  const lineHeight = size * 1.18;
  const metrics = fontMetrics(font);
  const scalePerUnit = size / metrics.unitsPerEm;
  const maxWidth = Math.max(w, size);

  const lines: string[] = [];
  for (const paragraph of (annot.contents ?? '').split(/\r\n?|\n/)) {
    lines.push(...wrapLine(font, paragraph, size, maxWidth));
  }

  const blockHeight = lines.length * lineHeight;
  const vOffset =
    annot.verticalAlign === 1
      ? Math.max(0, (h - blockHeight) / 2)
      : annot.verticalAlign === 2
        ? Math.max(0, h - blockHeight)
        : 0;
  const contentHeight = (metrics.ascent - metrics.descent) * scalePerUnit;
  const halfLeading = (lineHeight - contentHeight) / 2;
  const firstBaselineFromTop =
    vOffset + halfLeading + metrics.ascent * scalePerUnit;

  const color = hexToRgb(annot.fontColor || '#000000');
  const bg =
    annot.backgroundColor &&
    /^#?[a-f\d]{6}$/i.test(annot.backgroundColor.trim())
      ? hexToRgb(annot.backgroundColor.trim())
      : null;

  const ops: PDFOperator[] = [pushGraphicsState()];
  if (bg) {
    ops.push(
      setFillingRgbColor(bg.r, bg.g, bg.b),
      rectangle(0, 0, w, h),
      fill()
    );
  }
  ops.push(
    beginText(),
    setFontAndSize('F0', size),
    setFillingRgbColor(color.r, color.g, color.b)
  );
  let prevX = 0;
  let prevY = 0;
  lines.forEach((line, i) => {
    if (!line) return;
    const lineWidth = font.widthOfTextAtSize(line, size);
    const x =
      annot.textAlign === 1
        ? Math.max(0, (w - lineWidth) / 2)
        : annot.textAlign === 2
          ? Math.max(0, w - lineWidth)
          : 0;
    const y = h - (firstBaselineFromTop + i * lineHeight);
    ops.push(moveText(x - prevX, y - prevY), showText(font.encodeText(line)));
    prevX = x;
    prevY = y;
  });
  ops.push(endText(), popGraphicsState());

  const xobj = doc.context.formXObject(ops, {
    BBox: [0, 0, w, h],
    Resources: { Font: { F0: font.ref } },
  });
  const ref = doc.context.register(xobj);
  dict.set(PDFName.of('AP'), doc.context.obj({ N: ref }));
}

export async function embedFreeTextSystemFonts(
  bytes: Uint8Array,
  annotations: FreeTextSystemFontAnnotation[]
): Promise<Uint8Array> {
  const candidates = annotations.filter(
    (a) => a.fontPostScriptName.trim() !== ''
  );
  if (candidates.length === 0) return bytes;

  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  doc.registerFontkit(fontkit);

  const fontCache = new Map<string, PDFFont | null>();
  const resolveFont = async (
    postscriptName: string
  ): Promise<PDFFont | null> => {
    const cached = fontCache.get(postscriptName);
    if (cached !== undefined) return cached;
    const fontBytes = await fetchFontBytes(postscriptName);
    if (!fontBytes) {
      fontCache.set(postscriptName, null);
      return null;
    }
    try {
      const font = await doc.embedFont(fontBytes, {
        subset: true,
        customName: `${subsetPrefix(postscriptName)}+${postscriptName}`,
      });
      fontCache.set(postscriptName, font);
      return font;
    } catch {
      fontCache.set(postscriptName, null);
      return null;
    }
  };

  let touched = false;
  for (const annot of candidates) {
    try {
      const font = await resolveFont(annot.fontPostScriptName);
      if (!font) continue;
      const dict = findFreeTextDict(doc, annot.pageIndex, annot.id);
      if (!dict) continue;
      bakeAppearance(doc, dict, annot, font);
      touched = true;
    } catch {
      continue;
    }
  }

  if (!touched) return bytes;
  return doc.save();
}
