// Keeps the app working without internet after the first visit.
const CACHE = "app-2.1.17.1.1";
// The speech runtime (about 21 MB) is cached on first use, apart from the app, so an update never downloads it again.
const SPEECH = "cadence-speech-v1";
// Every app file, written in at build time, so the app works offline from the first install.
const CORE = ["./BinaryModule-BmeyZWwZ-B3lEn6ls.js","./boot-Cs9rIFEZ.js","./cadence-app-CJYk7CSd.js","./capture-flow-DPZ4MQbQ.js","./dist-BoHMOFax.js","./dist-DbezAxSk.js","./dist-Dz-6bxfp.js","./embed-worker-qRpPDjEn.js","./favicon.svg","./harper_wasm_slim_bg-ChaU7UNk.wasm","./icon-192.png","./icon-512.png","./icon-maskable.png","./icon.svg","./index-DivnPfVx.css","./index-DyM3mKNr.js","./manifest.webmanifest","./pdf-CCyngyBR.js","./pdf.worker.min.mjs","./react-dom-Sb3vDXHg.js","./slimBinary-DpE55hWN.js","./spell-en-1.txt.gz","./spell-es-1.txt.gz","./spell-worker-Bhx_4272.js","./src-X90pKm0x.js","./whisper-worker-My1c2EuS.js","./xlsx-BKER4Xe2.js"];
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([new Request("./", { cache: "reload" }), new Request("./index.html", { cache: "reload" })]).then(() =>
    // Best effort: one missing file never blocks the install.
    Promise.allSettled(CORE.map((f) => c.match(f).then((hit) => hit || fetch(f, { cache: "reload" }).then((r) => { if (r.ok) return c.put(f, r); }))))
  )));
});
// Only old app caches are cleared. The Precise model ("transformers-cache") and the speech runtime stay.
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("app-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") {
    // Always ask the network for the newest page, so an update shows on the next open.
    e.respondWith(fetch(req, { cache: "no-store" }).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("./index.html", copy)); return r; }).catch(() => caches.match("./index.html")));
    return;
  }
  // The Precise model files (models/...) are large; transformers.js stores them in its own cache. Leave them to it.
  if (url.origin === location.origin && url.pathname.includes("/models/")) return;
  if ((url.origin === location.origin || url.hostname === "cdn.jsdelivr.net") && /\/ort-wasm[^/]*\.wasm$/.test(url.pathname)) {
    e.respondWith(caches.open(SPEECH).then((c) => c.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) {
        // Keep one runtime: drop an older hashed copy once the new one is stored.
        c.put(req, r.clone()).then(() => c.keys()).then((rs) => rs.forEach((q) => { if (new URL(q.url).pathname !== url.pathname) c.delete(q); }));
      }
      return r;
    }))));
    return;
  }
  // Model files from Hugging Face (the fallback); transformers.js keeps them in its own cache. Leave them alone here.
  if (url.origin !== location.origin && !url.hostname.endsWith("gstatic.com") && !url.hostname.endsWith("googleapis.com")) return;
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })));
});
