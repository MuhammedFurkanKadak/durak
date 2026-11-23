// Durak – kısa harita linklerini (maps.app.goo.gl vb.) açıp gerçek adresi döndürür.
// Kullanım: /api/resolve?u=https://maps.app.goo.gl/xxxx
const ALLOWED = ["maps.app.goo.gl", "goo.gl", "g.co", "yandex.com.tr", "yandex.ru", "yandex.com", "maps.apple.com"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  let u;
  try { u = new URL(String((req.query || {}).u || "")); } catch { return res.status(400).json({ ok: false, error: "Geçersiz link" }); }
  if (u.protocol !== "https:" || !ALLOWED.some(h => u.hostname === h || u.hostname.endsWith("." + h))) {
    return res.status(400).json({ ok: false, error: "Bu link türü desteklenmiyor" });
  }
  try {
    // Yönlendirmeleri en fazla 5 kez takip et, son adresi döndür
    let cur = u.toString();
    for (let i = 0; i < 5; i++) {
      const r = await fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0" } });
      const loc = r.headers.get("location");
      if (!loc) break;
      cur = new URL(loc, cur).toString();
    }
    res.setHeader("Cache-Control", "s-maxage=86400");
    return res.status(200).json({ ok: true, url: cur });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Link açılamadı" });
  }
};
