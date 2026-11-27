// edu1 bench worker: generation runs HERE, in a
// Web Worker, never on the page's main thread
// (Hark's condition, 2026-11-27: on the main thread
// the interface would freeze during a press and the
// measured time would not be the time the user
// lives). The page sends one paragraph per message
// and times the round trip; the worker also reports
// its own generation time.
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/+esm";
import { AutoTokenizer, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm";
import { createBeamGenerator } from "./beam-search.js";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "./";
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";

let gen = null;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    const t0 = performance.now();
    const tokenizer = await AutoTokenizer.from_pretrained("model-ext");
    gen = await createBeamGenerator({
      ort,
      encoderPath: "./model-ext/onnx/encoder_model.onnx",
      decoderPath: "./model-ext/onnx/decoder_model_merged.onnx",
      tokenizer,
    });
    self.postMessage({ type: "ready", ms: Math.round(performance.now() - t0) });
  } else if (msg.type === "generate") {
    const t0 = performance.now();
    const candidates = await gen.generate5(msg.text);
    self.postMessage({ type: "candidates", id: msg.id, candidates, workerMs: Math.round(performance.now() - t0) });
  }
};
