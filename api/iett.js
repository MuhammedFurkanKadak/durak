// Durak – İBB/İETT web servislerine köprü (Vercel sunucusuz fonksiyon)
// Kullanım: /api/iett?svc=SeferGerceklesme&m=GetHatOtoKonum_json&HatKodu=500T

const BASE = "https://api.ibb.gov.tr/iett";
const SERVICES = {
  HatDurakGuzergah: "/UlasimAnaVeri/HatDurakGuzergah",
  PlanlananSeferSaati: "/UlasimAnaVeri/PlanlananSeferSaati",
  SeferGerceklesme: "/FiloDurum/SeferGerceklesme",
  Duyurular: "/UlasimDinamikVeri/Duyurular",
  ibb: "/ibb/ibb",
};
// Sadece izin verilen metotlar çağrılabilir
const ALLOWED = new Set([
  "GetHat_json", "GetDurak_json", "GetHatOtoKonum_json", "GetFiloAracKonum_json",
  "GetPlanlananSeferSaati_json", "GetDuyurular_json", "DurakDetay_GYY", "HatServisi_GYY",
]);
// Canlı veriler kısa, sabit veriler uzun süre önbelleğe alınır
const LIVE = new Set(["GetHatOtoKonum_json", "GetFiloAracKonum_json", "GetDuyurular_json"]);

const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const xmlUnesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { svc, m, ...params } = req.query || {};
  if (!SERVICES[svc] || !ALLOWED.has(m)) {
    return res.status(400).json({ ok: false, error: "Geçersiz servis ya da metot" });
  }
  for (const k of Object.keys(params)) {
    if (!/^[A-Za-z_]+$/.test(k)) return res.status(400).json({ ok: false, error: "Geçersiz parametre" });
  }

  const args = Object.entries(params).map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join("");
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><${m} xmlns="http://tempuri.org/">${args}</${m}></soap:Body></soap:Envelope>`;

  try {
    const r = await fetch(BASE + SERVICES[svc] + ".asmx", {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"http://tempuri.org/${m}"` },
      body: envelope,
      signal: AbortSignal.timeout(20000),
    });
    const xml = await r.text();
    const match = xml.match(new RegExp(`<${m}Result[^>]*>([\\s\\S]*?)</${m}Result>`));
    if (!match) {
      return res.status(502).json({ ok: false, status: r.status, error: "Beklenmeyen yanıt", raw: xml.slice(0, 1500) });
    }
    const text = xmlUnesc(match[1]);
    let data, format = "json";
    try { data = JSON.parse(text); } catch { data = text; format = "text"; }

    res.setHeader("Cache-Control", LIVE.has(m) ? "s-maxage=15, stale-while-revalidate=30" : "s-maxage=86400, stale-while-revalidate=3600");
    return res.status(200).json({ ok: true, format, data });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "İBB servisine ulaşılamadı: " + e.message });
  }
};
