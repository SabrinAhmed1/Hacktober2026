# ⚔️ Pocket Arena

**Blind battles between open-weight LLMs, running 100% in your browser.**

Pocket Arena is a pocket-sized, fully local take on the "chatbot arena" idea. Two open models (Qwen, Llama, Gemma, SmolLM, OLMo, Phi, and others) answer the same prompt side by side. In blind mode you don't know which model is which until you vote. Each vote updates an Elo leaderboard.

All inference happens on **your own GPU via WebGPU**. There is no backend and no API key, and your prompts never leave your machine.

## Why

Hosted leaderboards tell you which *big* models win on *their* hardware. Pocket Arena answers a different question: **which small open model is best for my prompts, on my laptop, right now?**

- 🔒 **Private**: prompts and votes stay in your browser
- 🙈 **Blind**: sides are shuffled and names hidden to cut down on brand bias
- ⚡ **Measured**: decode speed (tok/s) is recorded per model on your hardware
- 🤝 **Poolable**: export your votes as JSON and import a friend's file. Ratings are recomputed by replaying the combined vote log, so merging is lossless
- 📦 **Zero build**: static HTML, CSS, and JS, deployable on GitHub Pages as-is

## Run it

You need a browser with WebGPU: recent Chrome or Edge, or Safari 26+. On Linux Chrome, you may need `chrome://flags/#enable-unsafe-webgpu`.

Module workers need an `http://` origin, so serve the folder rather than opening the file directly:

```bash
python3 -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>.

The first battle downloads both models' weights (~0.3–2.5 GB each). After that they're cached by the browser and load in seconds.

### Deploy to GitHub Pages

Push the repo, then go to **Settings → Pages → Deploy from branch → `main` / root**.

## How it works

```
index.html ── app.js ──┬── worker.js (slot 0) ── WebLLM engine ── WebGPU
                       └── worker.js (slot 1) ── WebLLM engine ── WebGPU
```

- [WebLLM](https://github.com/mlc-ai/web-llm) compiles quantized open-weight models (MLC format, 4-bit) to WebGPU kernels.
- Each contender gets its own Web Worker and engine, so both stream **concurrently** without freezing the UI. Models stay loaded between rounds, and a rematch skips the reload.
- The model list is built from WebLLM's prebuilt catalogue and filtered to chat models that need ≤ 4.5 GB VRAM. If your GPU has no `shader-f16` support, it switches to `q4f32` builds automatically.
- **🎲 Random** draws from a curated pool of small chat models.
- Reasoning models' `<think>` blocks are hidden so answers are compared like for like.
- Ratings use standard Elo (K=32, start 1000). "Both bad" counts as a draw with no rating change.

## Ideas / roadmap

- Multi-turn battles
- Category tags (code, math, creative) with per-category leaderboards
- Optional opt-in public vote pool (e.g. a GitHub Gist or Hugging Face dataset)
- Judge mode: a third local model scores the pair

## License

MIT. Model weights are under their own licenses (Llama, Gemma, Qwen, and others). Check each model card.
