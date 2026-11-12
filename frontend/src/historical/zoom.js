// Time-axis zoom math for ReadingsChart. Plain functions on [t0, t1] ranges in epoch ms,
// kept out of the component so they can be tested on their own.

/**
 * Keep a view inside the full range and no narrower than `minSpan`.
 * A view that would cross an edge is slid back in rather than cut, so its width is kept.
 * @param {[number, number]} view
 * @param {[number, number]} full
 * @param {number} minSpan
 * @returns {[number, number]}
 */
export function clampView([a, b], [lo, hi], minSpan) {
  const fullSpan = hi - lo;
  let span = Math.min(Math.max(b - a, Math.min(minSpan, fullSpan)), fullSpan);
  // Widen a too-narrow view around its middle
  let start = (a + b) / 2 - span / 2;
  if (b - a >= span) start = a;
  start = Math.min(Math.max(start, lo), hi - span);
  return [start, start + span];
}

/**
 * Zoom around an anchor time, which stays at the same place on screen.
 * `factor` < 1 zooms in (0.5 halves the span), > 1 zooms out.
 */
export function zoomView([a, b], full, anchor, factor, minSpan) {
  const t = Math.min(Math.max(anchor, a), b);
  return clampView([t - (t - a) * factor, t + (b - t) * factor], full, minSpan);
}

/** Shift a view by `delta` ms, stopping at the edges of the full range. */
export function panView([a, b], full, delta) {
  return clampView([a + delta, b + delta], full, 0);
}

/** True when the view covers the whole range (within half a millisecond of rounding). */
export function isFullView(view, [lo, hi]) {
  return !view || (view[0] <= lo + 0.5 && view[1] >= hi - 0.5);
}

/** First index whose time is >= t (times sorted ascending). */
export function lowerBound(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index range [i0, i1) of the readings to draw for a view: everything inside it,
 * plus one reading either side so the line runs to the plot edges.
 */
export function visibleRange(times, t0, t1) {
  const i0 = Math.max(0, lowerBound(times, t0) - 1);
  const i1 = Math.min(times.length, lowerBound(times, t1 + 1) + 1);
  return [i0, i1];
}
