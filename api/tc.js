// api/tc.js — Proxy para TC Dólar Futuro ROFEX (Ámbito)
// ────────────────────────────────────────────────────────────────────────────
// COPIADO DE granos@65e2e81 (api/tc.js) — sin cambios funcionales.
// Re-sincronizar si cambia en granos.
// ────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const response = await fetch('https://mercados.ambito.com/dolarfuturo/datos', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Referer': 'https://mercados.ambito.com/',
        'Origin': 'https://mercados.ambito.com',
      }
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: `Ambito HTTP ${response.status}` });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
