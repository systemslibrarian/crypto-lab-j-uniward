# crypto-lab-j-uniward

## What It Is

*An interactive research lab that teaches why adaptive steganography works.*

Browser-native implementation of **J-UNIWARD** (JPEG Universal Wavelet Relative Distortion) — a foundational and widely used benchmark for adaptive JPEG steganography. Implements the pipeline from Holub, Fridrich & Denemark, *Universal distortion function for steganography in an arbitrary domain* (EURASIP Journal on Information Security 2014:1; conference version ACM IH&MMSec 2013):

- **Cost function:** the published UNIWARD distortion, as defined. The cost of changing a DCT coefficient is the sum of *relative* changes of every wavelet coefficient in the **three first-level undecimated** directional subbands (LH, HL, HH) — built from the Daubechies-8 (`db8`, 16-tap) low-pass/high-pass pair as the outer products K⁽¹⁾ = h·gᵀ, K⁽²⁾ = g·hᵀ, K⁽³⁾ = g·gᵀ — with the stabilizing constant **σ = 2⁻⁶** the paper selects for J-UNIWARD. Nothing is decimated and there is no second or third decomposition level. It is evaluated in closed form: because the undecimated transform is shift-invariant and both the filter bank and the DCT basis are outer products, the ripple factorises along each axis. So it runs in well under a second *and* is the literal definition rather than an approximation of it — the test suite pins it against a brute-force implementation that perturbs actual pixels and re-runs the transform, and the two agree to ~1e-12 relative, at the image boundary as well as inside.
- **Embedding:** Syndrome coding with a 12-bit constraint height (4096 states), solved exactly by Viterbi search (Filler, Judas & Fridrich 2011). The payload is spread across the whole image by a keyed permutation over the full AC coefficient pool. **The search is optimal within each 12-bit syndrome block over its own window of carriers, not across the whole image**: the trellis restarts every 12 message bits rather than running one shifted parity-check matrix along the full carrier stream, so this is block-optimal syndrome embedding rather than the long shifted-submatrix STC construction of the paper. That restart is also why the placement comparison below does not always come out in J-UNIWARD's favour.
- **Key schedule:** PBKDF2-SHA-256 (600k iterations) → HKDF domain separation → AES-CTR hat matrix + Fisher-Yates permutation. HMAC-SHA-256 integrity tag; a real embed→download→upload→extract round-trip recovers the message and verifies the tag.
- **Steganalysis:** Three-way comparison (LSB vs F5 vs J-UNIWARD) at the same payload, with each method's *actually carried* bit count reported — F5 exhausts the non-zero ACs on smooth covers and its comparison is then marked invalid rather than ranked. LSB's spatial edits are re-projected into the quantized DCT domain via a real forward DCT, then every method's changes are ranked against the cost map by *where they land* — the distortion that actually predicts detectability — plus a DCT histogram view (with the cover distribution overlaid so the F5 shrinkage tell is visible).

Everything runs locally in your browser. No backends and no simulated math: the cost map, the coefficient edits, the JPEG round trip and the extraction are all computed. The comparison ratings and the STC schematic are teaching models.

**The comparison is not rigged in J-UNIWARD's favour, and it does not always favour it.** Measured with this repo's own engine across the three bundled covers and six rates, F5's *per-change* mean exposure is lower than J-UNIWARD's in 13 of 15 comparable (cover, rate) states — including the shipped 0.10 bpnzac default on `sample-grass.jpg` (J-UNIWARD 7.1%, F5 4.5%). The reason is structural and worth teaching: F5 only ever edits non-zero AC coefficients, and those are already the cheap textured ones, while J-UNIWARD's carrier pool is *every* AC coefficient, zeros included, so each 12-bit syndrome block sometimes has to spend on a flatter coefficient. J-UNIWARD makes far fewer changes and leaves no shrinkage tell; on summed distortion — the objective it actually minimises — it wins at 0.10 bpnzac on both textured covers (grass 6.6e4 against F5's 1.0e5; portrait 5.9e4 against 1.7e5) and loses at 0.40. The panel prints the ordering it measured for your run instead of asserting one.

### Teaching scaffolding (progressive disclosure)

Built for both a newcomer meeting adaptive steganography for the first time and a cryptographer after the subtle details:

1. **Plain-English glossary layer** — load-bearing jargon (`bpnzac`, `DCT`, `wavelet`, `AC`/`DC`, `STC`/`Viterbi`, `shrinkage`) is gated behind a one-line hover/focus gloss wherever it first appears, so the raw acronym never lands cold.
2. **"Inside the cost" block probe** — click any 8×8 block on the cover image to nudge it by a +1 DCT step and watch the ripple hit the three undecimated wavelet detail subbands, with the *cover-magnitude denominator* shown next to each — so you *see* why busy texture yields low normalized cost. Computed live from the same Daubechies-8 transform the embedder uses; no faked numbers.
3. **F5 shrinkage annotation** — the DCT histogram overlays the cover distribution and rings/arrows the suppressed ±1 buckets, pointing directly at the tell the demo names.
4. **STC / Viterbi schematic** — a stepped walkthrough of the keyed permutation spreading the payload, then the trellis choosing the cheapest minimum-distortion flip-set for each 12-bit block of the message.
5. **Placement-proxy framing** — the change-exposure bars are labelled *placement proxy — not a detector* at the point of use, each paired with a one-line "what a real detector would see" note, so a low bar is never misread as "provably safe."

## When to Use It

- Teaching *why* adaptive steganography resists detection better than naive LSB or F5 embedding.
- Walking through the J-UNIWARD pipeline end to end — wavelet cost map, STC embedding, keyed spreading, and round-trip extraction.
- Comparing steganographic methods at equal payload to see *where* each one's changes land relative to image texture.
- Do NOT use it to hide data in adversarial settings — it is a teaching and portfolio demo, not an undetectable channel.

## Live Demo

**[systemslibrarian.github.io/crypto-lab-j-uniward](https://systemslibrarian.github.io/crypto-lab-j-uniward/)**

Load a sample image or your own JPEG, enter a secret message and shared key, and embed with J-UNIWARD while a live panel compares LSB, F5, and J-UNIWARD at the same payload — showing where each method's changes land on the wavelet cost terrain, change-exposure bars, DCT histograms, and detectability labels. A 10× amplified difference map visualizes the edits, a carrier-density readout shows how much of the AC pool is non-zero, and a full embed → download → upload → extract round-trip recovers the message and checks its integrity tag.

## What Can Go Wrong

- **Placement is a proxy, not a detector.** The analysis measures *where* changes land relative to texture — the quantity J-UNIWARD minimizes — which predicts resistance better than any single first-order test. It is not itself a steganalyzer; real-world detection (SRM, SRNet, XuNet) uses deep learning on rich feature sets.
- **Higher payloads spend costlier coefficients.** As the rate rises the cheap textured coefficients run out, so the average change lands in a costlier spot — measured on `sample-grass.jpg`, J-UNIWARD's mean exposure climbs 7.1% → 11.7% → 17.0% → 21.8% → 27.7% from 0.10 to 0.50 bpnzac, and its worst single placement reaches the 96th percentile at 0.50. There is no universally safe payload; the panel shows the climb for your cover rather than naming a threshold.
- **COM marker sideband.** Salt, rate, and payload length are stored in a JPEG COM marker for extraction. This metadata may be stripped by image pipelines or social media compression — and it makes any file this demo produces trivially identifiable by a metadata scanner, without touching a single DCT coefficient. It exists so the browser round trip is reproducible, not because it is covert.
- **Not "undetectable," and not automatically the winner here.** Placement is what this lab measures, and on that measure F5's per-change average often beats J-UNIWARD's (see above). Real statistical security is established with trained detectors over image corpora, not by grading an algorithm against its own objective.
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
| Live steganalysis | Change-exposure bars (labelled *placement proxy — not a detector*), the measured ordering for the run, per-method carried-bit accounting, "where changes landed" map over the cost terrain, DCT histograms, detectability labels |
| Cost-mechanism probe | Click any block to see the ±1 wavelet ripple across the three directional subbands and the cover-magnitude denominator that makes texture cheap |
| Jargon glossary | Hover/focus one-line plain-English glosses for bpnzac, DCT, wavelet, AC/DC, STC/Viterbi, shrinkage |
| STC/Viterbi schematic | Stepped walkthrough of keyed spreading → candidate flip-sets → minimum-distortion choice |
| F5 shrinkage callout | Cover histogram overlaid with the ±1 shrinkage buckets ringed and arrowed |
| Method explanations | Teaching text explains *why* each method is more or less detectable, with a "what a real detector would see" note |
| Carrier density | Non-zero AC count and share of the AC pool — the bpnzac denominator, printed with the badge it drove |
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
│   ├── glossary.ts      # Plain-English jargon on-ramp (hover/focus glosses)
│   ├── mechanism-panel.ts # "Inside the cost" per-block wavelet probe
│   ├── stc-walkthrough.ts # STC / Viterbi stepped schematic
│   └── renderers.ts     # Canvas drawing + alerts
├── codec/
│   └── JpegCodec.ts     # Custom JPEG DCT codec
├── steg/
│   ├── Embedder.ts      # J-UNIWARD embed
│   ├── Extractor.ts     # STC extract
│   └── WaveletCost.ts   # J-UNIWARD (UNIWARD) wavelet cost function
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

*Part of the [Crypto Lab](https://crypto-lab.systemslibrarian.dev/) suite.*

*"So whether you eat or drink or whatever you do, do it all for the glory of God." — 1 Corinthians 10:31*
