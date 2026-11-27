// Durak – Mac'teki toplayıcıdan araç konumlarını alır (Vercel Function)
// İBB konum servisi yalnızca Türkiye'den erişilebildiği için konumları Mac'teki betik çekip buraya yollar.
//   POST /api/konum-al?tur=filo          gövde: İBB'nin GetFiloAracKonum_json SOAP yanıtı (olduğu gibi)
//   POST /api/konum-al?tur=hat&h=26B     gövde: GetHatOtoKonum_json SOAP yanıtı
//   GET  /api/konum-al?istek=1           sırada çekilmesi gereken hat (uygulamada son 10 dk'da bakılan, en eski güncellenen)
// Hepsi "x-key" başlığında KONUM_KEY ister.
// Hat yanıtlarından "kapı no -> hat/yön" eşleşmesi öğrenilir; sonra o araçlar 2 dk'da bir gelen filo
// verisinden hat sorgusuna gerek kalmadan izlenir ("hatf"). Ölçümdeki hatların araç izleri "iz"e yazılır.
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
      const [lines, olc] = await pipe([["ZRANGEBYSCORE", "istek", now - 600000, "+inf"], ["ZRANGEBYSCORE", "olch", now - 5400000, "+inf"]]);
      const all = [...new Set([...(lines || []), ...(olc || [])])];
      if (!all.length) return res.end("");
      const ts = await pipe(all.map(h => ["HGET", "hatt", h]));
      const age = {}; all.forEach((h, i) => age[h] = now - (+ts[i] || 0));
      // Önce uygulamada bakılan hatlar (50 sn'den eski), sonra ölçümdeki hatların eşleşme tazelemesi (20 dk)
      const a = (lines || []).filter(h => age[h] > 50000).sort((x, y) => age[y] - age[x]);
      if (a.length) return res.end(a[0]);
      const b = (olc || []).filter(h => age[h] > 1200000).sort((x, y) => age[y] - age[x]);
      return res.end(b.length ? b[0] : "");
    }
    if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
    const xml = await readBody(req);

    if (q.tur === "hat") {
      const h = String(q.h || "").slice(0, 10);
      const list = soapResult(xml, "GetHatOtoKonum_json");
      const araclar = list.map(v => ({ k: v.kapino, la: +v.enlem, lo: +v.boylam, y: v.yon, g: v.guzergahkodu, d: v.yakinDurakKodu, z: v.son_konum_zamani }));
      const cmds = [["SET", "hat:" + h, JSON.stringify({ t: Date.now(), araclar }), "EX", 900], ["HSET", "hatt", h, Date.now()]];
      if (araclar.length) cmds.push(["HSET", "kapi", ...araclar.flatMap(v => [v.k, JSON.stringify({ h, y: v.y, t: Date.now() })])]);
      await pipe(cmds);
      return res.json({ ok: true, hat: h, adet: araclar.length });
    }

    if (q.tur === "filo") {
      const list = soapResult(xml, "GetFiloAracKonum_json");
      const cur = {}; let used = 0;
      for (const v of list) {
        const la = +v.Enlem, lo = +v.Boylam, s = +v.Hiz;
        if (!(la > 40.7 && la < 41.6 && lo > 27.9 && lo < 29.95) || !(s >= 0 && s < 110)) continue;
        if (ageMin(v.Saat) > 4) continue;            // eski konum: garajda/kapalı
        if (s < 3) continue;                          // duran araç (garaj, son durak, mola) yol hızını düşürmesin
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
      // Hat eşleşmesi bilinen araçları hatlara dağıt (6 saatten eski eşleşme sayılmaz)
      const [kapiFlat, olc, eskiS] = await pipe([["HGETALL", "kapi"], ["ZRANGEBYSCORE", "olch", Date.now() - 5400000, "+inf"], ["GET", "hatf"]]);
      // Bir önceki filo turundaki konumlar: aracın gidiş yönünü hareketinden anlamak için (hat sorgusundaki yön
      // bilgisi saatler önceye ait olabilir; araç son durakta dönünce eskir)
      const once = {}; try { const e = eskiS ? JSON.parse(eskiS) : null; if (e && Date.now() - e.t < 6 * 60000) for (const arr of Object.values(e.d)) for (const v of arr) once[v.k] = v; } catch (e) {}
      const kapi = {}; if (Array.isArray(kapiFlat)) for (let i = 0; i < kapiFlat.length; i += 2) { try { const m = JSON.parse(kapiFlat[i + 1]); if (Date.now() - m.t < 6 * 3600e3) kapi[kapiFlat[i]] = m; } catch (e) {} }
      const ist = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
      const hatf = {}, olcSet = new Set(olc || []), iz = [];
      for (const v of list) {
        const m = kapi[v.KapiNo]; if (!m || ageMin(v.Saat) > 4) continue;
        const la = +v.Enlem, lo = +v.Boylam;
        const o = once[v.KapiNo], rec = { k: v.KapiNo, la, lo, y: m.y, z: ist + " " + v.Saat, s: +v.Hiz || 0 };
        // hm: aracın en son yer değiştirdiği an (uzun süredir duran araç seferde değildir: garaj, son durak, mola)
        if (o) { if (Math.abs(o.la - la) + Math.abs(o.lo - lo) > 0.0006) { rec.pla = o.la; rec.plo = o.lo; rec.hm = Date.now(); }
                 else { if (o.pla) { rec.pla = o.pla; rec.plo = o.plo; } rec.hm = o.hm || 0; } }
        else rec.hm = rec.s > 3 ? Date.now() : 0;
        (hatf[m.h] || (hatf[m.h] = [])).push(rec);
        if (olcSet.has(m.h)) iz.push([m.h, v.KapiNo, m.y, +la.toFixed(5), +lo.toFixed(5), Date.parse(ist + "T" + v.Saat + "+03:00")]);
      }
      const cmds = [["SET", "hiz", JSON.stringify({ t: Date.now(), cl: CELL_LAT, co: CELL_LON, g }), "EX", 1800],
                    ["SET", "hatf", JSON.stringify({ t: Date.now(), d: hatf }), "EX", 900]];
      if (iz.length) cmds.push(["LPUSH", "iz", JSON.stringify({ t: Date.now(), v: iz })], ["LTRIM", "iz", 0, 1500]);
      await pipe(cmds);
      return res.json({ ok: true, arac: list.length, kullanilan: used, hucre: Object.keys(g).length, eslesen: Object.values(hatf).reduce((a, x) => a + x.length, 0), hat: Object.keys(hatf).length, iz: iz.length });
    }
    res.statusCode = 400; res.json({ hata: "tur=filo ya da tur=hat" });
  } catch (e) { res.statusCode = 500; res.json({ hata: String(e.message || e) }); }
};
