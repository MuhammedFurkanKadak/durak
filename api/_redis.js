// Upstash Redis (REST) yardımcısı. Vercel'deki Upstash bağlantısı ortam değişkenlerini kendisi ekler.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function pipe(cmds) {
  if (!URL_ || !TOKEN) throw new Error("Redis bağlı değil (KV_REST_API_URL / KV_REST_API_TOKEN yok)");
  const r = await fetch(URL_.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("Redis: " + JSON.stringify(j).slice(0, 200));
  return j.map(x => (x && "result" in x ? x.result : null));
}
module.exports = { pipe, ok: !!(URL_ && TOKEN) };
