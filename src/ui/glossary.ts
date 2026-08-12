/**
 * glossary.ts — always-available plain-English on-ramp for load-bearing jargon.
 *
 * The pedagogy review flagged that a capable coder new to steganography hits a
 * wall of acronyms (bpnzac, DCT, wavelet, STC/Viterbi, AC/DC, shrinkage) that
 * the demo uses heavily but never introduces. This module does two things:
 *
 *   1. Exposes a small dictionary of one-line, plain-English glosses.
 *   2. Wires up any element carrying `data-term="…"` into an accessible tooltip
 *      (hover + keyboard focus), so the raw acronym is always gated behind a
 *      one-line gloss wherever it first appears — without dumbing down the term.
 *
 * The gloss is a bridge, not a replacement: the precise term stays on screen.
 */

export interface GlossEntry {
  /** Short label shown as the visible term. */
  term: string;
  /** One-line plain-English expansion. */
  gloss: string;
}

export const GLOSSARY: Record<string, GlossEntry> = {
  bpnzac: {
    term: 'bpnzac',
    gloss:
      'Bits Per Non-zero AC Coefficient — how full you pack the usable coefficients. ' +
      '0.1 means one hidden bit for every ten changeable coefficients; higher = more ' +
      'payload but more changes to detect.',
  },
  dct: {
    term: 'DCT',
    gloss:
      'Discrete Cosine Transform — JPEG splits each 8×8 pixel block into 64 frequency ' +
      '"coefficients" (one flat brightness term + 63 wave-like detail terms). Steganography ' +
      'hides bits by nudging these coefficients, not raw pixels.',
  },
  ac: {
    term: 'AC',
    gloss:
      'AC coefficients are the 63 detail (wave) terms in each 8×8 DCT block — the edges and ' +
      'texture. These are the changeable carriers.',
  },
  dc: {
    term: 'DC',
    gloss:
      'The DC coefficient is the single flat-brightness term of an 8×8 block (its average). ' +
      'Touching it shifts a whole block’s brightness — structurally conspicuous, so adaptive ' +
      'schemes never embed there.',
  },
  wavelet: {
    term: 'wavelet',
    gloss:
      'A wavelet transform re-expresses the image as directional detail — horizontal, vertical ' +
      'and diagonal. J-UNIWARD uses the three first-level undecimated Daubechies-8 detail ' +
      'subbands to measure how much a change disturbs texture the image model can see.',
  },
  stc: {
    term: 'STC',
    gloss:
      'Syndrome-Trellis Codes — an error-correcting-style code that lets the embedder hit the ' +
      'exact hidden message while flipping the cheapest possible set of coefficients overall.',
  },
  viterbi: {
    term: 'Viterbi',
    gloss:
      'The Viterbi algorithm walks a trellis of candidate flip patterns and finds the cheapest ' +
      'one exactly, rather than choosing greedily coefficient by coefficient. Here it does that ' +
      'per 12-bit block of the message, over that block\u2019s own window of carriers.',
  },
  shrinkage: {
    term: 'shrinkage',
    gloss:
      'In F5, when a coefficient’s magnitude is decremented to zero it drops out and must be ' +
      're-embedded elsewhere. This systematically over-produces near-zero coefficients — a ' +
      'tell-tale dip in the ±1 histogram buckets.',
  },
  cost: {
    term: 'cost',
    gloss:
      'The distortion "price" of changing one coefficient. Low cost = the change hides in ' +
      'busy texture; high cost = it would stand out in a smooth region. J-UNIWARD spends its ' +
      'payload where cost is lowest.',
  },
  exposure: {
    term: 'change exposure',
    gloss:
      'The average cost-percentile of a method’s changes. 0% means every change landed in the ' +
      'most textured, hardest-to-model coefficients; 100% means the smoothest, most conspicuous ' +
      'ones. Lower is stealthier — it is the distortion J-UNIWARD minimises. It predicts ' +
      'resistance; it does not prove undetectability, so a lower bar is not "provably safe".',
  },
};

/**
 * Keep an opened bubble inside the viewport.
 *
 * The bubble is positioned from its host's left edge and is up to 300px wide,
 * so a host sitting well into a panel would place it off the right of the page.
 * That used to be invisible, because `.panel`/`.panel-body` clipped it — which
 * is exactly the bug: a third of the gloss was silently cut off rather than
 * merely mispositioned. With those clips removed the overflow becomes real, so
 * the offset is measured against the viewport and clamped on every reveal.
 *
 * Width is set here too, from the same expression the stylesheet declares, so
 * there is one number deciding both the box and the clamp.
 */
function placeBubble(host: HTMLElement, bubble: HTMLElement): void {
  const MARGIN = 8;
  const width = Math.min(300, window.innerWidth - 2 * MARGIN);
  bubble.style.width = `${width}px`;
  const hostLeft = host.getBoundingClientRect().left;
  // Clamp the bubble's viewport-left into [MARGIN, innerWidth - MARGIN - width],
  // then express the result as an offset from the host, which is what `left`
  // means for an absolutely positioned child of a `position: relative` host.
  const rightMost = Math.max(MARGIN, window.innerWidth - MARGIN - width);
  const placed = Math.min(Math.max(hostLeft, MARGIN), rightMost);
  bubble.style.left = `${placed - hostLeft}px`;
}

/**
 * Every wired host, so a viewport change can re-place all of them at once.
 *
 * One shared listener rather than one per host: this page wires a fresh set of
 * `data-term` spans every time the steganalysis panel re-renders.
 */
const wired: { host: HTMLElement; bubble: HTMLElement }[] = [];
window.addEventListener('resize', () => {
  for (const w of wired) placeBubble(w.host, w.bubble);
});

/**
 * Turn every element carrying `data-term="key"` into an accessible tooltip.
 * The element keeps its visible text (the real term); we add a dotted underline,
 * a keyboard-focusable target, and an aria-describedby tooltip bubble.
 */
export function wireGlossary(root: ParentNode = document): void {
  const hosts = root.querySelectorAll<HTMLElement>('[data-term]');
  hosts.forEach((host, i) => {
    const key = host.dataset['term'];
    if (!key) return;
    const entry = GLOSSARY[key];
    if (!entry) return;
    if (host.dataset['glossWired'] === '1') return;
    host.dataset['glossWired'] = '1';

    host.classList.add('gloss');
    host.setAttribute('tabindex', '0');
    host.setAttribute('role', 'button');
    host.setAttribute('aria-expanded', 'false');

    const bubbleId = `gloss-bubble-${key}-${i}`;
    const bubble = document.createElement('span');
    bubble.className = 'gloss-bubble';
    bubble.id = bubbleId;
    bubble.setAttribute('role', 'tooltip');
    bubble.innerHTML = `<strong class="gloss-bubble-term">${entry.term}</strong> ${entry.gloss}`;
    host.appendChild(bubble);
    host.setAttribute('aria-describedby', bubbleId);

    // Hover and focus reveal the bubble from CSS alone, so the placement has to
    // hang off the same two events rather than off the toggle.
    //
    // Twice, immediately and again on the next frame: layout is not always
    // final when the event fires — a font or a late-decoded image can still
    // move the host — and a bubble placed from a position the host has since
    // left lands outside the viewport. That produced exactly one intermittent
    // failure of the reflow gate before the second pass was added.
    const place = (): void => {
      placeBubble(host, bubble);
      requestAnimationFrame(() => placeBubble(host, bubble));
    };
    wired.push({ host, bubble });
    host.addEventListener('mouseenter', place);
    host.addEventListener('focus', place);

    // Keyboard: Enter/Space toggles (hover handled in CSS); Escape closes.
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const open = host.classList.toggle('gloss-open');
        host.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) place();
      } else if (e.key === 'Escape') {
        host.classList.remove('gloss-open');
        host.setAttribute('aria-expanded', 'false');
      }
    });
    host.addEventListener('blur', () => {
      host.classList.remove('gloss-open');
      host.setAttribute('aria-expanded', 'false');
    });
  });
}
