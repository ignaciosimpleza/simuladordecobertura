// api/sheets.js — Lector de la planilla pública "A3 Info" (Matba Rofex / Primary)
// ────────────────────────────────────────────────────────────────────────────
// COPIADO DE granos@65e2e81 (api/sheets.js) y EXTENDIDO para el simulador:
//   · Detección robusta de la fila de encabezado (granos asumía 3 filas fijas y
//     descartaba los 2 primeros contratos — los meses más cercanos).
//   · Parseo de OPCIONES: extrae strike + put/call del código de contrato y arma
//     cadenas (chains) por cultivo y mes con primas reales (valor teórico).
// Si granos cambia su sheets.js, re-sincronizar la base de este archivo.
// ────────────────────────────────────────────────────────────────────────────
//
// Uso:
//   /api/sheets?tab=financiero      → Dólar futuro (DLR + otros financieros)
//   /api/sheets?tab=agropecuarios   → Futuros + Opciones MATba (soja, maíz, trigo)
//   /api/sheets?tab=home            → Spot internacional (Chicago, dólar plaza)
//   /api/sheets?tab=<key>&raw=1     → Devuelve también las filas crudas (debug)

const SHEET_ID  = '1j-ZrWBO-fCkGUPqWtWRsGgGswMRCm2mnMhsPmX6osLI';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;

const TABS = {
  home:          { gid: 1523589361, name: 'Home' },
  instrumentos:  { gid: 219973338,  name: 'Instrumentos' },
  activos:       { gid: 999017548,  name: 'Activos Aceptados' },
  fci:           { gid: 1554958349, name: 'Mercado FCI' },
  financiero:    { gid: 2027743157, name: 'Resumen - Financiero' },
  agropecuarios: { gid: 527444289,  name: 'Resumen - Agropecuarios' },
};

// ─── CSV parser (maneja comillas, comas escapadas, saltos de línea) ───
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function num(v) {
  if (v === null || v === undefined || v === '' || v === 'N/A') return null;
  let s = String(v).trim();
  s = s.replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');     // AR: 1.234,56
  } else if (lastDot > lastComma) {
    s = s.replace(/,/g, '');                          // US: 1,234.56
  } else if (lastComma >= 0) {
    s = s.replace(',', '.');                          // solo coma → decimal
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Mes (3 letras, ES + algunos EN) → número
const MES3 = { ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12,
               jan:1,apr:4,aug:8,dec:12 };
const MES_LABEL = { 1:'Ene',2:'Feb',3:'Mar',4:'Abr',5:'May',6:'Jun',7:'Jul',8:'Ago',9:'Sep',10:'Oct',11:'Nov',12:'Dic' };

// Parsea el código de contrato MATba. Soporta:
//   Futuro:    "SOJ.ROS/MAY27"           → { mes, año }
//   Opción:    "SOJ.ROS/JUL26 320 P"      → { mes, año, strike, putCall }
//   Disponible:"SOJ.ROS.P/DIS26"          → null (sin mes)
function parseContrato(contrato) {
  if (!contrato) return null;
  const s = String(contrato).toUpperCase().trim();
  // Opción: .../MESyy STRIKE P|C
  let m = s.match(/\/([A-Z]{3})(\d{2})\s+(\d+(?:[.,]\d+)?)\s+([PC])$/);
  if (m) {
    const mes = MES3[m[1].toLowerCase()];
    if (mes) return { mes, año: 2000 + +m[2], strike: num(m[3]), putCall: m[4] === 'P' ? 'PUT' : 'CALL' };
  }
  // Futuro: .../MESyy
  m = s.match(/\/([A-Z]{3})(\d{2})$/);
  if (m) {
    const mes = MES3[m[1].toLowerCase()];
    if (mes) return { mes, año: 2000 + +m[2] };
  }
  // Formato alternativo PREFIJO+MMYYYY (financiero: DLR052026)
  m = s.match(/(\d{2})(\d{4})$/);
  if (m) return { mes: +m[1], año: +m[2] };
  return null;
}

// Encuentra el índice de la fila de encabezado (no asumir posición fija).
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i] || [];
    const joined = r.map(c => String(c || '').toLowerCase()).join('|');
    if (joined.includes('put/call') || (joined.includes('contrato') && joined.includes('vencimiento'))) {
      return i;
    }
  }
  return 1; // fallback conservador: 1 fila de header
}

// ─── Parser genérico de filas Futuro/Opción (financiero + agropecuarios) ───
function parseInstrumentos(rows) {
  const headerIdx = findHeaderRow(rows);
  const data = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const contrato = String(r[0]).trim();
    if (!contrato || /contrato/i.test(contrato)) continue;
    const parsed = parseContrato(contrato);
    data.push({
      contrato,
      vencimiento:    r[1] || null,
      producto:       r[2] || null,
      moneda:         r[4] || null,
      tipo:           r[5] || null,               // "Futuro" | "Opción"
      putCall:        (r[6] && r[6] !== 'N/A') ? r[6] : (parsed?.putCall || null),
      precio:         num(r[7]),                   // Ajuste (futuro) | Valor teórico (opción = prima)
      volumen:        num(r[8]),
      interesAbierto: num(r[9]),
      mes:            parsed?.mes ?? null,
      año:            parsed?.año ?? null,
      strike:         parsed?.strike ?? null,
    });
  }
  return data;
}

function parseFinanciero(rows) {
  const data = parseInstrumentos(rows);
  return {
    fuente:      'A3 Info · Resumen Financiero (Matba Rofex)',
    fuenteUrl:   `${SHEET_URL}/edit#gid=${TABS.financiero.gid}`,
    actualizado: rows[3]?.[12] || null,
    contratos:   data,
    dolares:     data.filter(d => d.producto === 'DLR'),
  };
}

// Mapa cultivo → producto MATba (futuro/opción local en USD)
const CROP_PRODUCT = {
  soja:  'SOJ Dolar MATba',
  maiz:  'MAI Dolar MATba',
  trigo: 'TRI Dolar MATba',
};

// Arma, por cultivo, una lista de meses con su futuro y la cadena de opciones (puts/calls)
function buildChains(data) {
  const chains = {};
  for (const [crop, prod] of Object.entries(CROP_PRODUCT)) {
    const recs = data.filter(d => d.producto === prod);
    const byMonth = {};
    const ensure = (key, mes, año) => {
      if (!byMonth[key]) byMonth[key] = {
        key, mes, año,
        label: `${MES_LABEL[mes] || '??'} '${String(año).slice(-2)}`,
        vto: null, future: null, puts: [], calls: [],
      };
      return byMonth[key];
    };

    // Futuros (definen los meses disponibles + el precio base)
    recs.filter(d => d.tipo === 'Futuro' && d.mes && d.año && d.precio > 0).forEach(d => {
      const key = `${MES_LABEL[d.mes]}${String(d.año).slice(-2)}`.toUpperCase();
      const m = ensure(key, d.mes, d.año);
      m.future = d.precio;
      m.vto = d.vencimiento;
      m.contrato = d.contrato;   // nombre de la fila en A3 (ej. "SOJ.ROS/MAY26")
      m.producto = d.producto;   // ej. "SOJ Dolar MATba"
    });

    // Opciones → puts/calls del mes correspondiente (prima = d.precio)
    recs.filter(d => d.tipo === 'Opción' && d.mes && d.año && d.strike > 0).forEach(d => {
      const key = `${MES_LABEL[d.mes]}${String(d.año).slice(-2)}`.toUpperCase();
      const m = ensure(key, d.mes, d.año);
      const entry = { strike: d.strike, prima: d.precio ?? 0, contrato: d.contrato };
      if (d.putCall === 'PUT') m.puts.push(entry);
      else if (d.putCall === 'CALL') m.calls.push(entry);
    });

    const months = Object.values(byMonth)
      .filter(m => m.future > 0)                          // solo meses con futuro cotizado
      .sort((a, b) => (a.año - b.año) || (a.mes - b.mes));
    months.forEach(m => {
      m.puts.sort((a, b) => a.strike - b.strike);
      m.calls.sort((a, b) => a.strike - b.strike);
    });
    chains[crop] = months;
  }
  return chains;
}

function parseAgropecuarios(rows) {
  const data = parseInstrumentos(rows);
  return {
    fuente:      'A3 Info · Resumen Agropecuarios (Matba Rofex)',
    fuenteUrl:   `${SHEET_URL}/edit#gid=${TABS.agropecuarios.gid}`,
    actualizado: data[0] ? rows[findHeaderRow(rows) + 1]?.[12] : null,
    contratos:   data,
    // Cadenas listas para el simulador: por cultivo, meses con futuro + opciones
    chains:      buildChains(data),
  };
}

// ─── Home (spot internacional + dólar plaza) ───
function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[  -‍﻿]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHome(rows) {
  const SPOT_PATTERNS = [
    { keywords: ['soja', 'chicago'],  key: 'soja',        display: 'Soja Chicago',      unit: 'USD/Tn',  grupo: 'cme' },
    { keywords: ['maiz', 'chicago'],  key: 'maiz',        display: 'Maíz Chicago',      unit: 'USD/Tn',  grupo: 'cme' },
    { keywords: ['trigo', 'chicago'], key: 'trigo',       display: 'Trigo Chicago',     unit: 'USD/Tn',  grupo: 'cme' },
    { keywords: ['petroleo', 'wti'],  key: 'wti',         display: 'Petróleo WTI',      unit: 'USD/bbl', grupo: 'cme' },
    { keywords: ['oro', 'cme'],       key: 'oro',         display: 'Oro CME',           unit: 'USD/oz',  grupo: 'cme' },
    { keywords: ['ca3500'],           key: 'dolar_mayor', display: 'Mayorista (A3500)', unit: 'ARS',     grupo: 'dolar' },
    { keywords: ['dolar', 'mep'],     key: 'dolar_mep',   display: 'MEP',               unit: 'ARS',     grupo: 'dolar' },
    { keywords: ['dolar', 'cable'],   key: 'dolar_ccl',   display: 'CCL (Cable)',       unit: 'ARS',     grupo: 'dolar' },
    { keywords: ['dolar', 'bna'],     key: 'dolar_bna',   display: 'BNA',               unit: 'ARS',     grupo: 'dolar' },
    { keywords: ['dolar', 'blue'],    key: 'dolar_blue',  display: 'Blue',              unit: 'ARS',     grupo: 'dolar' },
    { keywords: ['dolar', 'rofex'],   key: 'dolar_rofex', display: 'Garantía ROFEX',    unit: 'ARS',     grupo: 'dolar' },
  ];
  const spot = [];
  const seen = new Set();
  let ultimaAct = null;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (!Array.isArray(row)) continue;
    for (let i = 0; i < row.length; i++) {
      const cell = String(row[i] || '').trim();
      if (!cell) continue;
      const cellN = norm(cell);
      const pat = SPOT_PATTERNS.find(p => p.keywords.every(k => cellN.includes(k)));
      if (!pat || seen.has(pat.key)) continue;
      let valor = null, fechaCotizacion = null;
      for (let j = i + 1; j < row.length; j++) {
        const v = row[j];
        if (v === '' || v === null || v === undefined) continue;
        const n = num(v);
        if (n !== null && valor === null) { valor = n; continue; }
        if (n === null && valor !== null && !fechaCotizacion) { fechaCotizacion = String(v).trim(); break; }
      }
      if (valor !== null) {
        seen.add(pat.key);
        spot.push({ nombre: pat.display, key: pat.key, grupo: pat.grupo, unit: pat.unit, valor, fechaCotizacion });
      }
      break;
    }
    if (!ultimaAct) {
      const found = row?.find(c => typeof c === 'string' && /^\d{1,2}-\d{1,2}-\d{4}\s*\|/.test(c));
      if (found) ultimaAct = found;
    }
  }
  return { fuente: 'A3 Info · Home / SPOT (Matba Rofex)', fuenteUrl: `${SHEET_URL}/edit#gid=${TABS.home.gid}`, actualizado: ultimaAct, spot };
}

function parseGeneric(rows, tabKey) {
  return { fuente: `A3 Info · ${TABS[tabKey].name}`, fuenteUrl: `${SHEET_URL}/edit#gid=${TABS[tabKey].gid}`, rows };
}

// ─── Handler ───
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const tabKey = String(req.query.tab || '').toLowerCase();
  const debug  = req.query.raw === '1' || req.query.debug === '1';

  if (!TABS[tabKey]) {
    return res.status(400).json({ error: 'tab inválido', validos: Object.keys(TABS) });
  }

  const csvUrl = `${SHEET_URL}/gviz/tq?tqx=out:csv&gid=${TABS[tabKey].gid}`;
  try {
    const r = await fetch(csvUrl, { headers: { 'Accept': 'text/csv,text/plain' } });
    if (!r.ok) return res.status(502).json({ error: `Google Sheets HTTP ${r.status}`, url: csvUrl });
    const text = await r.text();
    if (text.startsWith('<') || /<!DOCTYPE/i.test(text)) {
      return res.status(502).json({ error: 'Respuesta no es CSV (¿la planilla dejó de ser pública?)', preview: text.substring(0, 300) });
    }
    const rows = parseCSV(text);
    let data;
    switch (tabKey) {
      case 'financiero':    data = parseFinanciero(rows);    break;
      case 'agropecuarios': data = parseAgropecuarios(rows); break;
      case 'home':          data = parseHome(rows);          break;
      default:              data = parseGeneric(rows, tabKey);
    }
    if (debug) data.raw = rows;
    data.licencia = 'Planilla pública A3 Info — propiedad de Matba Rofex / Primary.';
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message, url: csvUrl });
  }
}

// Exports nombrados para tests unitarios (no afectan el handler default de Vercel)
export { parseCSV, parseContrato, parseAgropecuarios, parseFinanciero, buildChains, findHeaderRow };
