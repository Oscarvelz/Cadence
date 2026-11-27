// edu1 bench page: the timing measurement of
// EDU1-PHONE-MEASUREMENT.md. Generation runs the
// page-side beam search (beam-search.js) over the
// raw ONNX sessions: the library's generate returns
// only 1 candidate for this model under the bench
// decoding (measured 2026-11-27), and the registered
// measure is 5 candidates per paragraph. The beam
// search replicates the bench decoding exactly
// (HF 4.57 beam semantics: beams 10, returns 5,
// repetition penalty 2.0, no-repeat-ngram 2,
// max length 320) and was verified in node against
// the parity record. It runs in a Web Worker
// (bench-worker.js), never on the main thread, and
// the page times the round trip, which is the time
// the user would live; a ticker on the main thread
// proves the interface does not freeze meanwhile.
// This bench measures TIME, not quality: any claim
// about candidate quality in a browser needs its
// own judge run; the parity gate does not cover it.
//
// Protocol (Hark, 2026-11-27): the verdict is the
// share of presses that miss 10 s, counted across
// all presses and on edu1's 15 unique paragraphs
// alone. Every row carries processor, memory and
// browser with version, plus crossOriginIsolated,
// the storage.persist() result, and the heap figure
// as a lower bound. The press set is the 15 unique
// paragraphs (exam 2, the development bank), after
// one uncounted warm-up press.
// The page itself loads no model library: the
// worker (bench-worker.js) owns the tokenizer, the
// ONNX sessions and the beam search.

// The cache name the real button would use; the
// bench runs under Cadence's service worker scope
// (/Cadence/) and shares the oscarvelz.github.io
// origin's storage and quota with the other apps.
const CACHE_NAME = "cadence-edu1-model-v1";
const MODEL_DIR = "./model-ext/";
const MODEL_FILES = [
  "onnx/encoder_model.onnx",
  "onnx/encoder_model.shard0", "onnx/encoder_model.shard1", "onnx/encoder_model.shard2", "onnx/encoder_model.shard3",
  "onnx/encoder_model.shard4", "onnx/encoder_model.shard5", "onnx/encoder_model.shard6", "onnx/encoder_model.shard7",
  "onnx/decoder_model_merged.onnx",
  "onnx/decoder_model_merged.shard0", "onnx/decoder_model_merged.shard1", "onnx/decoder_model_merged.shard2",
  "onnx/decoder_model_merged.shard3", "onnx/decoder_model_merged.shard4", "onnx/decoder_model_merged.shard5",
  "onnx/decoder_model_merged.shard6", "onnx/decoder_model_merged.shard7", "onnx/decoder_model_merged.shard8",
  "onnx/decoder_model_merged.shard9", "onnx/decoder_model_merged.shard10",
  "tokenizer.json", "tokenizer_config.json", "config.json", "generation_config.json",
].map((f) => MODEL_DIR + f);

const WARMUP = "Mr. Delgado was moved to a different dorm in the housing unit because his conflicts with two residents on the wing had escalated during the week.";
// edu1's 15 unique paragraphs on exam 2 (the H2
// autopsy population): id, family, words, text.
const PRESSES = [
  ["x2-10", "fronting-time", 18, "She practices the slow breathing exercise from group before each session with the counselor in the program office."],
  ["x2-11", "fronting-time", 16, "The counselor will file the progress note when the signed release arrives from the records office."],
  ["x2-12", "fronting-time", 18, "Ms. Ellison joined the morning walking group after the doctor cleared her for light exercise on the yard."],
  ["x2-13", "fronting-time", 22, "Mr. Aldana slept through the whole night for the first time since intake day after his medication was adjusted by the psychiatrist."],
  ["x2-16", "fronting-time", 21, "Ms. Czarnecki will meet with the treatment team after she completes the fourth step of the workbook with her sponsor group."],
  ["x2-18", "fronting-time", 16, "She writes two pages in her journal every night after the final count clears the dorm."],
  ["x2-20", "fronting-condition", 33, "The team will extend her stay in the phase if the discharge summary is not signed by the end of the week. The counselor noted the change in her chart the same day."],
  ["x2-22", "fronting-condition", 22, "Ms. Haddad will lose her yard privileges for a full week if she misses another assigned group without an excuse from medical."],
  ["x2-24", "fronting-condition", 22, "Ms. Ellison will be moved back to the general dorm if her blood pressure stays within the normal range for a month."],
  ["x2-27", "fronting-purpose", 23, "She copied the list of warning signs onto a card to carry it in the pocket of her uniform during the work detail."],
  ["x2-28", "fronting-purpose", 20, "The counselor meets with Mr. Bergeron before each family visit to prepare him for the questions his children may ask."],
  ["x2-32", "voice", 17, "An officer inspected the dorm bunks and the property boxes in every bay before the evening count."],
  ["x2-35", "voice", 18, "The classification officer reviewed her file in the records office before the housing board met on Tuesday morning."],
  ["x2-41", "two-actor-with", 13, "The nurse checked the dosage with the pharmacist before the medication line opened."],
  ["x2-43", "two-actor-with", 19, "She walked two slow laps of the yard with her roommate after the argument in the dorm had cooled."],
];

const $ = (id) => document.getElementById(id);
const log = (line) => { $("log").textContent += line + "\n"; };
const results = {};
// Recorded with every latency number, as a fact
// only; the bench changes no headers (isolation
// headers are a separate Cadence change).
const isolated = () => self.crossOriginIsolated === true;
results.crossOriginIsolatedOnLoad = isolated();
log("crossOriginIsolated on load: " + results.crossOriginIsolatedOnLoad);

// Machine and browser identity, carried on every
// row (Hark's protocol). The browser cannot see the
// CPU model; it reports hardwareConcurrency (logical
// processors) and deviceMemory (approximate RAM in
// GB, Chrome-type browsers only) next to the full
// user agent string, which names browser and
// version.
const machine = {
  userAgent: navigator.userAgent,
  logicalProcessors: navigator.hardwareConcurrency ?? null,
  deviceMemoryGB: navigator.deviceMemory ?? null,
  platform: navigator.platform ?? null,
};
results.machine = machine;
$("m-machine").textContent =
  machine.userAgent + " | logical processors: " + (machine.logicalProcessors ?? "unavailable") +
  " | device memory: " + (machine.deviceMemoryGB ? machine.deviceMemoryGB + " GB (approximate)" : "unavailable");

let peakHeap = 0;
let heapTimer = null;
const sampleHeap = () => {
  if (performance.memory) peakHeap = Math.max(peakHeap, performance.memory.usedJSHeapSize);
};

async function cacheState() {
  const cache = await caches.open(CACHE_NAME);
  const hits = [];
  for (const f of MODEL_FILES) hits.push((await cache.match(f)) ? "present" : "absent");
  return hits;
}

const onLoad = await cacheState();
results.cacheOnLoad = onLoad;
$("m-cache").textContent = onLoad.filter((h) => h === "present").length + " of " + MODEL_FILES.length + " files present";
log("cache on load: " + onLoad.join(", "));

// Shared-origin storage: usage and quota for the
// whole oscarvelz.github.io origin (Cadence, Faro,
// Brizna and the rest share both), and whether the
// browser marks the storage persistent.
async function storageState() {
  const out = {};
  if (navigator.storage) {
    if (navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      out.usageBytes = e.usage ?? null;
      out.quotaBytes = e.quota ?? null;
    }
    if (navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
  }
  return out;
}
const storageOnLoad = await storageState();
results.storageOnLoad = storageOnLoad;
$("m-storage").textContent =
  "usage " + (storageOnLoad.usageBytes ?? "unavailable") +
  " bytes, quota " + (storageOnLoad.quotaBytes ?? "unavailable") +
  " bytes, persistent: " + (storageOnLoad.persisted === undefined ? "unavailable" : storageOnLoad.persisted ? "yes" : "no");
log("storage on load: " + JSON.stringify(storageOnLoad));

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  heapTimer = setInterval(sampleHeap, 250);

  // Before caching a 276 MB payload on a shared
  // origin (eviction would wipe every app on
  // oscarvelz.github.io), ask for persistent
  // storage and record the answer.
  let persistResult = null;
  if (navigator.storage && navigator.storage.persist) {
    persistResult = await navigator.storage.persist();
    log("storage.persist() before caching: " + persistResult);
  } else {
    log("storage.persist() unavailable in this browser");
  }
  results.persistRequested = persistResult;

  // First load: download the model files, timed,
  // and store them in Cache Storage.
  let t0 = performance.now();
  let bytes = 0;
  const cache = await caches.open(CACHE_NAME);
  for (const f of MODEL_FILES) {
    if (await cache.match(f)) continue;
    const res = await fetch(f);
    const buf = await res.arrayBuffer();
    bytes += buf.byteLength;
    await cache.put(f, new Response(buf, { headers: { "Content-Type": "application/octet-stream" } }));
    log("downloaded " + f + " " + buf.byteLength + " bytes");
  }
  const downloadMs = performance.now() - t0;
  results.download = { ms: Math.round(downloadMs), bytes, crossOriginIsolated: isolated() };
  $("m-download").textContent = bytes > 0 ? Math.round(downloadMs) + " ms for " + bytes + " bytes" : "files already cached, no download";

  // Load from cache: read every file back out of
  // Cache Storage, timed.
  t0 = performance.now();
  let cachedBytes = 0;
  for (const f of MODEL_FILES) {
    const hit = await cache.match(f);
    if (hit) cachedBytes += (await hit.arrayBuffer()).byteLength;
  }
  const cacheMs = performance.now() - t0;
  results.cacheLoad = { ms: Math.round(cacheMs), bytes: cachedBytes, crossOriginIsolated: isolated() };
  $("m-cacheload").textContent = Math.round(cacheMs) + " ms for " + cachedBytes + " bytes";

  // Model init, inside the worker: tokenizer plus
  // both ONNX sessions over the external-data
  // layout. The page times the round trip.
  const worker = new Worker("./bench-worker.js", { type: "module" });
  const pending = new Map();
  let nextId = 1;
  worker.onmessage = (e) => {
    const msg = e.data;
    const p = pending.get(msg.type === "ready" ? 0 : msg.id);
    if (p) { pending.delete(msg.type === "ready" ? 0 : msg.id); p(msg); }
  };
  const call = (msg) => new Promise((resolve) => {
    const key = msg.type === "init" ? 0 : nextId;
    if (msg.type === "generate") msg.id = nextId++;
    pending.set(key, resolve);
    worker.postMessage(msg);
  });
  t0 = performance.now();
  const ready = await call({ type: "init" });
  const initMs = Math.round(performance.now() - t0);
  results.init = { ms: initMs, workerInitMs: ready.ms, runsIn: "Web Worker", crossOriginIsolated: isolated() };
  $("m-init").textContent = initMs + " ms (in a Web Worker)";

  // Main-thread responsiveness probe: a 100 ms
  // ticker runs through the presses. If generation
  // blocked this thread, the ticks would collapse.
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 100);
  const pressStart = performance.now();

  // Warm-up press, uncounted.
  const warm = await call({ type: "generate", text: "paraphrase: " + WARMUP });
  log("warm-up press: " + warm.candidates.length + " candidates (uncounted)");

  // The counted presses: the 15 unique paragraphs,
  // 5 candidates each, the bench decoding. The
  // row's ms is the round trip, the time the user
  // would live; workerMs is the worker's own
  // generation time.
  const rows = [];
  for (const [id, family, words, text] of PRESSES) {
    sampleHeap();
    t0 = performance.now();
    const res = await call({ type: "generate", text: "paraphrase: " + text });
    const ms = Math.round(performance.now() - t0);
    sampleHeap();
    const row = {
      id, family, words, ms,
      workerMs: res.workerMs,
      over10s: ms > 10000,
      candidates: res.candidates.length,
      crossOriginIsolated: isolated(),
      persistResult,
      heapLowerBoundBytes: performance.memory ? peakHeap : null,
      ...machine,
    };
    rows.push(row);
    log(id + " (" + family + ", " + words + " words): " + ms + " ms, " + res.candidates.length + " candidates" + (row.over10s ? ", OVER 10 s" : ""));
  }
  clearInterval(ticker);
  const pressElapsed = performance.now() - pressStart;
  results.mainThread = {
    ticks, expectedTicks: Math.round(pressElapsed / 100),
    note: "ticks counted on the page's main thread during all presses; a collapse would mean the interface froze",
  };
  log("main thread during presses: " + ticks + " ticks of about " + Math.round(pressElapsed / 100) + " expected");
  worker.terminate();
  results.rows = rows;
  const misses = rows.filter((r) => r.over10s);
  results.missShareAll = { misses: misses.length, presses: rows.length, share: rows.length ? misses.length / rows.length : null };
  results.missShareUnique15 = results.missShareAll;
  results.missesDetail = misses.map((r) => ({ id: r.id, family: r.family, words: r.words, ms: r.ms }));
  $("m-para").textContent =
    misses.length + " of " + rows.length + " presses over 10 s" +
    (misses.length ? " (misses: " + misses.map((r) => r.id + " " + r.family + " " + r.words + "w " + r.ms + "ms").join("; ") + ")" : "");

  clearInterval(heapTimer);
  sampleHeap();
  results.storageAfterRun = await storageState();
  // performance.memory does not see WASM memory;
  // the heap figure is a lower bound only.
  results.peakHeapBytes = performance.memory ? peakHeap : null;
  results.peakHeapNote = "JS heap only; WASM memory is not counted, so this is a lower bound";
  $("m-mem").textContent = performance.memory ? peakHeap + " bytes (JS heap only, a lower bound: WASM memory is not counted)" : "performance.memory unavailable in this browser";
  $("copy").disabled = false;
  log("done");
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(results, null, 1));
  log("results copied");
});
