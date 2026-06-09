// api/costos.js — Costos de producción por cultivo y zona (AGBI · AZ Group)
// ────────────────────────────────────────────────────────────────────────────
// Fuente: archivos Excel públicos que consume la app de AGBI.
//   https://www.agbi.com.ar/uploads/AZimport.xlsx   → campaña vigente (default)
// La hoja "DATA" trae una fila por (region, cultivo) con, entre otras columnas:
//   precio_equilibrio (USD/t = costo de producción por tonelada · break-even),
//   costo_cultivo (USD/ha), insumos, labores, cosecha, gerenciamiento,
//   arrendamiento, gastos_comerciales, rinde_presupuestado, margen_bruto/neto.
// La hoja "CONFIGURACION" trae nombre_campana (ej. "Camp. 2026/27").
//
// Parser xlsx propio (ZIP + inflate de Node, sin dependencias).
// Uso:  /api/costos            → campaña vigente
//       /api/costos?raw=1      → agrega la grilla cruda de DATA (debug)
// ────────────────────────────────────────────────────────────────────────────

import zlib from 'node:zlib';

const SOURCE = 'https://www.agbi.com.ar/uploads/AZimport.xlsx';

// ── Mini-lector ZIP (central directory) ──
function readZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('xlsx inválido (EOCD no encontrado)');
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method   = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen  = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen   = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name     = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries[name]  = { method, compSize, localOff };
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return { buf, entries };
}
function extract(zip, name) {
  const e = zip.entries[name];
  if (!e) return null;
  const p = e.localOff;
  const nameLen  = zip.buf.readUInt16LE(p + 26);
  const extraLen = zip.buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = zip.buf.subarray(start, start + e.compSize);
  return e.method === 0 ? data : zlib.inflateRawSync(data);
}

// ── XML helpers (el XML de Excel es regular; regex alcanza) ──
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
}
function parseShared(xml) {
  if (!xml) return [];
  const out = []; const siRe = /<si>([\s\S]*?)<\/si>/g; let m;
  while ((m = siRe.exec(xml)) !== null) {
    let txt = ''; let t; const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    while ((t = tRe.exec(m[1])) !== null) txt += t[1];
    out.push(decode(txt));
  }
  return out;
}
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref); let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}
function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g; let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const ri = +rm[1] - 1;
    const cells = [];
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g; let cm;
    while ((cm = cRe.exec(rm[2])) !== null) {
      const attrs = cm[1] || cm[3] || '';
      const inner = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs); if (!ref) continue;
      const ci = colIndex(ref[1]);
      const t = /\bt="([^"]+)"/.exec(attrs);
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const is = /<is>([\s\S]*?)<\/is>/.exec(inner);
      let val = null;
      if (t && t[1] === 's' && v) val = shared[+v[1]];
      else if (t && t[1] === 'inlineStr' && is) { const tt = /<t[^>]*>([\s\S]*?)<\/t>/.exec(is[1]); val = tt ? decode(tt[1]) : ''; }
      else if (v) val = decode(v[1]);
      cells[ci] = val;
    }
    rows[ri] = cells;
  }
  return rows;
}
// Devuelve { nombreHoja: grid } para todas las hojas
function parseWorkbook(buf) {
  const zip = readZip(buf);
  const shared = parseShared(extract(zip, 'xl/sharedStrings.xml')?.toString('utf8'));
  const wb = extract(zip, 'xl/workbook.xml').toString('utf8');
  const rels = extract(zip, 'xl/_rels/workbook.xml.rels').toString('utf8');
  const relMap = {};
  for (const r of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[r[1]] = r[2];
  const sheets = {};
  for (const s of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    let target = relMap[s[2]]; if (!target) continue;
    target = target.replace(/^\//, '').replace(/^xl\//, '');
    const xml = extract(zip, 'xl/' + target);
    if (xml) sheets[s[1]] = parseSheet(xml.toString('utf8'), shared);
  }
  return sheets;
}

// ── Normalización de dominio ──
const norm = s => String(s || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const CROP_MAP = { 'soja': 'soja', 'maiz': 'maiz', 'girasol': 'girasol' }; // trigo/rotaciones no aplican al simulador
function n(v) {
  if (v == null || v === '' || v === '-') return null;
  const x = Number(String(v).replace(',', '.'));
  return Number.isFinite(x) ? x : null;
}

function buildCostos(sheets) {
  const data = sheets['DATA'] || [];
  const hdr = data[0] || [];
  const col = name => hdr.indexOf(name);
  const cReg = col('region'), cCult = col('cultivo');
  const C = {
    precioEquilibrio: col('precio_equilibrio'),
    costoCultivo:     col('costo_cultivo'),
    insumos:          col('insumos'),
    labores:          col('labores'),
    cosecha:          col('cosecha'),
    gerenciamiento:   col('gerenciamiento'),
    arrendamiento:    col('arrendamiento'),
    gastosCom:        col('gastos_comerciales'),
    rinde:            col('rinde_presupuestado'),
    precioRef:        col('precio_referencia'),
    margenBruto:      col('margen_bruto'),
    margenNeto:       col('margen_neto'),
  };

  const costos = {};
  const regiones = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i]; if (!r || !r[cReg] || !r[cCult]) continue;
    const region = String(r[cReg]).trim();
    const crop = CROP_MAP[norm(r[cCult])];
    if (!crop) continue;                       // solo soja/maíz/girasol
    if (!regiones.includes(region)) regiones.push(region);
    (costos[crop] || (costos[crop] = {}))[region] = {
      costoProd:        n(r[C.precioEquilibrio]) != null ? Math.round(n(r[C.precioEquilibrio])) : null, // USD/t
      costoCultivo:     n(r[C.costoCultivo]),    // USD/ha
      insumos:          n(r[C.insumos]),
      labores:          n(r[C.labores]),
      cosecha:          n(r[C.cosecha]),
      gerenciamiento:   n(r[C.gerenciamiento]),
      arrendamiento:    n(r[C.arrendamiento]),
      gastosComerciales:n(r[C.gastosCom]),
      rinde:            n(r[C.rinde]),           // qq/ha
      precioRef:        n(r[C.precioRef]),       // USD/t
      margenBruto:      n(r[C.margenBruto]),     // USD/ha
      margenNeto:       n(r[C.margenNeto]),      // USD/ha
    };
  }

  // Campaña (hoja CONFIGURACION: tabla header→valor; nombre_campana en fila 0, valor en fila 1)
  let campana = null;
  const cfg = sheets['CONFIGURACION'] || [];
  if (cfg[0] && cfg[1]) {
    const j = cfg[0].findIndex(c => norm(c) === 'nombre_campana');
    if (j >= 0 && cfg[1][j]) campana = String(cfg[1][j]).trim();
  }
  return { regiones, costos, campana };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400'); // 6h
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const r = await fetch(`${SOURCE}?t=${Math.random()}`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.agbi.com.ar/' },
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: `AGBI HTTP ${r.status}`, costos: {} });
    const buf = Buffer.from(await r.arrayBuffer());
    const sheets = parseWorkbook(buf);
    const out = buildCostos(sheets);
    const body = {
      ok: Object.keys(out.costos).length > 0,
      fuente: 'AGBI · AZ Group',
      fuenteUrl: SOURCE,
      campana: out.campana,
      regiones: out.regiones,
      costos: out.costos,
    };
    if (req.query?.raw === '1') body.rawData = sheets['DATA']?.slice(0, 6);
    return res.status(200).json(body);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, costos: {} });
  }
}

// Exports nombrados para tests (no afectan el handler default de Vercel)
export { parseWorkbook, buildCostos };
