// Durak – canlı varış aracısı (Vercel Function)
// iett.istanbul'un durak sayfasındaki "Anlık Durak Bilgileri"ni alır, JSON'a çevirir.
// Kullanım: /api/canli?d=225281,225282   (İETT durak kodları, en fazla 8)

const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

function parse(html) {
  const out = [];
  const re = /<span>\s*([^<]+?)\s*<\/span>\s*<p>\s*([^<]*?)\s*<b>\s*([^<]*?)\s*<\/b>/g;
  let m;
  while ((m = re.exec(html))) {
    const raw = decode(m[3]);
    const t = raw.match(/\((\d{1,2}:\d{2})\)\s*(\d+)\s*dk/i);
    const rest = raw.replace(/\(.*?\)/, " ").replace(/\d+\s*dk/i, " ");
    out.push({ h: decode(m[1]), n: decode(m[2]), s: t ? t[1] : null, dk: t ? +t[2] : null, b: /\bB\b/.test(rest) });
  }
  return out;
}

async function one(code) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://iett.istanbul/tr/RouteStation/GetStationInfo?dcode=${code}&langid=1`, {
      headers: { "User-Agent": "Mozilla/5.0 (Durak toplu tasima uygulamasi)", "Accept": "text/html" },
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    return parse(await r.text());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const codes = [...new Set(String((req.query && req.query.d) || "").split(","))]
    .filter(c => /^\d{3,7}$/.test(c)).slice(0, 8);
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!codes.length) { res.statusCode = 400; return res.json({ hata: "d parametresi gerekli (İETT durak kodu)" }); }
  const d = {};
  await Promise.all(codes.map(async c => { d[c] = await one(c); }));
  res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=10");
  res.json({ t: Date.now(), d });
};

module.exports.parse = parse;
