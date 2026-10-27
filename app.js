import * as webllm from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm";

const STORE_KEY = "pocket-arena:battles:v1";
const BASE_ELO = 1000;
const K = 32;
const MAX_VRAM_MB = 4500;
const RANDOM = "__random__";

// Small, chat-tuned open-weight models that run well on laptops. Used for random matchups.
const ARENA_POOL = [
  "Qwen3.5-0.8B", "Qwen2.5-0.5B-Instruct", "Qwen2.5-1.5B-Instruct", "Qwen3-1.7B",
  "Llama-3.2-1B-Instruct", "Llama-3.2-3B-Instruct", "gemma3-1b-it", "gemma-2-2b-it",
  "SmolLM2-360M-Instruct", "SmolLM2-1.7B-Instruct", "OLMo-2-0425-1B-Instruct",
  "Phi-3.5-mini-instruct",
];

const PRESETS = [
  ["🧠 Explain", "Explain how a rainbow forms to a 10-year-old in 4 sentences."],
  ["🍎 Math", "I have 3 apples, eat 2, then buy a dozen more and give away half. How many do I have? Show your reasoning."],
  ["🪶 Trick", "Which is heavier: a kilogram of feathers or a kilogram of steel?"],
  ["🐍 Code", "Write a short Python function that checks whether a string is a palindrome, ignoring case and punctuation."],
  ["✍️ Haiku", "Write a haiku about open-source software."],
  ["☕ Ideas", "Give me 3 creative names for a coffee shop run entirely by cats, with a one-line pitch each."],
];

const $ = (sel) => document.querySelector(sel);
const sides = {
  a: panel("#side-a"),
  b: panel("#side-b"),
};

function panel(sel) {
  const root = $(sel);
  return {
    root,
    name: root.querySelector(".name"),
    stats: root.querySelector(".stats"),
    progress: root.querySelector(".progress"),
    bar: root.querySelector(".bar"),
    ptext: root.querySelector(".ptext"),
    output: root.querySelector(".output"),
  };
}

// ---------- Model catalogue ----------

let quantSuffix = "-q4f16_1-MLC";
let models = []; // [{ id, name, vram }]

const prettyName = (id) => id.replace(quantSuffix, "");

function buildCatalogue() {
  models = webllm.prebuiltAppConfig.model_list
    .filter((m) => m.model_id.endsWith(quantSuffix))
    .filter((m) => !m.model_type) // 0/undefined = LLM; skip embedding & vision models
    .filter((m) => !/vision|embed|Base|phi-1_5|phi-2-/i.test(m.model_id))
    .filter((m) => (m.vram_required_MB ?? Infinity) <= MAX_VRAM_MB)
    .map((m) => ({ id: m.model_id, name: prettyName(m.model_id), vram: m.vram_required_MB }))
    .sort((x, y) => x.vram - y.vram);
}

function arenaPool() {
  const pool = models.filter((m) => ARENA_POOL.includes(m.name));
  return pool.length >= 2 ? pool : models;
}

function fillPickers() {
  for (const sel of [$("#pick-1"), $("#pick-2")]) {
    sel.innerHTML = "";
    sel.add(new Option("🎲 Random contender", RANDOM));
    for (const m of models) {
      sel.add(new Option(`${m.name}  (~${(m.vram / 1024).toFixed(1)} GB)`, m.id));
    }
  }
}

function pickRandom(exclude) {
  const pool = arenaPool().filter((m) => m.id !== exclude);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

// ---------- Engines (one web worker per slot) ----------

const slots = [
  { engine: null, model: null, onProgress: null },
  { engine: null, model: null, onProgress: null },
];

async function ensureLoaded(slot, modelId) {
  if (slot.model === modelId) return slot.engine;
  const initProgressCallback = (r) => slot.onProgress?.(r);
  if (!slot.engine) {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    slot.engine = await webllm.CreateWebWorkerMLCEngine(worker, modelId, { initProgressCallback });
  } else {
    await slot.engine.reload(modelId);
  }
  slot.model = modelId;
  return slot.engine;
}

// Put each model on the slot that already has it loaded, to avoid re-downloading/reloading.
function assignSlots(m1, m2) {
  const keep = slots[0].model === m1 || slots[1].model === m2;
  const swap = slots[0].model === m2 || slots[1].model === m1;
  return swap && !keep ? [[m1, slots[1]], [m2, slots[0]]] : [[m1, slots[0]], [m2, slots[1]]];
}

// ---------- Battle ----------

let round = null; // { prompt, a: {model, result}, b: {model, result}, voted }
let running = false;

function cleanOutput(text) {
  // Reasoning models (e.g. Qwen3) may emit <think> blocks; hide them from the comparison.
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (/<think>/.test(out)) out = out.replace(/<think>[\s\S]*$/, "💭 thinking…");
  return out.trim();
}

function setStatus(msg) {
  $("#status").textContent = msg;
}

function labelFor(side) {
  const blind = round?.blind && !round?.voted;
  return blind ? `Model ${side.toUpperCase()}` : prettyName(round[side].model);
}

function resetPanel(side) {
  const p = sides[side];
  p.name.textContent = labelFor(side);
  p.stats.textContent = "";
  p.output.textContent = "";
  p.root.classList.remove("winner", "loser");
  p.progress.hidden = true;
}

async function runSide(side, slot, prompt) {
  const p = sides[side];
  slot.onProgress = (r) => {
    p.progress.hidden = false;
    p.bar.style.width = `${Math.round((r.progress ?? 0) * 100)}%`;
    p.ptext.textContent = round.blind
      ? `Loading weights… ${Math.round((r.progress ?? 0) * 100)}%`
      : r.text;
  };
  p.output.innerHTML = '<span class="placeholder">Loading model…</span>';
  const engine = await ensureLoaded(slot, round[side].model);
  p.progress.hidden = true;
  p.output.innerHTML = '<span class="placeholder">Thinking…</span>';

  const t0 = performance.now();
  let raw = "";
  let tps = null;
  let tokens = 0;
  const stream = await engine.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    max_tokens: 768,
    extra_body: { enable_thinking: false },
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      raw += delta;
      p.output.textContent = cleanOutput(raw);
      p.output.scrollTop = p.output.scrollHeight;
    }
    if (chunk.usage) {
      tps = chunk.usage.extra?.decode_tokens_per_s ?? null;
      tokens = chunk.usage.completion_tokens;
    }
  }
  const secs = (performance.now() - t0) / 1000;
  if (!cleanOutput(raw)) p.output.innerHTML = '<span class="placeholder">(empty response)</span>';
  p.stats.textContent = `${tokens} tok · ${secs.toFixed(1)}s${tps ? ` · ${tps.toFixed(1)} tok/s` : ""}`;
  round[side].result = { text: cleanOutput(raw), tps };
}

async function battle() {
  if (running) return;
  const prompt = $("#prompt").value.trim();
  if (!prompt) return $("#prompt").focus();

  let m1 = $("#pick-1").value;
  let m2 = $("#pick-2").value;
  if (m1 !== RANDOM && m1 === m2) return setStatus("Pick two different models (or use 🎲 Random).");
  if (m1 === RANDOM) m1 = pickRandom(m2 === RANDOM ? null : m2);
  if (m2 === RANDOM) m2 = pickRandom(m1);

  const blind = $("#blind").checked;
  const [first, second] = assignSlots(m1, m2);
  const order = blind && Math.random() < 0.5 ? [second, first] : [first, second];
  round = {
    prompt,
    blind,
    voted: false,
    a: { model: order[0][0], slot: order[0][1] },
    b: { model: order[1][0], slot: order[1][1] },
  };

  setRunning(true);
  resetPanel("a");
  resetPanel("b");
  $("#vote").hidden = true;
  $("#reveal").hidden = true;
  setStatus("Battle in progress… (first run downloads model weights, which can take a few minutes)");

  const results = await Promise.allSettled([
    runSide("a", round.a.slot, prompt),
    runSide("b", round.b.slot, prompt),
  ]);
  setRunning(false);

  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    console.error(failed.reason);
    setStatus(`Something went wrong: ${failed.reason?.message ?? failed.reason}`);
    for (const s of ["a", "b"]) round[s].slot.model = null; // force a clean reload next time
    return;
  }
  setStatus("");
  $("#vote").hidden = false;
  for (const b of document.querySelectorAll("[data-vote]")) b.disabled = false;
}

function setRunning(on) {
  running = on;
  $("#send").disabled = on;
  $("#stop").hidden = !on;
  $("#pick-1").disabled = on;
  $("#pick-2").disabled = on;
  $("#blind").disabled = on;
}

function stop() {
  for (const s of slots) s.engine?.interruptGenerate();
}

function vote(winner) {
  if (!round || round.voted) return;
  const before = computeRatings(loadBattles());
  const battle = {
    id: crypto.randomUUID(),
    t: Date.now(),
    prompt: round.prompt,
    a: prettyName(round.a.model),
    b: prettyName(round.b.model),
    winner,
    tpsA: round.a.result?.tps ?? null,
    tpsB: round.b.result?.tps ?? null,
  };
  saveBattles([...loadBattles(), battle]);
  const after = computeRatings(loadBattles());
  round.voted = true;

  for (const b of document.querySelectorAll("[data-vote]")) b.disabled = true;
  for (const s of ["a", "b"]) {
    sides[s].name.textContent = labelFor(s);
    sides[s].root.classList.toggle("winner", winner === s);
    sides[s].root.classList.toggle("loser", (winner === "a" || winner === "b") && winner !== s);
  }

  const delta = (name) => {
    const old = Math.round(before[name]?.elo ?? BASE_ELO);
    const now = Math.round(after[name].elo);
    const d = now - old;
    return `${old} → ${now} (${d >= 0 ? "+" : ""}${d})`;
  };
  const reveal = $("#reveal");
  reveal.innerHTML = "";
  reveal.append(
    revealLine("A", battle.a, delta(battle.a)),
    revealLine("B", battle.b, delta(battle.b)),
  );
  reveal.hidden = false;
  renderBoard();
}

function revealLine(label, name, delta) {
  const div = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = name;
  div.append(`Model ${label} was `, strong, ` · Elo ${delta}`);
  return div;
}

// ---------- Ratings (recomputed by replaying the vote log) ----------

function loadBattles() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? [];
  } catch {
    return [];
  }
}

function saveBattles(battles) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(battles));
  } catch (e) {
    setStatus(`Could not save votes: ${e.message}`);
  }
}

function computeRatings(battles) {
  const r = {};
  const get = (name) => (r[name] ??= { name, elo: BASE_ELO, w: 0, l: 0, t: 0, games: 0, tpsSum: 0, tpsN: 0 });
  for (const b of [...battles].sort((x, y) => x.t - y.t)) {
    const A = get(b.a);
    const B = get(b.b);
    A.games++;
    B.games++;
    if (b.tpsA) { A.tpsSum += b.tpsA; A.tpsN++; }
    if (b.tpsB) { B.tpsSum += b.tpsB; B.tpsN++; }
    if (b.winner === "bad") { A.t++; B.t++; continue; } // counts as a draw, no rating change
    const sA = b.winner === "a" ? 1 : b.winner === "b" ? 0 : 0.5;
    const eA = 1 / (1 + 10 ** ((B.elo - A.elo) / 400));
    A.elo += K * (sA - eA);
    B.elo -= K * (sA - eA);
    if (sA === 1) { A.w++; B.l++; } else if (sA === 0) { A.l++; B.w++; } else { A.t++; B.t++; }
  }
  return r;
}

function renderBoard() {
  const battles = loadBattles();
  const rows = Object.values(computeRatings(battles)).sort((x, y) => y.elo - x.elo);
  const tbody = $("#board");
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted center">No votes yet. Run a battle!</td></tr>';
  }
  rows.forEach((m, i) => {
    const tr = document.createElement("tr");
    const decided = m.w + m.l;
    const cells = [
      i + 1,
      m.name,
      Math.round(m.elo),
      `${m.w} / ${m.l} / ${m.t}`,
      decided ? `${Math.round((m.w / decided) * 100)}%` : "–",
      m.tpsN ? (m.tpsSum / m.tpsN).toFixed(1) : "–",
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    tbody.append(tr);
  });
  $("#board-meta").textContent = battles.length
    ? `${battles.length} vote${battles.length === 1 ? "" : "s"} · Elo K=${K}, start ${BASE_ELO}`
    : "";
}

function exportVotes() {
  const blob = new Blob([JSON.stringify({ app: "pocket-arena", version: 1, battles: loadBattles() }, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pocket-arena-votes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importVotes(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.battles ?? []).filter(
      (b) => b && typeof b.a === "string" && typeof b.b === "string" && ["a", "b", "tie", "bad"].includes(b.winner),
    );
    const existing = loadBattles();
    const seen = new Set(existing.map((b) => b.id));
    const fresh = incoming
      .map((b) => ({ ...b, id: b.id ?? crypto.randomUUID(), t: Number(b.t) || Date.now() }))
      .filter((b) => !seen.has(b.id));
    saveBattles([...existing, ...fresh]);
    renderBoard();
    setStatus(`Imported ${fresh.length} new vote${fresh.length === 1 ? "" : "s"}.`);
  } catch (e) {
    setStatus(`Import failed: ${e.message}`);
  }
}

// ---------- Boot ----------

async function boot() {
  for (const [label, text] of PRESETS) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = label;
    chip.title = text;
    chip.onclick = () => { $("#prompt").value = text; $("#prompt").focus(); };
    $("#chips").append(chip);
  }

  $("#send").onclick = battle;
  $("#stop").onclick = stop;
  $("#prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) battle();
  });
  for (const b of document.querySelectorAll("[data-vote]")) b.onclick = () => vote(b.dataset.vote);
  $("#export").onclick = exportVotes;
  $("#import").onchange = (e) => e.target.files[0] && importVotes(e.target.files[0]);
  $("#reset").onclick = () => {
    if (confirm("Delete all votes stored in this browser?")) { saveBattles([]); renderBoard(); }
  };
  renderBoard();

  const warn = $("#gpu-warning");
  if (!navigator.gpu) {
    warn.textContent = "Your browser doesn't expose WebGPU. Try a recent Chrome, Edge, or Safari 26+ (on Linux Chrome, enable chrome://flags/#enable-unsafe-webgpu).";
    warn.hidden = false;
    $("#send").disabled = true;
  } else {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    if (!adapter) {
      warn.textContent = "WebGPU is present but no GPU adapter was found. Check that hardware acceleration is enabled.";
      warn.hidden = false;
      $("#send").disabled = true;
    } else if (!adapter.features.has("shader-f16")) {
      quantSuffix = "-q4f32_1-MLC"; // GPU lacks fp16 shaders; fall back to f32 builds
    }
  }

  buildCatalogue();
  fillPickers();
}

boot();
