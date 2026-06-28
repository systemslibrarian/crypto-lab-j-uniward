# crypto-lab-j-uniward

## What It Is

*An interactive research lab that teaches why adaptive steganography works.*

Browser-native implementation of **J-UNIWARD** (JPEG Universal Wavelet Relative Distortion) — the academic reference for adaptive JPEG steganography. Implements the full pipeline from the 2013 Holub & Fridrich paper:

- **Cost function:** Daubechies-8 three-level wavelet decomposition assigns a distortion cost to each DCT coefficient — changes in textured regions are "cheaper." Computed in well under a second via precomputed per-mode wavelet footprints (a ~1000× speedup over the literal definition, validated against it in the test suite).
- **Embedding:** Full Syndrome-Trellis Code (STC, h=12, 4096 states) finds the minimum-distortion modification via Viterbi search (Filler, Judas & Fridrich 2011). The payload is spread across the whole image by a keyed permutation over the full coefficient pool, so changes land in the globally cheapest — most textured — coefficients.
- **Key schedule:** PBKDF2-SHA-256 (600k iterations) → HKDF domain separation → AES-CTR hat matrix + Fisher-Yates permutation. HMAC-SHA-256 integrity tag; a real embed→download→upload→extract round-trip recovers the message and verifies the tag.
- **Steganalysis:** Honest three-way comparison (LSB vs F5 vs J-UNIWARD) at the same payload. LSB's spatial edits are re-projected into the quantized DCT domain via a real forward DCT, then every method's changes are ranked against the cost map by *where they land* — the distortion that actually predicts detectability — plus a DCT histogram view.

Everything runs locally in your browser. No backends, no simulated math, no rigged comparison: at the recommended payloads J-UNIWARD genuinely wins, and the panel shows it honestly.

## When to Use It

- Teaching *why* adaptive steganography resists detection better than naive LSB or F5 embedding.
- Walking through the J-UNIWARD pipeline end to end — wavelet cost map, STC embedding, keyed spreading, and round-trip extraction.
- Comparing steganographic methods at equal payload to see *where* each one's changes land relative to image texture.
- Do NOT use it to hide data in adversarial settings — it is a teaching and portfolio demo, not an undetectable channel.

## Live Demo

**[systemslibrarian.github.io/crypto-lab-j-uniward](https://systemslibrarian.github.io/crypto-lab-j-uniward/)**

Load a sample image or your own JPEG, enter a secret message and shared key, and embed with J-UNIWARD while a live panel compares LSB, F5, and J-UNIWARD at the same payload — showing where each method's changes land on the wavelet cost terrain, change-exposure bars, DCT histograms, and detectability labels. A 10× amplified difference map visualizes the edits, an image-suitability indicator flags poor carriers, and a full embed → download → upload → extract round-trip recovers the message and checks its integrity tag.

## What Can Go Wrong

- **Placement is a proxy, not a detector.** The analysis measures *where* changes land relative to texture — the quantity J-UNIWARD minimizes — which predicts resistance better than any single first-order test. It is not itself a steganalyzer; real-world detection (SRM, SRNet, XuNet) uses deep learning on rich feature sets.
- **High payloads expose everyone.** Above ~0.3 bpnzac even adaptive embedding runs out of textured coefficients, and F5's non-zero-AC bias can match J-UNIWARD's placement. The default/recommended rates (≤ 0.2) are where adaptive placement clearly wins.
- **COM marker sideband.** Salt, rate, and payload length are stored in a JPEG COM marker for extraction. This metadata may be stripped by image pipelines or social media compression.
- **Not "undetectable."** J-UNIWARD is *more resistant* than LSB/F5 — not invisible to all attacks.
- **Educational tool.** This is a teaching and portfolio demo, not suitable for adversarial environments.

## Real-World Usage

- J-UNIWARD is a standard academic benchmark for adaptive JPEG steganography, introduced by Holub & Fridrich (2013) and widely used to evaluate embedding and detection methods.
- Syndrome-Trellis Codes (STC), the minimal-distortion coding layer used here, are the reference embedding technique across modern steganography research.
- Modern steganalysis — rich-model features (SRM) and deep-learning detectors such as SRNet and XuNet — is developed and benchmarked against schemes like J-UNIWARD.
- The wavelet-distortion idea generalizes to the broader UNIWARD family (S-UNIWARD for spatial, SI-UNIWARD for side-informed embedding) used across image formats.

## How to Run Locally

```bash
git clone https://github.com/systemslibrarian/crypto-lab-j-uniward
cd crypto-lab-j-uniward
npm install
npm run dev
```

## Related Demos

- [crypto-lab-stego-suite](https://systemslibrarian.github.io/crypto-lab-stego-suite/) — LSB, DCT, and adaptive embedding with chi-squared steganalysis, the broader steganography toolkit.
- [crypto-lab-oram-vault](https://systemslibrarian.github.io/crypto-lab-oram-vault/) — Path ORAM hiding *access patterns*, a different flavor of information hiding.
- [crypto-lab-oblivious-shelf](https://systemslibrarian.github.io/crypto-lab-oblivious-shelf/) — private information retrieval that hides *which* item is read.
- [crypto-lab-patron-shield](https://systemslibrarian.github.io/crypto-lab-patron-shield/) — information-theoretic PIR over XOR secret sharing, another query-hiding scheme.

## Quick Start

Click **▶ Quick Demo** on the live site — it loads a sample image, prefills a message, and scrolls you straight to the embed step. Or follow the guided workflow:

1. **Load** a sample image or upload your own JPEG
2. **Enter** a secret message and shared key
3. **Embed** with J-UNIWARD and watch the analysis panel compare three methods

## Key Features

| Feature | Description |
|---------|-------------|
| Adaptive placement | Changes land in high-texture DCT blocks — harder to detect |
| Payload presets | Conservative (0.10), Balanced (0.20), Aggressive (0.40) bpnzac |
| Embedding summary | Payload size, actual rate, carriers used, distortion, metadata status |
| Visual comparison | Side-by-side cover/stego + 10× amplified difference map |
| Live steganalysis | Change-exposure bars, "where changes landed" map over the cost terrain, DCT histograms, detectability labels |
| Method explanations | Teaching text explains *why* each method is more or less detectable |
| Image suitability | Indicator shows whether your image is a good or poor carrier |
| Round-trip verification | Embed → download → upload → extract with integrity check |

## Architecture

```
src/
├── main.ts              # Thin orchestrator
├── state/
│   └── app-state.ts     # Central state
├── ui/
│   ├── theme.ts         # Dark/light toggle
│   ├── dropzone.ts      # Image upload + samples
│   ├── embed-panel.ts   # Embed tab + controls
│   ├── extract-panel.ts # Extract tab
│   ├── analysis-panel.ts# Steganalysis comparison
│   └── renderers.ts     # Canvas drawing + alerts
├── codec/
│   └── JpegCodec.ts     # Custom JPEG DCT codec
├── steg/
│   ├── Embedder.ts      # J-UNIWARD embed
│   ├── Extractor.ts     # STC extract
│   └── WaveletCost.ts   # Daubechies-8 cost function
├── analysis/
│   └── StegAnalysis.ts  # Chi-square, histograms, comparison
├── stc.ts               # STC Viterbi embed/extract
├── stc-keys.ts          # AES-CTR hat matrix + permutation
└── kdf.ts               # PBKDF2 + HKDF key derivation
```

## Testing

```bash
npm test         # core correctness suite (DCT roundtrip, embed↔extract, analysis)
npm run build    # typecheck + production build
```

`npm test` exercises the real pipeline end-to-end — decode → cost map → embed → JPEG encode → re-decode → extract — plus the forward/inverse DCT and the steganalysis ordering. Run `SLOW=1 npm test` to additionally validate the fast cost map against the reference implementation.

---

*One of 120+ browser demos in the [Crypto Lab](https://crypto-lab.systemslibrarian.dev/) suite.*

*"So whether you eat or drink or whatever you do, do it all for the glory of God." — 1 Corinthians 10:31*
