// Durak – Mac'teki toplayıcıdan araç konumlarını alır (Vercel Function)
// İBB konum servisi yalnızca Türkiye'den erişilebildiği için konumları Mac'teki betik çekip buraya yollar.
//   POST /api/konum-al?tur=filo          gövde: İBB'nin GetFiloAracKonum_json SOAP yanıtı (olduğu gibi)
//   POST /api/konum-al?tur=hat&h=26B     gövde: GetHatOtoKonum_json SOAP yanıtı
//   GET  /api/konum-al?istek=1           sırada çekilmesi gereken hat (uygulamada son 10 dk'da bakılan, en eski güncellenen)
// Hepsi "x-key" başlığında KONUM_KEY ister.
const { pipe } = require("./_redis");

const CELL_LAT = 0.003, CELL_LON = 0.004;   // ~330 m'lik hücreler
const cell = (la, lo) => Math.floor(la / CELL_LAT) + ":" + Math.floor(lo / CELL_LON);

function readBody(req) {
  return new Promise((ok, no) => { const ch = []; req.on("data", c => ch.push(c)); req.on("end", () => ok(Buffer.concat(ch).toString("utf8"))); req.on("error", no); });
}
function soapResult(xml, method) {
  const m = xml.match(new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`));
  if (!m) { const f = xml.match(/<faultstring>([\s\S]*?)<\/faultstring>/); throw new Error(f ? f[1] : "SOAP yanıtı yok"); }
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}
// İstanbul saatine göre "HH:MM:SS" kaç dakika önce
function ageMin(hms) {
  const p = String(hms || "").split(":").map(Number); if (p.length < 2) return 99;
  const now = new Date(Date.now() + 3 * 3600e3); const n = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  let d = n - (p[0] * 60 + p[1] + (p[2] || 0) / 60); if (d < -720) d += 1440; return d;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.KONUM_KEY || req.headers["x-key"] !== process.env.KONUM_KEY) { res.statusCode = 401; return res.json({ hata: "anahtar yanlış" }); }
  const q = req.query || {};
  try {
    if (req.method === "GET" && q.istek) {
      const now = Date.now();
      const [lines] = await pipe([["ZRANGEBYSCORE", "istek", now - 600000, "+inf"]]);
      if (!lines || !lines.length) return res.end("");
      const ts = await pipe(lines.map(h => ["HGET", "hatt", h]));
      const due = lines.map((h, i) => [h, +ts[i] || 0]).filter(x => now - x[1] > 50000).sort((a, b) => a[1] - b[1]);
      return res.end(due.length ? due[0][0] : "");
    }
    if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
    const xml = await readBody(req);

    if (q.tur === "hat") {
      const h = String(q.h || "").slice(0, 10);
      const list = soapResult(xml, "GetHatOtoKonum_json");
      const araclar = list.map(v => ({ k: v.kapino, la: +v.enlem, lo: +v.boylam, y: v.yon, g: v.guzergahkodu, d: v.yakinDurakKodu, z: v.son_konum_zamani }));
      await pipe([["SET", "hat:" + h, JSON.stringify({ t: Date.now(), araclar }), "EX", 900], ["HSET", "hatt", h, Date.now()]]);
      return res.json({ ok: true, hat: h, adet: araclar.length });
    }

    if (q.tur === "filo") {
      const list = soapResult(xml, "GetFiloAracKonum_json");
      const cur = {}; let used = 0;
      for (const v of list) {
        const la = +v.Enlem, lo = +v.Boylam, s = +v.Hiz;
        if (!(la > 40.7 && la < 41.6 && lo > 27.9 && lo < 29.95) || !(s >= 0 && s < 110)) continue;
        if (ageMin(v.Saat) > 4) continue;            // eski konum: garajda/kapalı
        const k = cell(la, lo); (cur[k] || (cur[k] = [0, 0]))[0] += s; cur[k][1]++; used++;
      }
      // Önceki özetle harmanla (son ~10 dk ağırlıklı ortalama)
      const [oldS] = await pipe([["GET", "hiz"]]);
      const old = oldS ? JSON.parse(oldS) : null, fresh = old && Date.now() - old.t < 15 * 60000;
      const g = {};
      if (fresh) for (const [k, [v, n]] of Object.entries(old.g)) g[k] = [v, n * 0.6];
      for (const [k, [sum, n]] of Object.entries(cur)) {
        const o = g[k]; const v = sum / n;
        g[k] = o ? [(o[0] * o[1] + v * n) / (o[1] + n), o[1] + n] : [v, n];
      }
      for (const k of Object.keys(g)) { if (g[k][1] < 0.3) delete g[k]; else g[k] = [Math.round(g[k][0] * 10) / 10, Math.round(g[k][1] * 10) / 10]; }
      await pipe([["SET", "hiz", JSON.stringify({ t: Date.now(), cl: CELL_LAT, co: CELL_LON, g }), "EX", 1800]]);
      return res.json({ ok: true, arac: list.length, kullanilan: used, hucre: Object.keys(g).length });
    }
    res.statusCode = 400; res.json({ hata: "tur=filo ya da tur=hat" });
  } catch (e) { res.statusCode = 500; res.json({ hata: String(e.message || e) }); }
};
