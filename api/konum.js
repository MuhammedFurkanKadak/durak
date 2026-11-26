// Durak – uygulamanın okuduğu araç konum / trafik hızı verisi (Vercel Function)
//   /api/konum?hat=26B,34     o hatların araçları (Mac'teki toplayıcının en son yolladığı); istek sıraya da yazılır
//   /api/konum?hiz=1          ~330 m'lik hücrelerde otobüslerin son dakikalardaki ortalama hızı (km/sa)
const { pipe, ok } = require("./_redis");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = req.query || {};
  if (!ok) { res.statusCode = 503; return res.json({ hata: "Redis bağlı değil" }); }
  try {
    if (q.hiz) {
      const [s] = await pipe([["GET", "hiz"]]);
      res.setHeader("Cache-Control", "public, s-maxage=50, stale-while-revalidate=30");
      return res.end(s || "null");
    }
    const lines = [...new Set(String(q.hat || "").split(","))].map(h => h.trim().slice(0, 10)).filter(Boolean).slice(0, 8);
    if (!lines.length) { res.statusCode = 400; return res.json({ hata: "hat=26B gibi" }); }
    const now = Date.now();
    const r = await pipe([...lines.map(h => ["GET", "hat:" + h]), ["GET", "hatf"], ...lines.map(h => ["ZADD", "istek", now, h])]);
    const hf = r[lines.length] ? JSON.parse(r[lines.length]) : null;
    // Hat sorgusu ile filodan izlenen konumlardan hangisi tazeyse onu ver
    const d = {}; lines.forEach((h, i) => {
      const a = r[i] ? JSON.parse(r[i]) : null, b = hf && hf.d[h] && hf.d[h].length ? { t: hf.t, araclar: hf.d[h], filo: true } : null;
      d[h] = a && b ? (b.t > a.t ? b : a) : (a || b);
    });
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=10");
    res.json({ t: now, d });
  } catch (e) { res.statusCode = 500; res.json({ hata: String(e.message || e) }); }
};
