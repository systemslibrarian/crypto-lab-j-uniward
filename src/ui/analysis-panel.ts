/**
 * analysis-panel.ts — Panel C: three-way adaptive-placement comparison
 *
 * Shows *where* each method's changes land relative to image texture — the
 * distortion J-UNIWARD is designed to minimise — rather than a misleading
 * single p-value.
 */

import { state } from '../state/app-state.ts';
import { renderHistogram } from './renderers.ts';
import { renderPlacementMap, dctHistogram } from '../analysis/StegAnalysis.ts';
import type { MethodStats, DetectLabel } from '../analysis/StegAnalysis.ts';
import { wireGlossary } from './glossary.ts';

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
      <span class="proxy-tag" title="This bar measures placement, not detection">placement proxy — not a detector</span>
      <span class="tooltip-trigger" tabindex="0" aria-label="What is change exposure?">ⓘ
        <span class="tooltip-content">Each change is ranked against the J-UNIWARD cost map.
        Exposure is the average cost-percentile of a method's changes: 0% means every change
        landed in the most textured, hardest-to-model coefficients; 100% means the smoothest,
        most conspicuous ones. Lower is stealthier — this is the distortion J-UNIWARD minimises.
        It predicts resistance but does not prove undetectability; a lower bar is not "provably safe".</span>
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
    </div>
    <p class="detector-note text-xs">What a real detector would see: ${detectorNote(m.key)}</p>`;
  }

  html += `<p class="text-muted text-xs">Lower exposure = changes hidden in texture = harder to detect —
    but this is where changes <em>land</em>, not the output of an SRM/SRNet detector.</p></div>`;

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
      <canvas id="hist-canvas" class="hist-canvas"
        role="img" aria-label="DCT coefficient histogram: after-embedding bars with the cover outline overlaid"></canvas>
      ${method === 'f5' ? `<p class="hist-callout" role="note">
        <span class="hist-callout-arrow" aria-hidden="true">▲</span>
        <strong>The F5 tell:</strong> compare the solid bars to the faint <em>cover</em> outline.
        <span data-term="shrinkage">Shrinkage</span> suppresses the <strong>±1</strong> buckets flanking
        zero and piles coefficients up at 0 — a step near the center no cover image has. That deformation,
        not any single p-value, is what a histogram attack reads.</p>` :
        method === 'lsb' ? `<p class="hist-callout" role="note">
        LSB spreads its ±1 changes evenly across the whole spectrum, so its histogram barely moves from the
        cover outline — its tell is spatial (pixel pairs), not here.</p>` :
        `<p class="hist-callout" role="note">
        J-UNIWARD's adaptive placement leaves the coefficient histogram almost identical to the cover outline —
        no <span data-term="shrinkage">shrinkage</span> step, few changes, all in busy texture.</p>`}
    </div>`;

  statsContainer.innerHTML = html;
  wireGlossary(statsContainer);

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
    if (hc) {
      const coverHist = state.decoded ? dctHistogram(state.decoded.dctCoeffs) : undefined;
      renderHistogram(hc, s.dctHist, {
        coverHist,
        highlightShrinkage: method === 'f5',
      });
    }
  });
}

function methodLabel(method: 'lsb' | 'f5' | 'juniward'): string {
  return method === 'lsb' ? 'LSB' : method === 'f5' ? 'F5' : 'J-UNIWARD';
}

/** One-line "what a real detector would actually pick up" per method. */
function detectorNote(method: 'lsb' | 'f5' | 'juniward'): string {
  switch (method) {
    case 'lsb':
      return 'a strong spatial pair-of-values signature plus disturbed DC/flat terms — flagged by even simple first-order tests.';
    case 'f5':
      return 'the shrinkage step in the ±1 histogram buckets, readable by classic F5/chi-square-style attacks.';
    case 'juniward':
      return 'little in first-order stats; modern SRM/SRNet feature detectors are still needed, and can succeed at high payloads.';
  }
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
