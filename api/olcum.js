// Durak – tahmin doğruluğu ölçümü (Vercel Function)
//   POST /api/olcum           uygulama gösterdiği ilk aracın tahminini yollar: {s,h,y,la,lo,pla,plo,nla,nlo,t0,g,i}
//                             g = GPS+trafik tahmini (ms), i = İETT tahmini (ms)
//   GET  /api/olcum?rapor=1   gerçek varışlarla (araç izlerinden) kıyas raporu
const { pipe } = require("./_redis");

const nrm = t => String(t || "").toLocaleUpperCase("tr").replace(/[^A-ZÇĞİÖŞÜ0-9]/g, "");
function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((ok, no) => { const ch = []; req.on("data", c => ch.push(c)); req.on("end", () => { try { ok(JSON.parse(Buffer.concat(ch).toString("utf8"))); } catch (e) { ok(null); } }); req.on("error", no); });
}
// Yerel metre koordinatı (durağa göre)
const xy = (la, lo, la0, lo0) => [(lo - lo0) * 111320 * Math.cos(la0 * Math.PI / 180), (la - la0) * 110540];

// Araç izinden durağı geçiş anı: durağın önceki->sonraki durak doğrultusunda işaret değiştirdiği an
function gecis(r, tr) {
  const [ux0, uy0] = xy(r.nla, r.nlo, r.pla, r.plo); const L = Math.hypot(ux0, uy0) || 1; const ux = ux0 / L, uy = uy0 / L;
  let best = null;
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1], b = tr[i];
    if (b.ts < r.t0 - 60000 || b.ts - a.ts > 6 * 60000) continue;
    const [ax, ay] = xy(a.la, a.lo, r.la, r.lo), [bx, by] = xy(b.la, b.lo, r.la, r.lo);
    const sa = ax * ux + ay * uy, sb = bx * ux + by * uy;
    const la_ = Math.abs(ax * uy - ay * ux), lb_ = Math.abs(bx * uy - by * ux);
    if (sa < 0 && sb >= 0 && la_ < 300 && lb_ < 300) {
      const t = a.ts + (b.ts - a.ts) * (-sa / (sb - sa));
      if (t >= r.t0 - 30000 && t <= r.t0 + 60 * 60000 && (!best || t < best)) best = t;   // 60 dk sonrası başka sefer
    }
  }
  return best;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") {
      const arr = await readBody(req);
      const ok = Array.isArray(arr) ? arr.filter(r => r && r.s && r.h && r.t0 && (r.g || r.i)).slice(0, 40) : [];
      if (!ok.length) return res.json({ ok: false });
      const now = Date.now();
      await pipe([["LPUSH", "olcum", ...ok.map(r => JSON.stringify(r))], ["LTRIM", "olcum", 0, 20000],
                  ["ZADD", "olch", ...[...new Set(ok.map(r => r.h))].flatMap(h => [now, h])]]);
      return res.json({ ok: true, n: ok.length });
    }
    if (!req.query || !req.query.rapor) { res.statusCode = 400; return res.json({ hata: "rapor=1" }); }
    const [olc, izs] = await pipe([["LRANGE", "olcum", 0, -1], ["LRANGE", "iz", 0, -1]]);
    // İzleri hat -> araç -> zaman sıralı noktalar
    const T = {}, hatIlk = {}, anlar = []; let izSon = 0, izIlk = Infinity;
    for (const s of izs || []) { const z = JSON.parse(s); izSon = Math.max(izSon, z.t); izIlk = Math.min(izIlk, z.t); anlar.push(z.t);
      for (const [h, k, y, la, lo, ts] of z.v) { ((T[h] || (T[h] = {}))[k] || (T[h][k] = { y, p: [] })).p.push({ la, lo, ts }); hatIlk[h] = Math.min(hatIlk[h] || Infinity, z.t); } }
    anlar.sort((a, b) => a - b);
    // [a,b] aralığında izde 6 dk'dan uzun boşluk var mı (Mac uyuduysa o aradaki araç kaçmış olabilir)
    const bosluk = (a, b) => { let prev = null; for (const t of anlar) { if (t < a - 360000) continue; if (prev != null && t - prev > 360000) return true; prev = t; if (t > b) break; } return prev == null || prev < b; };
    for (const h in T) for (const k in T[h]) T[h][k].p.sort((a, b) => a.ts - b.ts);
    const kova = m => m < 5 ? "0-5 dk" : m < 10 ? "5-10 dk" : m < 20 ? "10-20 dk" : "20+ dk";
    const top = { g: {}, i: {}, h2: {} }, hat = {}; let olculen = 0, bekleyen = 0, kapsamDisi = 0;
    const neden = { hat_henuz_izlenmiyordu: 0, iz_boslugu: 0, otobus_gelmedi: 0 }, gelmeyen = {};
    // ?bas=2026-11-27T11:20 gibi: yalnız bu andan (İstanbul saati) sonraki tahminler
    const bas = req.query.bas ? Date.parse(String(req.query.bas) + "+03:00") : 0;
    for (const s of olc || []) {
      const r = JSON.parse(s);
      if (bas && r.t0 < bas) continue;
      if (r.t0 < izIlk || !hatIlk[r.h] || r.t0 < hatIlk[r.h] + 60000) { kapsamDisi++; neden.hat_henuz_izlenmiyordu++; continue; }   // bu hat o an henüz izlenmiyordu
      const araclar = Object.values(T[r.h] || {}).filter(a => !a.y || !r.y || nrm(a.y) === nrm(r.y) || nrm(a.y).includes(nrm(r.y)) || nrm(r.y).includes(nrm(a.y)));
      let gercek = null; for (const a of araclar) { const t = gecis(r, a.p); if (t && (!gercek || t < gercek)) gercek = t; }
      if (!gercek) {
        if (izSon - r.t0 < 60 * 60000) { bekleyen++; continue; }
        if (bosluk(r.t0, r.t0 + 60 * 60000)) { kapsamDisi++; neden.iz_boslugu++; continue; }
        // İz kesintisizdi ama 60 dk içinde o yönde hiçbir otobüs durağı geçmedi: tahmin edilen araç gelmedi
        kapsamDisi++; neden.otobus_gelmedi++;
        const gk = (gelmeyen[r.h] || (gelmeyen[r.h] = { adet: 0, gps: 0, iett: 0 })); gk.adet++; if (r.g) gk.gps++; if (r.i) gk.iett++;
        continue;
      }
      if (bosluk(r.t0, gercek)) { kapsamDisi++; neden.iz_boslugu++; continue; }
      olculen++;
      r.h2 = r.i || r.g;   // hibrit: İETT tahmini varsa o, yoksa GPS
      for (const src of ["g", "i", "h2"]) {
        if (!r[src]) continue;
        const hata = (r[src] - gercek) / 60000, uf = (gercek - r.t0) / 60000, kv = kova(uf);
        const b = top[src][kv] || (top[src][kv] = { n: 0, mutlak: 0, isaret: 0, iki: 0 }); b.n++; b.mutlak += Math.abs(hata); b.isaret += hata; if (Math.abs(hata) <= 2) b.iki++;
        if (src !== "h2") { const hb = (hat[r.h] || (hat[r.h] = { g: { n: 0, m: 0 }, i: { n: 0, m: 0 } }))[src]; hb.n++; hb.m += Math.abs(hata); }
      }
    }
    const ozet = o => Object.fromEntries(Object.entries(o).map(([k, b]) => [k, { adet: b.n, iki_dk_icinde_yuzde: Math.round(100 * b.iki / b.n), ortalama_sapma_dk: +(b.mutlak / b.n).toFixed(2), egilim_dk: +(b.isaret / b.n).toFixed(2) }]));
    res.json({
      aciklama: "iki_dk_icinde_yuzde = tahminin gerçek varışa ±2 dk içinde tuttuğu kayıtların oranı (hedef bu); sapma = |tahmin - gerçek varış|; eğilim + ise tahmin geç (araç tahminden önce geldi), - ise erken",
      kayit: (olc || []).length, olculen, bekleyen, kapsamDisi, kapsam_disi_nedenleri: neden,
      izlenen_hat: Object.keys(T).length, iz_anlik: anlar.length, iz_baslangic: izIlk < Infinity ? new Date(izIlk + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : null,
      tahmin_edilip_gelmeyen: gelmeyen,
      bas: bas ? new Date(bas + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : null,
      gps_trafik: ozet(top.g), iett: ozet(top.i), hibrit_iett_yoksa_gps: ozet(top.h2),
      hatlar: Object.fromEntries(Object.entries(hat).map(([h, v]) => [h, { gps: v.g.n ? +(v.g.m / v.g.n).toFixed(2) : null, gps_n: v.g.n, iett: v.i.n ? +(v.i.m / v.i.n).toFixed(2) : null, iett_n: v.i.n }])),
    });
  } catch (e) { res.statusCode = 500; res.json({ hata: String(e.message || e) }); }
};
