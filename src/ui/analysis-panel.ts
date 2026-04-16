/**
 * analysis-panel.ts — Panel C: Three-way steganalysis comparison
 */

import { state } from '../state/app-state.ts';
import { renderHistogram } from './renderers.ts';
import type { MethodStats } from '../analysis/StegAnalysis.ts';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const analysisSlider   = document.getElementById('analysis-payload-slider') as HTMLInputElement;
const analysisDisplay  = document.getElementById('analysis-payload-display')!;
const methodTabs       = document.querySelectorAll<HTMLButtonElement>('.method-tab');
const statsContainer   = document.getElementById('stats-container')!;
const rateSlider       = document.getElementById('rate-slider') as HTMLInputElement;
const explainerPanel   = document.getElementById('analysis-explainer')!;

// ─── Analysis payload slider ─────────────────────────────────────────────────

analysisSlider.addEventListener('input', () => {
  const v = parseFloat(analysisSlider.value);
  analysisDisplay.textContent = v.toFixed(2) + ' bpnzac';
  rateSlider.value = String(v);
  rateSlider.dispatchEvent(new Event('input'));
});

// ─── Method tabs ─────────────────────────────────────────────────────────────

methodTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    methodTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-pressed', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-pressed', 'true');
    state.activeMethod = (tab.dataset['method'] as 'lsb' | 'f5' | 'juniward') ?? 'juniward';
    updateAnalysisPanel(state.activeMethod);
  });
});

// ─── Panel update ────────────────────────────────────────────────────────────

export function updateAnalysisPanel(method: 'lsb' | 'f5' | 'juniward'): void {
  if (!state.analysisResult) {
    explainerPanel.classList.remove('hidden');
    statsContainer.innerHTML = `
      <p class="text-muted">
        Load an image and embed a message to see live steganalysis results.
        The comparison shows why adaptive placement matters.
      </p>`;
    return;
  }

  // Hide the pre-embed explainer, show results
  explainerPanel.classList.add('hidden');

  const methods: { key: 'lsb' | 'f5' | 'juniward'; label: string }[] = [
    { key: 'lsb', label: 'LSB' },
    { key: 'f5', label: 'F5' },
    { key: 'juniward', label: 'J-UNIWARD' },
  ];

  // Chi-square p-value bars
  let html = `<div class="analysis-bars">
    <h3 class="section-label">Chi-square p-value
      <span class="tooltip-trigger" tabindex="0" aria-label="What is chi-square p-value?">ⓘ
        <span class="tooltip-content">The chi-square test detects non-random patterns in DCT coefficient histograms.
        A low p-value (near 0) means the image shows clear signs of tampering.
        A high p-value (near 1) means no statistically significant distortion was found.</span>
      </span>
    </h3>`;

  for (const m of methods) {
    const stats: MethodStats = state.analysisResult[m.key];
    const pVal = Number.isFinite(stats.pValue) ? stats.pValue : 0;
    const barWidth = Math.min(100, pVal * 200);
    let barColor: string;
    let label: string;
    if (pVal < 0.05) {
      barColor = 'var(--error-text)';
      label = 'Likely detectable';
    } else if (pVal < 0.20) {
      barColor = 'var(--warning-text)';
      label = 'Moderate risk';
    } else {
      barColor = 'var(--success-color)';
      label = 'More resistant';
    }
    const pDisplay = pVal < 0.001 ? '< 0.001' : pVal.toFixed(3);

    html += `<div class="bar-row">
      <span class="bar-label">${m.label}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width:${barWidth}%; background:${barColor};"></div>
      </div>
      <span class="bar-value" style="color:${barColor};">${pDisplay}</span>
      <span class="bar-badge" style="color:${barColor};">${label}</span>
    </div>`;
  }

  html += `<p class="text-muted text-xs">Higher p-value = harder to detect under this analysis</p></div>`;

  // Active method detail
  const stats: MethodStats = state.analysisResult[method];
  const detLabel = stats.label;
  const labelClass = detLabel === 'Resistant' ? 'resist'
    : detLabel === 'Moderate Risk' ? 'moderate' : 'detect';

  html += `
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Active method</span>
        <span class="stat-value">${stats.name}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Detectability</span>
        <span class="stat-value ${labelClass}">${detLabel}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Coefficients changed</span>
        <span class="stat-value">${stats.changesCount.toLocaleString()} / ${stats.totalCoeffs.toLocaleString()}</span>
      </div>
    </div>

    <div class="method-explanation">
      ${methodExplanation(method)}
    </div>

    <div class="hist-wrap">
      <p class="text-muted text-xs">DCT Coefficient Histogram (non-DC, ±64 range)</p>
      <canvas id="hist-canvas" class="hist-canvas"></canvas>
    </div>`;

  statsContainer.innerHTML = html;

  requestAnimationFrame(() => {
    const hc = document.getElementById('hist-canvas') as HTMLCanvasElement | null;
    if (hc) renderHistogram(hc, stats.dctHist);
  });
}

function methodExplanation(method: 'lsb' | 'f5' | 'juniward'): string {
  switch (method) {
    case 'lsb':
      return `<p class="explain-text"><strong>LSB (spatial)</strong> flips the least-significant bit of pixel values uniformly.
      This creates a predictable, detectable pattern in both spatial and frequency domains.
      Even simple statistical tests reveal the modification.</p>`;
    case 'f5':
      return `<p class="explain-text"><strong>F5 (DCT sequential)</strong> embeds by decrementing the magnitude of non-zero
      DCT coefficients in scan order. It avoids zero coefficients (shrinkage) but has no concept of "cost" —
      it modifies easy-to-detect flat regions just as readily as textured ones.</p>`;
    case 'juniward':
      return `<p class="explain-text"><strong>J-UNIWARD (adaptive)</strong> assigns a cost to each DCT coefficient based on how much
      a ±1 change disturbs the Daubechies-8 wavelet decomposition. Changes are concentrated in
      high-texture regions where they are harder to detect. STC (h=12) minimizes total embedding distortion.</p>`;
  }
}
