/**
 * analysis-panel.ts — Panel C: three-way adaptive-placement comparison
 *
 * Shows *where* each method's changes land relative to image texture — the
 * distortion J-UNIWARD is designed to minimise — rather than a misleading
 * single p-value.
 */

import { state } from '../state/app-state.ts';
import { renderHistogram } from './renderers.ts';
import { renderPlacementMap } from '../analysis/StegAnalysis.ts';
import type { MethodStats, DetectLabel } from '../analysis/StegAnalysis.ts';

const changesCanvas = document.getElementById('changes-canvas') as HTMLCanvasElement;
const changesLegend = document.getElementById('changes-legend');

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

// ─── Label → presentation ────────────────────────────────────────────────────

function labelColor(label: DetectLabel): string {
  switch (label) {
    case 'Resistant':  return 'var(--success-color)';
    case 'Moderate':   return 'var(--warning-text)';
    case 'Detectable': return 'var(--error-text)';
    case 'Negligible': return 'var(--text-secondary)';
  }
}

function labelClass(label: DetectLabel): string {
  return label === 'Resistant' ? 'resist'
    : label === 'Moderate' ? 'moderate'
    : label === 'Negligible' ? '' : 'detect';
}

// ─── Panel update ────────────────────────────────────────────────────────────

export function updateAnalysisPanel(method: 'lsb' | 'f5' | 'juniward'): void {
  if (!state.analysisResult) {
    explainerPanel.classList.remove('hidden');
    statsContainer.innerHTML = `
      <p class="text-muted">
        Load an image and embed a message to see where each method hides its
        changes — and why adaptive placement is harder to detect.
      </p>`;
    return;
  }

  explainerPanel.classList.add('hidden');

  const methods: { key: 'lsb' | 'f5' | 'juniward'; label: string }[] = [
    { key: 'lsb', label: 'LSB' },
    { key: 'f5', label: 'F5' },
    { key: 'juniward', label: 'J-UNIWARD' },
  ];

  // ── Exposure bars: mean cost-percentile of each method's changes ──
  let html = `<div class="analysis-bars">
    <h3 class="section-label">Change exposure
      <span class="tooltip-trigger" tabindex="0" aria-label="What is change exposure?">ⓘ
        <span class="tooltip-content">Each change is ranked against the J-UNIWARD cost map.
        Exposure is the average cost-percentile of a method's changes: 0% means every change
        landed in the most textured, hardest-to-model coefficients; 100% means the smoothest,
        most conspicuous ones. Lower is stealthier — this is the distortion J-UNIWARD minimises.</span>
      </span>
    </h3>`;

  for (const m of methods) {
    const s: MethodStats = state.analysisResult[m.key];
    const color = labelColor(s.label);
    const barWidth = s.label === 'Negligible' ? 0 : Math.max(2, Math.min(100, s.meanExposure * 100));
    const valDisplay = s.label === 'Negligible'
      ? '—'
      : `${(s.meanExposure * 100).toFixed(0)}%`;

    html += `<div class="bar-row">
      <span class="bar-label">${m.label}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width:${barWidth}%; background-color:${color};"></div>
      </div>
      <span class="bar-value" style="color:${color};">${valDisplay}</span>
      <span class="bar-badge" style="color:${color};">${s.label}</span>
    </div>`;
  }

  html += `<p class="text-muted text-xs">Lower exposure = changes hidden in texture = harder to detect</p></div>`;

  // ── Active-method detail ──
  const s: MethodStats = state.analysisResult[method];
  const cls = labelClass(s.label);
  const structRow = s.structHits > 0
    ? `<div class="stat-card">
         <span class="stat-label">DC / flat coefficients hit</span>
         <span class="stat-value detect">${s.structHits.toLocaleString()}</span>
       </div>`
    : `<div class="stat-card">
         <span class="stat-label">DC / flat coefficients hit</span>
         <span class="stat-value resist">0 — structure preserved</span>
       </div>`;

  html += `
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Detectability</span>
        <span class="stat-value ${cls}">${s.label}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Coefficients changed</span>
        <span class="stat-value">${s.changesCount.toLocaleString()} / ${s.totalCoeffs.toLocaleString()}</span>
      </div>
      ${structRow}
    </div>

    <div class="method-explanation">
      ${methodExplanation(method)}
    </div>

    <div class="hist-wrap">
      <p class="text-muted text-xs">DCT coefficient histogram (non-DC, ±64 range)</p>
      <canvas id="hist-canvas" class="hist-canvas"></canvas>
    </div>`;

  statsContainer.innerHTML = html;

  // Placement map: this method's changes drawn over the cost terrain.
  if (state.costs && state.decoded) {
    renderPlacementMap(
      changesCanvas, state.costs, s.changedBlocks,
      state.decoded.lumaBlocksWide, state.decoded.lumaBlocksHigh,
    );
    if (changesLegend) {
      changesLegend.textContent = (s.changesCount + s.structHits) === 0
        ? 'No DCT-domain changes for this method at this payload.'
        : `Terrain: blue = textured (cheap) → red = smooth (costly). Bright dots = ${methodLabel(method)} changes${s.structHits > 0 ? ' (red dots = DC/flat hits)' : ''}.`;
    }
  }

  requestAnimationFrame(() => {
    const hc = document.getElementById('hist-canvas') as HTMLCanvasElement | null;
    if (hc) renderHistogram(hc, s.dctHist);
  });
}

function methodLabel(method: 'lsb' | 'f5' | 'juniward'): string {
  return method === 'lsb' ? 'LSB' : method === 'f5' ? 'F5' : 'J-UNIWARD';
}

function methodExplanation(method: 'lsb' | 'f5' | 'juniward'): string {
  switch (method) {
    case 'lsb':
      return `<p class="explain-text"><strong>LSB (spatial)</strong> flips the least-significant bit of pixel values,
      blind to image content. Re-transformed into the DCT domain, those edits scatter across the spectrum —
      including the <strong>DC term and flat coefficients</strong> that any first-order detector watches.
      It also leaves the classic spatial pair-of-values signature.</p>`;
    case 'f5':
      return `<p class="explain-text"><strong>F5 (DCT sequential)</strong> embeds only in non-zero AC coefficients,
      which already cluster in busy regions — so it gets a crude texture bias for free and beats LSB.
      But it uses no explicit cost, fills coefficients in scan order, and its magnitude-decrement
      <em>shrinkage</em> leaves a tell-tale histogram signature (visible above).</p>`;
    case 'juniward':
      return `<p class="explain-text"><strong>J-UNIWARD (adaptive)</strong> scores every coefficient by how much a ±1 change
      disturbs a Daubechies-8 wavelet decomposition, then uses STC (h=12) to place the payload in the
      cheapest — most textured — coefficients. At low payloads its exposure is the lowest of the three.
      It never touches DC or flat regions.</p>`;
  }
}
