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
  // The "what is this?" trigger used to be a bare `<span tabindex="0"
  // aria-label="…">ⓘ</span>`. `aria-label` is PROHIBITED on an element with no
  // role, so it was discarded: the icon reached a screen reader as the single
  // character "ⓘ" and nothing else. It now goes through the same glossary
  // machinery as every other term on the page, which gives it a real role, a
  // real name, aria-expanded, and a keyboard toggle.
  let html = `<div class="analysis-bars">
    <h3 class="section-label">Change exposure
      <span class="proxy-tag" title="This bar measures placement, not detection">placement proxy — not a detector</span>
      <span class="gloss-inline" data-term="exposure">what is this?</span>
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
    ${shortfallNote(s)}
    <p class="detector-note text-xs">What a real detector would see: ${detectorNote(m.key)}</p>`;
  }

  html += `<p class="text-muted text-xs">Lower exposure = changes hidden in texture = harder to detect —
    but this is where changes <em>land</em>, not the output of an SRM/SRNet detector.</p>
    ${orderingNote(state.analysisResult)}
    </div>`;

  // ── Active-method detail ──
  const s: MethodStats = state.analysisResult[method];
  const cls = labelClass(s.label);
  // `structHits` can only ever count the DC term: WaveletCost marks zigzag 0 wet
  // (1e8) and gives every AC a finite cost far below the 1e7 threshold, so a
  // DCT-domain method is pinned at 0 by construction. Label it for what it counts.
  const structRow = s.structHits > 0
    ? `<div class="stat-card">
         <span class="stat-label">DC (flat-brightness) terms hit</span>
         <span class="stat-value detect">${s.structHits.toLocaleString()}</span>
       </div>`
    : `<div class="stat-card">
         <span class="stat-label">DC (flat-brightness) terms hit</span>
         <span class="stat-value resist">0 — block brightness untouched</span>
       </div>`;

  // The live replacement for the old "flat coefficients hit" claim: how many of
  // this method's changes landed in the costliest decile of THIS image's own cost
  // distribution. Unlike structHits it can, and does, fire.
  const smoothRow = `<div class="stat-card">
      <span class="stat-label">Changes in the costliest 10% of coefficients</span>
      <span class="stat-value ${s.topDecileChanges > 0 ? 'detect' : 'resist'}">${
        s.changesCount === 0
          ? '—'
          : `${s.topDecileChanges.toLocaleString()} of ${s.changesCount.toLocaleString()} ` +
            `(worst landed at the ${(s.maxExposure * 100).toFixed(0)}th percentile)`
      }</span>
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
      ${smoothRow}
    </div>

    <div class="method-explanation">
      ${methodExplanation(method, s, state.analysisResult)}
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

/**
 * A method that could not carry the whole payload is not comparable with one that
 * did — its exposure average is taken over a smaller, easier set of changes.
 * `f5Embed` returns `bitsEmbedded` and this used to be discarded: on the bundled
 * sample-smooth cover F5 carries 163 of 216–520 requested bits (it exhausts the
 * non-zero ACs) and its 3% "Resistant" bar was shown beside J-UNIWARD's without
 * a word. Say so, at the bar.
 */
function shortfallNote(s: MethodStats): string {
  if (s.bitsEmbedded >= s.bitsRequested) return '';
  const pct = ((s.bitsEmbedded / s.bitsRequested) * 100).toFixed(0);
  return `<p class="detector-note text-xs shortfall-note" role="note"><strong>Comparison invalid:</strong>
    this method carried only ${s.bitsEmbedded.toLocaleString()} of the
    ${s.bitsRequested.toLocaleString()} requested payload bits (${pct}%) — it ran out of usable
    carriers. Its exposure is averaged over a smaller payload than J-UNIWARD's and cannot be
    read against the others.</p>`;
}

/**
 * Which method actually placed its changes most cheaply — computed from this run,
 * not asserted. J-UNIWARD does NOT always win: measured across the three bundled
 * covers, F5's per-change average is lower in 13 of the 15 (cover, rate) states
 * measured — and in 9 of the 11 where F5 carried the whole payload,
 * because F5 only edits non-zero ACs and those are already the cheap ones. The
 * counterweight — how many changes each method made, and the summed distortion
 * that is J-UNIWARD's actual objective — is printed alongside so the ordering is
 * readable rather than misleading.
 */
function orderingNote(r: NonNullable<typeof state.analysisResult>): string {
  const rows = [
    { label: 'LSB', s: r.lsb },
    { label: 'F5', s: r.f5 },
    { label: 'J-UNIWARD', s: r.juniward },
  ].filter(x => x.s.changesCount > 0 && x.s.bitsEmbedded >= x.s.bitsRequested);

  if (rows.length < 2) {
    return `<p class="ordering-note text-xs" role="note">Not enough comparable methods at this
      payload to rank them — see the notes above.</p>`;
  }

  const byExposure = [...rows].sort((a, b) => a.s.meanExposure - b.s.meanExposure);
  const byDistortion = [...rows].sort((a, b) => a.s.totalDistortion - b.s.totalDistortion);
  const cheapest = byExposure[0];
  const lowestTotal = byDistortion[0];

  const counts = rows
    .map(x => `${x.label} ${x.s.changesCount.toLocaleString()}`)
    .join(' · ');

  return `<p class="ordering-note text-xs" role="note">
    <strong>In this run:</strong> ${cheapest.label} has the lowest per-change exposure
    (${(cheapest.s.meanExposure * 100).toFixed(1)}%), and ${lowestTotal.label} has the lowest
    <em>total</em> distortion — the sum J-UNIWARD's coder actually minimises
    (${lowestTotal.s.totalDistortion.toExponential(2)}). Changes made: ${counts}.
    A per-change average says nothing about how many changes there were, so read the two
    together: F5 only ever edits non-zero AC coefficients, which are already the cheap textured
    ones, so it can win the average while making far more edits and leaving a shrinkage tell.</p>`;
}

function methodExplanation(
  method: 'lsb' | 'f5' | 'juniward',
  s: MethodStats,
  all: NonNullable<typeof state.analysisResult>,
): string {
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
    case 'juniward': {
      // Both sentences here used to be asserted: "At low payloads its exposure is
      // the lowest of the three" and "It never touches DC or flat regions". The
      // first is false on 13 of the 15 measured (cover, rate) states — 9 of the
      // 11 where F5 carried the whole payload — including the
      // shipped default; the second is contradicted by this run's own worst
      // placement whenever the payload pushes past the cheap coefficients. Both
      // are now read off the run.
      const beats = (['lsb', 'f5'] as const)
        .filter(k => all[k].changesCount > 0
          && all[k].bitsEmbedded >= all[k].bitsRequested
          && all[k].meanExposure < s.meanExposure)
        .map(k => (k === 'lsb' ? 'LSB' : 'F5'));
      const rankSentence = beats.length === 0
        ? `In this run its per-change exposure (${(s.meanExposure * 100).toFixed(1)}%) is the lowest of the three.`
        : `In this run its per-change exposure is ${(s.meanExposure * 100).toFixed(1)}% — higher than
           ${beats.join(' and ')}, because its carrier pool is <em>every</em> AC coefficient, zeros
           included, so satisfying each 12-bit syndrome block sometimes costs a flatter coefficient
           than ${beats.length > 1 ? 'those methods' : 'that method'} would ever visit.`;
      const flatSentence = s.topDecileChanges === 0
        ? `It never touches the DC term, and no change in this run landed in the costliest decile
           (worst: ${(s.maxExposure * 100).toFixed(0)}th percentile).`
        : `It never touches the DC term, but ${s.topDecileChanges.toLocaleString()} of its
           ${s.changesCount.toLocaleString()} changes landed in the costliest decile of this image
           (worst: ${(s.maxExposure * 100).toFixed(0)}th percentile) — "adaptive" is a budget, not a guarantee.`;
      return `<p class="explain-text"><strong>J-UNIWARD (adaptive)</strong> scores every coefficient by how much a ±1 change
      disturbs a Daubechies-8 wavelet decomposition, then uses STC (h=12) to place the payload in the
      cheapest coefficients it can reach. ${rankSentence} ${flatSentence}</p>`;
    }
  }
}
