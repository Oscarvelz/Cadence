// Page-side beam search for edu1 (int8 T5) over the
// raw ONNX sessions, replicating the bench decoding
// of the parity gate (HF generate: num_beams 10,
// num_return_sequences 5, repetition_penalty 2.0,
// no_repeat_ngram_size 2, max_length 320,
// length_penalty 1.0, early_stopping false).
// Written against an injected ORT (onnxruntime-node
// here, onnxruntime-web in the page) so the same
// code verifies in node and ships in the bench page.

const NUM_BEAMS = 10;
const NUM_RETURN = 5;
const REP_PENALTY = 2.0;
const NGRAM = 2;
const MAX_LEN = 320;
const LEN_PENALTY = 1.0;
const EOS = 1;
const START = 0;
const LAYERS = 12;

function logSoftmaxRow(logits, offset, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (logits[offset + i] > max) max = logits[offset + i];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.exp(logits[offset + i] - max);
  const lse = max + Math.log(sum);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = logits[offset + i] - lse;
  return out;
}

function applyProcessors(logits, tokens) {
  // repetition penalty over the tokens generated so
  // far (the start token included, as in HF)
  const seen = new Set(tokens);
  for (const t of seen) {
    if (t < 0 || t >= logits.length) continue;
    logits[t] = logits[t] < 0 ? logits[t] * REP_PENALTY : logits[t] / REP_PENALTY;
  }
  // no-repeat-ngram: ban any token that would repeat
  // a bigram already in the sequence
  if (tokens.length >= NGRAM) {
    const last = tokens[tokens.length - 1];
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i] === last) logits[tokens[i + 1]] = -Infinity;
    }
  }
}

function tileRows(tensor, rows, ort) {
  // tensor: [1, ...rest]; return [rows, ...rest] with
  // the single row repeated
  const { dims, data } = tensor;
  const rowSize = data.length / dims[0];
  const out = new Float32Array(rowSize * rows);
  for (let r = 0; r < rows; r++) out.set(data.subarray(0, rowSize), r * rowSize);
  return new ort.Tensor("float32", out, [rows, ...dims.slice(1)]);
}

function gatherRows(tensor, indices, ort) {
  const { dims, data, type } = tensor;
  const rowSize = data.length / dims[0];
  const Ctor = type === "int64" ? BigInt64Array : Float32Array;
  const out = new Ctor(rowSize * indices.length);
  indices.forEach((src, r) => out.set(data.subarray(src * rowSize, (src + 1) * rowSize), r * rowSize));
  return new ort.Tensor(type, out, [indices.length, ...dims.slice(1)]);
}

export async function createBeamGenerator({ ort, encoderPath, decoderPath, tokenizer, merged = true }) {
  const env_ = typeof process !== "undefined" ? process.env : {};
  const sessOpts = env_.ORT_OPT ? { graphOptimizationLevel: env_.ORT_OPT } : undefined;
  const encoder = await ort.InferenceSession.create(encoderPath, sessOpts);
  const decoder = await ort.InferenceSession.create(decoderPath, sessOpts);

  async function generate5(text) {
    const enc = tokenizer(text);
    const inputIds = Array.from(enc.input_ids.data ?? enc.input_ids);
    const attn = Array.from(enc.attention_mask.data ?? enc.attention_mask);
    const encLen = inputIds.length;
    const encOut = await encoder.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, encLen]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(attn.map(BigInt)), [1, encLen]),
    });
    const hidden1 = encOut.last_hidden_state; // [1, encLen, 768]
    const vocab = 32128;

    // ---- step 1: a single beam (all beams identical)
    let beams = [{ tokens: [START], sum: 0, past: null }];
    let pastBatched = null; // 48 tensors with batch = beams.length
    let hypotheses = []; // {tokens, score}

    const emptyPast = (batch) => {
      const feeds = {};
      for (let l = 0; l < LAYERS; l++) {
        feeds[`past_key_values.${l}.decoder.key`] = new ort.Tensor("float32", new Float32Array(0), [batch, 12, 0, 64]);
        feeds[`past_key_values.${l}.decoder.value`] = new ort.Tensor("float32", new Float32Array(0), [batch, 12, 0, 64]);
        feeds[`past_key_values.${l}.encoder.key`] = new ort.Tensor("float32", new Float32Array(batch * 12 * encLen * 64), [batch, 12, encLen, 64]);
        feeds[`past_key_values.${l}.encoder.value`] = new ort.Tensor("float32", new Float32Array(batch * 12 * encLen * 64), [batch, 12, encLen, 64]);
      }
      return feeds;
    };

    let step = 0;
    while (true) {
      step++;
      const batch = beams.length;
      const hidden = batch === 1 ? hidden1 : tileRows(hidden1, batch, ort);
      const maskT = new ort.Tensor("int64", BigInt64Array.from({ length: batch * encLen }, (_, i) => BigInt(attn[i % encLen])), [batch, encLen]);
      const lastTokens = beams.map((b) => BigInt(b.tokens[b.tokens.length - 1]));
      const feeds = {
        encoder_attention_mask: maskT,
        input_ids: new ort.Tensor("int64", BigInt64Array.from(lastTokens), [batch, 1]),
        encoder_hidden_states: hidden,
        ...(merged ? { use_cache_branch: new ort.Tensor("bool", new Uint8Array([step > 1 ? 1 : 0]), [1]) } : {}),
        ...(step === 1 ? emptyPast(batch) : pastBatched),
      };
      const out = await decoder.run(feeds);
      if (env_.BEAM_DEBUG) {
        for (const k of ["present.0.decoder.key", "present.0.encoder.key", "present.11.decoder.value"]) {
          console.log("step", step, k, "dims", out[k].dims, "data", out[k].data.length);
        }
      }
      const logits = out.logits.data; // [batch, 1, vocab]
      const present = {};
      for (let l = 0; l < LAYERS; l++) {
        for (const part of ["decoder.key", "decoder.value", "encoder.key", "encoder.value"]) {
          const key = `past_key_values.${l}.${part}`;
          const t = out[`present.${l}.${part}`];
          // with use_cache_branch on, the merged graph
          // returns the encoder pasts empty, and the
          // with-past graph does not return them at
          // all: the caller keeps the ones it fed
          // (measured in node, 2026-11-27)
          present[key] = t && t.data.length ? t : feeds[key];
        }
      }

      // candidates: (beam, token, totalScore)
      const cands = [];
      for (let b = 0; b < batch; b++) {
        const row = new Float32Array(vocab);
        for (let v = 0; v < vocab; v++) row[v] = logits[b * vocab + v];
        applyProcessors(row, beams[b].tokens);
        const lp = logSoftmaxRow(row, 0, vocab);
        // only the top 2*NUM_BEAMS per beam can matter:
        // one scan with a bounded insertion list, no
        // full-vocab sort
        const keep = 2 * NUM_BEAMS;
        const topIdx = [];
        for (let v = 0; v < vocab; v++) {
          if (topIdx.length < keep) { topIdx.push(v); if (topIdx.length === keep) topIdx.sort((a, z) => lp[z] - lp[a]); continue; }
          if (lp[v] <= lp[topIdx[keep - 1]]) continue;
          let j = keep - 1;
          while (j > 0 && lp[topIdx[j - 1]] < lp[v]) { topIdx[j] = topIdx[j - 1]; j--; }
          topIdx[j] = v;
        }
        for (const v of topIdx) cands.push({ beam: b, token: v, score: beams[b].sum + lp[v], lp: lp[v] });
      }
      cands.sort((a, z) => z.score - a.score);
      // HF takes the top 2*num_beams of the whole batch;
      // at step 1 the single beam expands the same way.
      const top = cands.slice(0, 2 * NUM_BEAMS);

      // HF 4.57 BeamSearchScorer.process, exactly:
      // iterate the step's top 2*num_beams window in
      // order; an EOS candidate is added as a
      // hypothesis only if its rank in the window is
      // below num_beams, scored by generated length
      // EXCLUDING the start token and the EOS itself
      // (generated_len = cur_len - decoder_prompt_len);
      // non-EOS candidates fill the next beams, and
      // once they are full the rest of the window is
      // not read at all.
      const nextBeams = [];
      const nextSrc = [];
      top.forEach((c, rank) => {
        if (nextBeams.length >= NUM_BEAMS) return;
        if (c.token === EOS) {
          if (rank >= NUM_BEAMS) return;
          const genLen = beams[c.beam].tokens.length - 1;
          const score = c.score / Math.pow(genLen, LEN_PENALTY);
          // the pool keeps at most num_beams, evicting
          // its worst when a better one arrives
          const worst = hypotheses.length ? Math.min(...hypotheses.map((h) => h.score)) : -Infinity;
          if (hypotheses.length < NUM_BEAMS || score > worst) {
            hypotheses.push({ tokens: [...beams[c.beam].tokens, EOS], score });
            if (hypotheses.length > NUM_BEAMS) {
              let wi = 0;
              hypotheses.forEach((h, i) => { if (h.score < hypotheses[wi].score) wi = i; });
              hypotheses.splice(wi, 1);
            }
          }
        } else {
          nextBeams.push({ tokens: [...beams[c.beam].tokens, c.token], sum: c.score, past: null });
          nextSrc.push(c.beam);
        }
      });

      const genLenNow = nextBeams.length ? nextBeams[0].tokens.length - 1 : MAX_LEN;
      // HF is_done with early_stopping False: only
      // once the pool is FULL (num_beams hypotheses),
      // stop when the pool's worst score cannot be
      // beaten by the best live beam even at the
      // current length.
      let doneByHeuristic = false;
      if (hypotheses.length >= NUM_BEAMS && nextBeams.length) {
        const bestSum = Math.max(...nextBeams.map((b) => b.sum));
        const worstHyp = Math.min(...hypotheses.map((h) => h.score));
        const curLen = nextBeams[0].tokens.length;
        doneByHeuristic = worstHyp >= bestSum / Math.pow(curLen - 1, LEN_PENALTY);
      }
      pastBatched = {};
      for (const k of Object.keys(present)) pastBatched[k] = gatherRows(present[k], nextSrc.length ? nextSrc : [0], ort);
      beams = nextBeams;
      if (!beams.length || doneByHeuristic || genLenNow >= MAX_LEN) {
        // finalize: any live beam becomes a hypothesis
        for (const b of beams) {
          hypotheses.push({ tokens: b.tokens, score: b.sum / Math.pow(b.tokens.length - 1, LEN_PENALTY) });
        }
        break;
      }
    }
    hypotheses.sort((a, z) => z.score - a.score);
    const top5 = hypotheses.slice(0, NUM_RETURN);
    if (env_.BEAM_DEBUG) {
      for (const h of top5) console.log("hyp score", h.score.toFixed(6), "len", h.tokens.length - 1, tokenizer.decode(h.tokens, { skip_special_tokens: true }));
    }
    return top5.map((h) => tokenizer.decode(h.tokens, { skip_special_tokens: true }));
  }

  return { generate5 };
}
