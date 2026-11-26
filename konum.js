// Durak – İETT araç konum servisi TESTİ (Vercel Function)
// İBB'nin SeferGerceklesme servisinin bugün çalışıp çalışmadığını ve ne döndürdüğünü gösterir.
// Kullanım: /api/konum?hat=26B
// Not: İBB dokümanına göre bu servis saatte 100 istekle sınırlı; bu sayfayı arka arkaya yenileme.

const BASE = "https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx";
const UA = "Mozilla/5.0 (Durak toplu tasima uygulamasi)";

async function timed(fn) {
  const t0 = Date.now();
  try { const v = await fn(); return { ms: Date.now() - t0, ...v }; }
  catch (e) { return { ms: Date.now() - t0, hata: String(e && e.message || e) }; }
}

async function get(url, opts = {}, ms = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: ctl.signal });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(timer); }
}

// WSDL'den hedef namespace'i bul (genelde http://tempuri.org/)
async function namespace() {
  const r = await get(BASE + "?wsdl");
  const m = r.text.match(/targetNamespace="([^"]+)"/);
  return { status: r.status, ns: m ? m[1] : null, metodlar: [...new Set([...r.text.matchAll(/<wsdl:operation name="([^"]+)"/g)].map(x => x[1]))] };
}

function soapBody(ns, method, params) {
  const p = Object.entries(params).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${method} xmlns="${ns}">${p}</${method}></soap:Body></soap:Envelope>`;
}

// SOAP yanıtındaki <...Result> içini al, JSON'a çevirmeyi dene
function result(xml, method) {
  const m = xml.match(new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`));
  if (!m) return { ham: xml.slice(0, 600) };
  const raw = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  try { const j = JSON.parse(raw); return { json: j }; } catch (e) { return { ham: raw.slice(0, 600) }; }
}

async function soap(ns, method, params) {
  const r = await get(BASE, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${ns}${method}"` },
    body: soapBody(ns, method, params),
  }, 15000);
  const out = result(r.text, method);
  const list = Array.isArray(out.json) ? out.json : null;
  return {
    status: r.status,
    adet: list ? list.length : null,
    alanlar: list && list[0] ? Object.keys(list[0]) : null,
    ornek: list ? list.slice(0, 3) : null,
    ham: out.ham || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const hat = String((req.query && req.query.hat) || "26B").replace(/[^0-9A-Za-zÇĞİÖŞÜçğıöşü-]/g, "").slice(0, 8);
  const w = await timed(namespace);
  const ns = (w.ns || "http://tempuri.org/").replace(/\/?$/, "/");
  const [hatKonum, filo] = await Promise.all([
    timed(() => soap(ns, "GetHatOtoKonum_json", { HatNo: hat })),
    timed(() => soap(ns, "GetFiloAracKonum_json", {})),
  ]);
  // Filo yanıtı çok büyük olabilir: sadece özet
  res.json({ zaman: new Date().toISOString(), hat, wsdl: { status: w.status, ms: w.ms, ns: w.ns, metodlar: w.metodlar, hata: w.hata }, hatKonum, filo });
};
