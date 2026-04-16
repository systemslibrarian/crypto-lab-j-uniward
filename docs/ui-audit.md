# UI Audit

Phase 0 findings for the presentation-layer enhancement pass.

- Cover image load path: `loadImage(file)` in `src/main.ts` validates JPEG input, stores original bytes in `origBuffer`, decodes into `decoded`, renders `decoded.pixels` into `cover-canvas`, and computes `costs` for later embedding.
- Embed output shape: `embed(...)` in `src/steg/Embedder.ts` returns `modifiedCoeffs` plus metadata (`carriersUsed`, `actualRate`, `changesCount`, `salt`, etc.). It does not return a JPEG byte array, and it does not expose the raw STC change vector `d`.
- Panel C data source: `runAnalysis(...)` in `src/analysis/StegAnalysis.ts`, invoked after a successful embed in `src/main.ts`, produces the current method statistics. The change-map canvas is rendered by diffing original vs modified coefficients via `renderChangesHeatmap(...)`.
- Load Sample button: currently wired to fetch a single sample JPEG from `assets/sample.jpg` and then forwards that blob into `loadImage(file)`.
- Panel widths in CSS: the layout uses responsive fractional columns in `src/style.css` (`1fr`, `1fr 1fr`, `1fr 1fr 1fr`). At the widest layout, `main` is capped at `1400px` with `1.25rem` padding on each side and `1rem` grid gaps, leaving about `1360px` of inner width and approximately `442.67px` per panel column.