# J-UNIWARD — Browser-Native JPEG Steganography

## What It Is

Browser-native implementation of J-UNIWARD (JPEG Universal Wavelet Relative Distortion) — the academic gold standard for adaptive JPEG steganography. Implements the full pipeline from the 2013 Holub & Fridrich paper: Daubechies-8 three-level wavelet decomposition, per-coefficient distortion cost assignment, and Syndrome-Trellis Code (STC) payload embedding via Viterbi-optimal search (Filler, Judas & Fridrich 2011). Includes a three-way steganalysis comparison against LSB and F5 to demonstrate exactly why adaptive methods resist detection. No backends. No simulated math.

> **Algorithm note:** Embedding uses full Syndrome-Trellis Codes with constraint height h=10 (1024 trellis states). The Viterbi algorithm finds the minimum-distortion change vector, achieving near-optimal embedding efficiency (~1 bit per carrier). The parity-check matrix is constructed by tiling a key-derived random h×(h+1) submatrix along the diagonal, following the Filler-Judas-Fridrich framework.

## When to Use It

- **Hiding a payload in a JPEG at low embedding rates (< 0.3 bpnzac):** J-UNIWARD places changes in high-texture DCT regions where steganalysis cannot distinguish them from compression artifacts — use it when detection resistance matters
- **Academic benchmarking:** J-UNIWARD is the reference all new JPEG steg schemes are measured against in published research
- **Understanding why naive methods fail:** The steganalysis comparison panel shows chi-square and DCT histogram attacks detecting LSB and F5 while J-UNIWARD holds
- **Do NOT use when:** You need to re-compress the output JPEG — any change in quality setting destroys the embedded payload. Use PNG-based schemes if re-compression is a risk.
- **Do NOT use when:** Payload exceeds 0.4 bpnzac — detectability rises sharply even for J-UNIWARD at high embedding rates

## Live Demo

https://systemslibrarian.github.io/crypto-lab-j-uniward/

Upload a JPEG, type a secret message, set an embedding rate (0.1–0.4 bpnzac), and embed. Download the stego JPEG. Re-upload and extract to recover the message. The steganalysis panel shows where bits were placed and compares J-UNIWARD's change distribution against LSB and F5 at the same payload size.

## How to Run Locally

```bash
git clone https://github.com/systemslibrarian/crypto-lab-j-uniward
cd crypto-lab-j-uniward
npm install
npm run dev
```

No environment variables required.

## Part of the Crypto-Lab Suite

One of 60+ live browser demos at [systemslibrarian.github.io/crypto-lab](https://systemslibrarian.github.io/crypto-lab/) — spanning Atbash (600 BCE) through NIST FIPS 203/204/205 (2024).

---

*"Whether you eat or drink, or whatever you do, do all to the glory of God." — 1 Corinthians 10:31*
