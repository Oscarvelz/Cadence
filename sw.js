// Keeps the app working without internet after the first visit.
const CACHE = "app-2.1.18.2.88";
// The speech runtime (about 21 MB) is cached on first use, apart from the app, so an update never downloads it again.
const SPEECH = "cadence-speech-v1";
// Every app file (fonts included), written in at build time, so the app works offline from the first install.
const CORE = ["./BinaryModule-BmeyZWwZ-BQhC_AXh.js","./alegreya-sans-latin-500-DS713u5J.woff2","./alegreya-sans-latin-700-DEbcy2sF.woff2","./alegreya-sans-latin-ext-500-TH5u60nj.woff2","./alegreya-sans-latin-ext-700-HuHd3-Mg.woff2","./annotate-editor-CFu4-Y7u.css","./annotate-editor-CLBSpb3f.js","./backup-cert-CjzPFAZr.js","./backup-crypto-D5LYbmjj.js","./backup-snapshot-DEjngNQ-.js","./boot-CvM73FKQ.js","./cadence-app-BzwVwAz1.css","./cadence-app-ckVgBW6d.js","./capture-flow-D9ObVloV.js","./cinzel-latin-600-Dd5YO2UX.woff2","./clipboard-BVSHxyr6.js","./cormorant-garamond-italic-latin-Y14P-dkT.woff2","./cormorant-garamond-latin-CUoBjw-S.woff2","./dist-Blv1mt68.js","./dist-BoHMOFax.js","./dist-Dz-6bxfp.js","./embed-worker-Cn5rcbjh.js","./favicon.svg","./fill-docx-BVgkmyBr.js","./forms-OqhfKT6X.js","./harper_wasm_slim_bg-ChaU7UNk.wasm","./icon-192.png","./icon-512.png","./icon-maskable.png","./icon.svg","./index-BTdtr-jR.css","./index-Bj49hYsX.js","./isp-index-data-BUKXRxTA.js","./layout-b4Y4mFcL.js","./manifest.webmanifest","./middleware-jw6O9fVx.js","./note-prefs-DhVKf-2w.js","./parakeet-worker-CSF-WdI7.js","./pdf-BOJGuCn3.js","./pdf.worker.min.mjs","./react-dom-Sb3vDXHg.js","./render-html-Ca8aDkbj.js","./schedule-sheet-95KYv4TQ.js","./slimBinary-CKEn4HCS.js","./spell-en-1.txt.gz","./spell-es-1.txt.gz","./spell-worker-Bhx_4272.js","./src-bwq87gBr.js","./store-e9aPO_WA.js","./tinos-latin-400-normal-rilFpyjL.woff2","./xlsx-BKER4Xe2.js","./yuji-syuku-latin-CXYA-8E_.woff2","./fonts/figtree-latin-ext-hinted.woff2","./fonts/figtree-latin-ext-unhinted.woff2","./fonts/figtree-latin-hinted.woff2","./fonts/figtree-latin-unhinted.woff2","./fonts/fonts-hinted.css","./fonts/fonts-unhinted.css","./fonts/newsreader-latin-ext-hinted.woff2","./fonts/newsreader-latin-ext-unhinted.woff2","./fonts/newsreader-latin-hinted.woff2","./fonts/newsreader-latin-unhinted.woff2","./fonts/newsreader-vietnamese-hinted.woff2","./fonts/newsreader-vietnamese-unhinted.woff2"];
// The OCR engine for scanned PDFs (worker, core, English data, ~7 MB): kept apart from the app like the speech runtime,
// fetched once in the background (when the page sends "warm-ocr") and kept across updates. The name changes only when the OCR files change.
const OCR = "cadence-ocr-5.1.1";
const OCR_FILES = ["./ocr/worker.min.js","./ocr/tesseract-core-simd-lstm.wasm.js","./ocr/eng.traineddata.gz"];
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([new Request("./", { cache: "reload" }), new Request("./index.html", { cache: "reload" })]).then(() =>
    // Best effort: one missing file never blocks the install.
    Promise.allSettled(CORE.map((f) => c.match(f).then((hit) => hit || fetch(f, { cache: "reload" }).then((r) => { if (r.ok) return c.put(f, r); }))))
  )));
});
// The page asks for the OCR files once it is open (never during install, so an update is never held up by them).
const warmOcr = () => caches.open(OCR).then((c) => Promise.allSettled(OCR_FILES.map((f) => c.match(f).then((hit) => hit || fetch(f).then((r) => { if (r.ok) return c.put(f, r); }))))).catch(() => {});
self.addEventListener("message", (e) => { if (e.data && e.data.type === "warm-ocr") e.waitUntil(warmOcr()); });
// Only old app caches are cleared. The search model ("transformers-cache"), the voice package and the speech runtime stay.
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => (k.startsWith("app-") && k !== CACHE) || (k.startsWith("cadence-ocr-") && k !== OCR)).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") {
    // Always ask the network for the newest page, so an update shows on the next open.
    // 2.1.18.2.39 (audit SW): the response used to be cached as the offline page unchecked —
    // a captive-portal login page or a proxy error page would replace the app and then be
    // served as "the app" offline. Only a valid document response (ok, and HTML when a
    // content type is declared) may take the slot; anything else leaves the last good page.
    e.respondWith(fetch(req, { cache: "no-store" }).then((r) => {
      const type = r.headers.get("content-type") || "";
      if (r.ok && (type === "" || type.includes("text/html"))) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("./index.html", copy)); }
      return r;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  // Model files (models/...) are large; transformers.js stores them in its own cache. Leave them to it.
  if (url.origin === location.origin && url.pathname.includes("/models/")) return;
  if (url.origin === location.origin && /\/ort-wasm[^/]*\.wasm$/.test(url.pathname)) {
    e.respondWith(caches.open(SPEECH).then((c) => c.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) {
        // Keep one runtime: drop an older hashed copy once the new one is stored.
        c.put(req, r.clone()).then(() => c.keys()).then((rs) => rs.forEach((q) => { if (new URL(q.url).pathname !== url.pathname) c.delete(q); }));
      }
      return r;
    }))));
    return;
  }
  // The OCR files: from their own cache, else the network (then kept).
  if (url.origin === location.origin && url.pathname.includes("/ocr/")) {
    e.respondWith(caches.open(OCR).then((c) => c.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }))));
    return;
  }
  // Cadence needs no other site (fonts and models are its own). Anything else, e.g. an Email a Copy tab, is left alone.
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })));
});
