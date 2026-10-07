// Font scaling rule based on the Smart Frames blog (Apr 2026).
// Baseline: 12pt minimum at 1280×720. Scales proportionally with canvas
// width so fonts remain legible on wider canvases (e.g. 1920×1080, 4K).
// Height is ignored: a taller page (1280×1250) is a scrolling page shown
// fit-to-width, not a larger screen, so its text renders at the same size.

const BASE_W = 1280;
const BASE_MIN_PT = 12;

export function minFontPt(canvasW: number, _canvasH?: number): number {
  if (!canvasW) return BASE_MIN_PT;
  const scaled = BASE_MIN_PT * (canvasW / BASE_W);
  // Round up to nearest 0.5pt, never below baseline.
  return Math.max(BASE_MIN_PT, Math.round(scaled * 2) / 2);
}

export function evaluateFontSize(pt: number | null | undefined, canvasW: number, canvasH: number) {
  if (pt == null || Number.isNaN(pt)) return { ok: true, required: minFontPt(canvasW, canvasH), actual: null };
  const required = minFontPt(canvasW, canvasH);
  return { ok: pt >= required, required, actual: pt };
}
