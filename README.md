# J-UNIWARD Steganography Lab

> An interactive research lab that teaches *why adaptive steganography works.*

## What It Is

Browser-native implementation of **J-UNIWARD** (JPEG Universal Wavelet Relative Distortion) — the academic reference for adaptive JPEG steganography. Implements the full pipeline from the 2013 Holub & Fridrich paper:

- **Cost function:** Daubechies-8 three-level wavelet decomposition assigns a distortion cost to each DCT coefficient — changes in textured regions are "cheaper."
- **Embedding:** Full Syndrome-Trellis Code (STC, h=12, 4096 states) finds the minimum-distortion modification via Viterbi search (Filler, Judas & Fridrich 2011).
- **Key schedule:** PBKDF2-SHA-256 (600k iterations) → HKDF domain separation → AES-CTR hat matrix + Fisher-Yates permutation. HMAC-SHA-256 integrity tag.
- **Steganalysis:** Three-way comparison (LSB vs F5 vs J-UNIWARD) with chi-square PoV attack and DCT histogram visualization.

Everything runs locally in your browser. No backends, no simulated math.

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
| Live steganalysis | Chi-square p-value bars, DCT histograms, detectability labels |
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

## Limitations

- **Simplified analysis.** The included chi-square test is a first-order statistical attack. Real-world steganalysis (SRNet, XuNet, etc.) uses deep learning on rich feature sets.
- **COM marker sideband.** Salt and embedding rate are stored in a JPEG COM marker for extraction. This metadata may be stripped by image pipelines or social media compression.
- **Not "undetectable."** J-UNIWARD is *more resistant* than LSB/F5 under the included analysis — not invisible to all attacks.
- **Educational tool.** This is a teaching and portfolio demo, not suitable for adversarial environments.

## Run Locally

```bash
git clone https://github.com/systemslibrarian/crypto-lab-j-uniward
cd crypto-lab-j-uniward
npm install
npm run dev
```

## Live Demo

https://systemslibrarian.github.io/crypto-lab-j-uniward/

## Part of the Crypto-Lab Suite

One of 60+ live browser demos at [systemslibrarian.github.io/crypto-lab](https://systemslibrarian.github.io/crypto-lab/) — spanning Atbash (600 BCE) through NIST FIPS 203/204/205 (2024).

---

*"Whether you eat or drink, or whatever you do, do all to the glory of God." — 1 Corinthians 10:31*
