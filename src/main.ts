/**
 * main.ts — J-UNIWARD Lab orchestrator
 *
 * Thin entry point that wires together UI modules and state.
 * All logic lives in src/ui/ and src/state/.
 */

import './style.css';
import * as jpeg from 'jpeg-js';

import { setupThemeToggle } from './ui/theme.ts';
import { setupDropzone, loadNextSample, setOnImageLoaded } from './ui/dropzone.ts';
import { prefillForDemo } from './ui/embed-panel.ts';
import { updateAnalysisPanel } from './ui/analysis-panel.ts';
import { activateMechanismPanel } from './ui/mechanism-panel.ts';
import { setupStcWalkthrough } from './ui/stc-walkthrough.ts';
import { wireGlossary } from './ui/glossary.ts';
import { state } from './state/app-state.ts';

// Side-effect imports — these register their own event listeners on import
import './ui/extract-panel.ts';

// Expose jpeg-js for JpegCodec
(window as unknown as Record<string, unknown>)['__jpegJs'] = jpeg;

// ─── Initialize ──────────────────────────────────────────────────────────────

setupThemeToggle();
setupDropzone();

// Wire the plain-English glossary onto all static data-term hosts in the page.
wireGlossary(document);

// STC / Viterbi stepped schematic (always available, below the fold).
setupStcWalkthrough();

// Connect image-loaded callback to update analysis panel + open the cost probe.
setOnImageLoaded(() => {
  state.analysisResult = null;
  updateAnalysisPanel('juniward');
  activateMechanismPanel();
});

// ─── Quick Demo button ───────────────────────────────────────────────────────

const quickDemoBtn = document.getElementById('quick-demo-btn');
quickDemoBtn?.addEventListener('click', async () => {
  const originalLabel = quickDemoBtn.innerHTML;
  quickDemoBtn.classList.add('loading');
  quickDemoBtn.setAttribute('aria-busy', 'true');
  quickDemoBtn.innerHTML = '<span class="spinner"></span> Loading demo…';

  try {
    const loaded = await loadNextSample();
    if (!loaded) return;
    prefillForDemo();

    // Scroll to embed section
    document.getElementById('panel-b-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } finally {
    quickDemoBtn.classList.remove('loading');
    quickDemoBtn.removeAttribute('aria-busy');
    quickDemoBtn.innerHTML = originalLabel;
  }
});

// ─── Onboarding dismiss ─────────────────────────────────────────────────────

const onboarding = document.getElementById('onboarding');
const dismissBtn = document.getElementById('dismiss-onboarding');
dismissBtn?.addEventListener('click', () => {
  onboarding?.classList.add('hidden');
  localStorage.setItem('onboarding-dismissed', '1');
});

// Restore dismissed state
if (localStorage.getItem('onboarding-dismissed') === '1') {
  onboarding?.classList.add('hidden');
}

// Embed button starts disabled
(document.getElementById('embed-btn') as HTMLButtonElement).disabled = true;
