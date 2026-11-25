// Durak servis çalışanı: uygulama kabuğunu ve hat verisini telefonda saklar (internet yokken de açılır).
const V = "durak-v3";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== "durak-tiles").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Önce ağ, olmazsa kayıtlı kopya (sayfa ve veri her zaman güncel kalsın)
async function netFirst(req) {
  const c = await caches.open(V);
  try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }
  catch (e) { const m = await c.match(req, { ignoreSearch: true }); if (m) return m; throw e; }
}
// Önce kayıtlı kopya, arkada güncelle (kütüphane, ikonlar, fontlar)
async function cacheFirst(req, name = V) {
  const c = await caches.open(name); const m = await c.match(req);
  const p = fetch(req).then(r => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => m);
  return m || p;
}
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    if (u.pathname.startsWith("/api/")) return;                 // canlı istekler
    if (r.mode === "navigate" || u.pathname === "/index.html" || u.pathname.endsWith(".json")) return e.respondWith(netFirst(r));
    return e.respondWith(cacheFirst(r));
  }
  if (u.hostname === "unpkg.com" || u.hostname.endsWith("gstatic.com") || u.hostname === "fonts.googleapis.com") return e.respondWith(cacheFirst(r));
  if (u.hostname.endsWith("tile.openstreetmap.org")) return e.respondWith(cacheFirst(r, "durak-tiles"));
});
