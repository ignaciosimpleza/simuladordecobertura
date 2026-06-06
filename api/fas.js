// api/fas.js — Proxy para FAS Teórico oficial (DINEM / MAGYP)
// ────────────────────────────────────────────────────────────────────────────
// COPIADO DE granos@65e2e81 (api/fas.js) — sin cambios funcionales.
// Re-sincronizar si cambia en granos.
// ────────────────────────────────────────────────────────────────────────────
// Fuente: https://dinem.magyp.gob.ar/dinem_fas.cfas_all.aspx
// La página es GeneXus: los datos están en un <input hidden> con JSON posicional.
//   W0031GridContainerDataV  -> "Der.Export.Completo"  (default)
//   W0039GridContainerDataV  -> "Der.Export.Reducido"
// Cada fila (de más reciente a más vieja):
//   [Fecha, TrigoPan, Maíz, CebadaCerv, CebadaForr, Sorgo, Soja, Girasol, Ac.Soja, Ac.Girasol]
// Importes en pesos por tonelada (enteros). Ej: "487182" = $487.182/tn.
//
// Uso: /api/fas               -> Completo (default)
//      /api/fas?tab=reducido  -> Derecho de Exportación Reducido
//      /api/fas?debug=1       -> filas crudas + columnas

const SOURCE_URL = 'https://dinem.magyp.gob.ar/dinem_fas.cfas_all.aspx';

const COL_KEYS = [
  'fecha', 'trigo', 'maiz', 'cebada_c', 'cebada_f',
  'sorgo', 'soja', 'girasol', 'aceite', 'aceite_girasol',
];

function extractGridData(html, gridId) {
  const re = new RegExp(gridId + 'GridContainerDataV"\\s+value=\'([^\']*)\'');
  const m = html.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const reducido = req.query?.tab === 'reducido' || req.query?.tab === 'reduced';
  const gridId   = reducido ? 'W0039' : 'W0031';
  const debug    = req.query?.debug;

  try {
    const response = await fetch(SOURCE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9',
        'Referer': 'https://dinem.magyp.gob.ar/',
      },
    });
    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: `DINEM HTTP ${response.status}`, fas: {} });
    }
    const html = await response.text();
    const rows = extractGridData(html, gridId);
    if (!Array.isArray(rows) || rows.length === 0) {
      const out = { ok: false, error: 'No se pudo leer el grid de DINEM', fas: {} };
      if (debug) out.html_preview = html.substring(0, 4000);
      return res.status(200).json(out);
    }
    const latest = rows[0];
    const fecha  = latest[0] || null;
    const fas = {};
    for (let i = 1; i < COL_KEYS.length && i < latest.length; i++) {
      const v = parseInt(String(latest[i]).replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(v) && v > 0) fas[COL_KEYS[i]] = v;
    }
    const out = {
      ok:     Object.keys(fas).length > 0,
      tab:    reducido ? 'reducido' : 'completo',
      fecha, fas, source: SOURCE_URL,
    };
    if (debug) { out.rows = rows.slice(0, 5); out.columns = COL_KEYS; }
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, fas: {} });
  }
}
