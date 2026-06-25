/**
 * app-state.ts — Central application state
 *
 * Single source of truth for all mutable state in the application.
 * UI modules read from here; logic modules write to here.
 */

import type { JpegDecoded } from '../codec/JpegCodec.ts';
import type { StegAnalysisResult } from '../analysis/StegAnalysis.ts';

export interface AppState {
  // Cover image
  decoded:        JpegDecoded | null;
  costs:          Float64Array[] | null;
  origBuffer:     ArrayBuffer | null;
  coverFileName:  string;

  // Stego result
  stegoBuffer:    ArrayBuffer | null;
  stegoDecoded:   JpegDecoded | null;
  lastEmbedSalt:  Uint8Array | null;
  lastEmbedRate:  number;
  lastEmbedMsgLen: number;

  // Analysis
  analysisResult: StegAnalysisResult | null;
  activeMethod:   'lsb' | 'f5' | 'juniward';

  // UI
  sampleIdx:      number;
}

export const state: AppState = {
  decoded:        null,
  costs:          null,
  origBuffer:     null,
  coverFileName:  '',

  stegoBuffer:    null,
  stegoDecoded:   null,
  lastEmbedSalt:  null,
  lastEmbedRate:  0.10,
  lastEmbedMsgLen: 0,

  analysisResult: null,
  activeMethod:   'juniward',

  sampleIdx:      -1,
};

/** Reset embed/analysis state (e.g. when loading a new image). */
export function resetEmbedState(): void {
  state.stegoBuffer   = null;
  state.stegoDecoded  = null;
  state.lastEmbedSalt = null;
  state.lastEmbedRate = 0.10;
  state.lastEmbedMsgLen = 0;
  state.analysisResult = null;
}

/** Full reset — new session. */
export function resetAll(): void {
  state.decoded       = null;
  state.costs         = null;
  state.origBuffer    = null;
  state.coverFileName = '';
  resetEmbedState();
}
