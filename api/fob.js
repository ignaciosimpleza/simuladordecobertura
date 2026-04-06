// api/fob.js — MAGYP WebService FOB (mismo formato NCM que DINEM)
// La API devuelve: {"posts":[{"posicion":"10011900110H","precio":258,...}]}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const BASE = 'https://www.magyp.gob.ar/sitio/areas/ss_mercados_agropecuarios/ws/ssma/precios_fob.php?Fecha=';

  // Mapeo NCM → campo del análisis (confirmado con datos reales 01/04/2026)
  const NCM = {
    '12019000190C': 'soja',    // Habas de soja, granel
    '15071000100Q': 'aceite',  // Aceite de soja crudo
    '23040010100B': 'harina',  // Pellets/harina de soja
    '10059010120A': 'maiz',    // Maíz, granel
    '10011900110H': 'trigo',   // Trigo pan, granel
  };

  function fmtDDMMYYYY(d) {
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }

  function buildSeries(posts) {
    const series = {};
    posts.forEach(item => {
      const prod = NCM[item.posicion];
      if (!prod) return;
      if (!series[prod]) series[prod] = [];
      series[prod].push({
        p: item.precio,
        md: item.mesDesde,  ad: item.añoDesde,
        mh: item.mesHasta,  ah: item.añoHasta
      });
    });
    return series;
  }

  function getSpot(series) {
    const now = new Date();
    const t   = now.getFullYear() * 12 + (now.getMonth() + 1);
    const spot = {};
    Object.entries(series).forEach(([prod, s]) => {
      const m = s.find(r => t >= r.ad*12+r.md && t <= r.ah*12+r.mh);
      spot[prod] = m?.p ?? s[0]?.p ?? null;
    });
    return spot;
  }

  const today = new Date();

  // Probar los últimos 30 días hábiles
  for (let i = 1; i <= 60; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    const fechaStr = fmtDDMMYYYY(d);
    const fechaISO = d.toISOString().split('T')[0];

    try {
      const r = await fetch(BASE + encodeURIComponent(fechaStr), {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0' }
      });
      if (!r.ok) continue;

      const text = await r.text();
      if (!text || text.trim().startsWith('<')) continue;

      const json  = JSON.parse(text);
      // ⚠️ Respuesta es {"posts":[...]} — NO un array directo
      const posts = json.posts || (Array.isArray(json) ? json : []);
      if (!posts.length) continue;

      const series = buildSeries(posts);
      if (!series.soja) continue; // sin soja → día sin datos útiles

      const spot = getSpot(series);
      return res.status(200).json({
        fecha: fechaISO,
        circular: posts[0]?.circular ?? null,
        spot,
        series,
        source: 'MAGYP'
      });

    } catch(e) {
      // seguir con el día anterior
    }
  }

  // Fallback: datos.gob.ar
  try {
    const ids = '358.1_HABAS_SOJAADO__52,358.1_ACEITE_SOJNEL__18,358.1_TORTAS_EXPXTR__56,358.1_MAIZ_DEMASADO__52,358.1_TRIGO_GRANADO__41';
    const r   = await fetch(`https://apis.datos.gob.ar/series/api/series/?ids=${ids}&limit=1&sort=desc`);
    const j   = await r.json();
    const row = j.data?.[0];
    if (row) {
      return res.status(200).json({
        fecha: row[0], source: 'fallback_datosgob',
        spot: { soja:row[1], aceite:row[2], harina:row[3], maiz:row[4], trigo:row[5] },
        series: {}
      });
    }
  } catch(e) {}

  return res.status(502).json({ error: 'Sin datos disponibles' });
}
