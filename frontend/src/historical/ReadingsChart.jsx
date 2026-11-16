/**
 * The app's water-level line chart: one line per gauge, drawn as plain SVG.
 * Used by the readings page and by the landing page's live panel.
 *
 * Built by hand rather than with a chart library because it has to stay fast with
 * ~260k points (a year of 6-minute data at three gauges) and must never smooth away
 * a storm peak, which matters more here than anything a library would add.
 *
 * Interaction
 *   Hover / touch-drag      crosshair + tooltip with every gauge's reading at that time
 *   Tap (touch)             pins the tooltip at that time
 *   Drag across the plot    zooms to the selected time range (mouse / pen)
 *   Ctrl/Cmd + wheel        zooms around the pointer (trackpad pinch sends this too)
 *   Pinch (touch)           zooms around the fingers
 *   Overview strip below    drag the window to pan, its edges to resize, elsewhere to pick a range
 *   Double-click / Reset    back to the full range
 *   Keyboard                arrows move the cursor, + / - zoom, Shift+arrows pan, 0 resets
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { ActionButton } from '../theme/Primitives.jsx';
import { formatDateTime, niceTicks, timeTicks } from './time.js';
import { clampView, isFullView, lowerBound, panView, visibleRange, zoomView } from './zoom.js';
import './readings.css';

const M = { top: 16, right: 20, bottom: 34, left: 52 }; // margins around the plot for axis labels
const BRUSH_H = 36; // px; height of the overview strip under the x axis
const BRUSH_GAP = 10; // px between the x-axis labels and the strip
const MIN_DRAG_PX = 6; // a drag shorter than this is a click, not a selection
const TOOLTIP_W = 230;

/** Index of the reading nearest to time t (readings sorted by time). Binary search, O(log n). */
function nearestIndex(times, t) {
  const lo = Math.min(lowerBound(times, t), times.length - 1);
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

/**
 * SVG path for readings [i0, i1) of one series, decimated to the min and max reading
 * per pixel column (in time order) so peaks survive however many points there are.
 * The line breaks at missing values and at gaps longer than `gapMs`.
 */
function buildPath(times, values, x, y, gapMs, i0 = 0, i1 = times.length) {
  const parts = [];
  let penDown = false;
  let col = null;
  let bucket = null; // { minI, maxI }

  // Emit the current column's min and max (one point if they are the same reading)
  const flush = () => {
    if (!bucket) return;
    const pts = bucket.minI === bucket.maxI ? [bucket.minI] : [bucket.minI, bucket.maxI].sort((a, b) => a - b);
    for (const i of pts) {
      parts.push(`${penDown ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(values[i]).toFixed(1)}`);
      penDown = true;
    }
    bucket = null;
  };

  for (let i = i0; i < i1; i++) {
    const v = values[i];
    // A missing value lifts the pen, so the line shows a gap instead of bridging it
    if (v === null) {
      flush();
      penDown = false;
      col = null;
      continue;
    }
    // So does a jump in time, e.g. a gauge that was offline for weeks
    if (i > i0 && times[i] - times[i - 1] > gapMs) {
      flush();
      penDown = false;
      col = null;
    }
    // Group readings by the pixel column they land in, tracking that column's extremes
    const c = Math.floor(x(times[i]));
    if (c !== col) {
      flush();
      col = c;
      bucket = { minI: i, maxI: i };
    } else {
      if (v < values[bucket.minI]) bucket.minI = i;
      if (v > values[bucket.maxI]) bucket.maxI = i;
    }
  }
  flush();
  return parts.join('');
}

/** Lowest and highest value of readings with times in [t0, t1], or null if there are none. */
function extentIn(series, t0, t1) {
  let lo = Infinity;
  let hi = -Infinity;
  let peak = null;
  for (const s of series) {
    const end = lowerBound(s.times, t1 + 1);
    for (let i = lowerBound(s.times, t0); i < end; i++) {
      const v = s.values[i];
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) {
        hi = v;
        peak = { v, t: s.times[i], name: s.name, color: s.color };
      }
    }
  }
  return Number.isFinite(lo) ? { lo, hi, peak } : null;
}

/** NOAA flags worth showing: the 6-minute flag string ("0,0,0,0") only matters when one is set. */
const flagNote = (f) => (typeof f === 'string' && /[1-9]/.test(f) ? ` · NOAA flags ${f}` : '');

/**
 * Multi-gauge water-level line chart with a crosshair readout and time-axis zoom.
 *
 * @param {Object} props
 * @param {Array<{ id, name, color, times: number[], values: (number|null)[], readings: Array }>} props.series
 *   Readings must be sorted by time; each reading has an ISO UTC `t` ("...Z") and `v` in ft (or null).
 * @param {[number, number]} props.domain - full x domain in ms (the requested range)
 * @param {number|null} props.trigger - optional trigger level, ft
 * @param {number} props.stepMs - expected spacing between readings
 * @param {string} props.valueLabel - e.g. "Water level" or "Daily max"
 * @param {boolean} [props.showReadingTime] - show each reading's own time (daily max happens at a time of its own)
 * @param {number} [props.height] - plot height in px, axes included (the overview strip is added below)
 * @param {string} [props.unitsLabel] - units and datum shown in the tooltip
 * @param {string} [props.triggerClassName] - extra class on the trigger line, e.g. to color it by status
 */
export default function ReadingsChart({
  series,
  domain,
  trigger,
  stepMs,
  valueLabel,
  showReadingTime = false,
  height = 340,
  unitsLabel = 'ft',
  triggerClassName = '',
}) {
  const [width, setWidth] = useState(0); // 0 until the container has been measured
  const [hoverT, setHoverT] = useState(null); // time (ms) under the pointer or keyboard cursor, or null
  const [zoom, setZoom] = useState(null); // visible [t0, t1] in ms, or null for the whole domain
  const [selection, setSelection] = useState(null); // [tA, tB] while drag-selecting on the plot
  const clipId = `hx-clip-${useId().replace(/[^\w-]/g, '')}`; // React ids contain characters url(#...) dislikes
  const svgRef = useRef(null);
  const drag = useRef(null); // the gesture in progress, see onPointerDown
  const touches = useRef(new Map()); // active touch pointers: id -> x in px
  const onWheelRef = useRef(null); // latest wheel handler, read by the native listener

  // New data or a new range starts unzoomed. Compared by value / identity during render
  // (React's "adjust state when a prop changes" pattern) so there's no zoomed flash.
  const basis = [domain[0], domain[1], ...series.map((s) => s.times)];
  const [zoomBasis, setZoomBasis] = useState(basis);
  if (basis.length !== zoomBasis.length || basis.some((b, i) => b !== zoomBasis[i])) {
    setZoomBasis(basis);
    setZoom(null);
    setHoverT(null);
  }

  const full = domain;
  const view = zoom ?? full;
  const zoomed = !isFullView(zoom, full);
  // Never zoom closer than a few readings
  const minSpan = Math.min(stepMs * 6, full[1] - full[0]);

  // Measure the container whenever it mounts, and follow its size after that.
  // A callback ref (rather than useRef + useEffect) also catches the container
  // appearing later, e.g. after an empty result is replaced by real data.
  // It also hosts the wheel listener, which must be non-passive to stop the page scrolling.
  const observer = useRef(null);
  const wheelEl = useRef(null);
  const wrapRef = useCallback((el) => {
    observer.current?.disconnect();
    const onWheel = (e) => onWheelRef.current?.(e);
    wheelEl.current?.removeEventListener('wheel', wheelEl.current.__hxWheel);
    wheelEl.current = el;
    if (!el) return;
    el.__hxWheel = onWheel;
    el.addEventListener('wheel', onWheel, { passive: false });
    const measure = () => setWidth(Math.max(260, Math.floor(el.clientWidth - 8)));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);

  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const brushTop = height + BRUSH_GAP;
  const svgH = brushTop + BRUSH_H + 2;

  // The overview strip: every series over the whole domain, with its own small y scale.
  // Only depends on the data and the size, so zooming and panning don't redraw it.
  const overview = useMemo(() => {
    const ext = extentIn(series, -Infinity, Infinity);
    if (!ext || !width) return ext && { ext };
    const [d0, d1] = domain;
    const lo = ext.lo;
    const hi = ext.hi === ext.lo ? ext.lo + 1 : ext.hi;
    const ox = (t) => M.left + ((t - d0) / (d1 - d0)) * plotW;
    const oy = (v) => brushTop + 3 + (1 - (v - lo) / (hi - lo)) * (BRUSH_H - 6);
    const paths = series.map((s) => buildPath(s.times, s.values, ox, oy, stepMs * 2.5));
    return { ext, ox, paths };
  }, [series, domain, width, plotW, brushTop, stepMs]);

  // Everything that depends on the data, the size or the view: scales, ticks, paths and
  // the peak in view. Recomputed only when those change, not on every hover.
  const layout = useMemo(() => {
    if (!overview || !width) return null;
    const [t0, t1] = view; // the visible range, so missing coverage shows as empty space
    // Fit the y axis to what's visible; fall back to the whole series inside a gap
    const inView = extentIn(series, t0, t1);
    let { lo, hi } = inView ?? overview.ext;
    if (trigger !== null) {
      lo = Math.min(lo, trigger);
      hi = Math.max(hi, trigger);
    }
    const yTicks = niceTicks(lo, hi, Math.max(3, Math.round(plotH / 50)));
    const yLo = yTicks[0];
    const yHi = yTicks[yTicks.length - 1] === yLo ? yLo + 1 : yTicks[yTicks.length - 1];
    // Scales: time (ms) -> px from the left, feet -> px from the top
    const x = (t) => M.left + ((t - t0) / (t1 - t0)) * plotW;
    const y = (v) => M.top + (1 - (v - yLo) / (yHi - yLo)) * plotH;
    const xt = timeTicks(t0, t1, Math.max(2, Math.floor(plotW / 110)));
    // Break a line where readings are more than 2.5 intervals apart (a real gap, not jitter).
    // Only the readings in view (plus one either side) are walked.
    const paths = series.map((s) => {
      const [i0, i1] = visibleRange(s.times, t0, t1);
      return buildPath(s.times, s.values, x, y, stepMs * 2.5, i0, i1);
    });
    return { t0, t1, x, y, yTicks, xt, paths, peak: inView?.peak ?? null };
  }, [series, overview, view, trigger, width, plotW, plotH, stepMs]);

  if (!overview) {
    return <p className="hx-empty">No readings with a value in this range.</p>;
  }
  // First render: draw an empty frame of the right height so it can be measured without a layout jump
  if (!width || !layout) return <div className="hx-chart" ref={wrapRef} style={{ height: svgH + 12 }} />;

  const { t0, t1, x, y, yTicks, xt, paths, peak } = layout;
  const { ox } = overview;
  const toT = (px) => t0 + ((px - M.left) / plotW) * (t1 - t0);
  const fromOverview = (px) => full[0] + ((px - M.left) / plotW) * (full[1] - full[0]);
  const clampT = (t, [a, b] = view) => Math.min(b, Math.max(a, t));
  const setView = (v) => setZoom(v && !isFullView(v, full) ? v : null);
  const resetZoom = () => {
    setZoom(null);
    setSelection(null);
  };

  // Readout: every gauge's nearest reading to the hovered time. A reading only counts
  // if it is close to the cursor (about one reading interval, or one pixel's worth
  // of time when zoomed out); otherwise that gauge shows "No reading" (e.g. an outage).
  const readout =
    hoverT === null
      ? null
      : series.map((s) => {
          if (!s.times.length) return { s, r: null };
          const i = nearestIndex(s.times, hoverT);
          const near = Math.abs(s.times[i] - hoverT) <= Math.max(stepMs, (t1 - t0) / plotW) * 1.5;
          return { s, r: near ? s.readings[i] : null };
        });

  // Pointer position in SVG units. The SVG can be scaled by CSS, so map through its
  // on-screen size rather than using offsetX directly.
  const local = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { px: ((e.clientX - rect.left) / rect.width) * width, py: ((e.clientY - rect.top) / rect.height) * svgH };
  };
  const inPlotX = (px) => px >= M.left && px <= M.left + plotW;
  const inBrush = (py) => py >= brushTop - 4;

  // Ctrl/Cmd + wheel (and trackpad pinch, which browsers report the same way) zooms around
  // the pointer. A plain wheel is left alone so the page still scrolls over the chart.
  onWheelRef.current = (e) => {
    if (!(e.ctrlKey || e.metaKey) || !svgRef.current) return;
    const { px } = local(e);
    if (!inPlotX(px)) return;
    e.preventDefault();
    const factor = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.01)));
    setView(zoomView(view, full, toT(px), factor, minSpan));
  };

  const onPointerDown = (e) => {
    const { px, py } = local(e);
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, px);
      // A second finger turns whatever was happening into a pinch
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        drag.current = { kind: 'pinch', dist: Math.max(20, Math.abs(a - b)), start: view, anchor: toT((a + b) / 2) };
        setHoverT(null);
        return;
      }
    } else if (e.button !== 0) {
      return;
    }
    if (!inPlotX(px)) return;
    svgRef.current.setPointerCapture?.(e.pointerId);

    if (inBrush(py)) {
      // Overview strip: grab an edge of the window, the window itself, or start a new range
      const wa = ox(view[0]);
      const wb = ox(view[1]);
      const kind =
        zoomed && Math.abs(px - wa) <= 8 ? 'brush-l' :
        zoomed && Math.abs(px - wb) <= 8 ? 'brush-r' :
        zoomed && px > wa && px < wb ? 'brush-pan' : 'brush-new';
      drag.current = { kind, px, start: view, from: fromOverview(px) };
      setHoverT(null);
      return;
    }
    if (e.pointerType === 'touch') {
      // One finger scrubs the tooltip; zooming on touch is pinch or the overview strip
      drag.current = { kind: 'scrub' };
      setHoverT(clampT(toT(px)));
    } else {
      drag.current = { kind: 'select', px, from: clampT(toT(px)) };
    }
  };

  const onPointerMove = (e) => {
    const { px, py } = local(e);
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, px);
    const d = drag.current;
    if (!d) {
      // Plain hover (mouse / pen): the crosshair follows the pointer over the plot only
      if (e.pointerType !== 'touch') setHoverT(inPlotX(px) && !inBrush(py) ? toT(px) : null);
      return;
    }
    const spanFull = full[1] - full[0];
    switch (d.kind) {
      case 'scrub':
        setHoverT(clampT(toT(px)));
        break;
      case 'select':
        if (Math.abs(px - d.px) >= MIN_DRAG_PX) {
          setSelection([d.from, clampT(toT(px))]);
          setHoverT(null);
        }
        break;
      case 'pinch': {
        if (touches.current.size < 2) break;
        const [a, b] = [...touches.current.values()];
        const factor = d.dist / Math.max(20, Math.abs(a - b)); // fingers apart -> zoom in
        setView(zoomView(d.start, full, d.anchor, factor, minSpan));
        break;
      }
      case 'brush-pan':
        setView(panView(d.start, full, ((px - d.px) / plotW) * spanFull));
        break;
      case 'brush-l':
        setView(clampView([Math.min(fromOverview(px), d.start[1] - minSpan), d.start[1]], full, minSpan));
        break;
      case 'brush-r':
        setView(clampView([d.start[0], Math.max(fromOverview(px), d.start[0] + minSpan)], full, minSpan));
        break;
      case 'brush-new': {
        if (Math.abs(px - d.px) < MIN_DRAG_PX) break;
        const t = clampT(fromOverview(px), full);
        setView(clampView([Math.min(d.from, t), Math.max(d.from, t)], full, minSpan));
        break;
      }
      default:
    }
  };

  const onPointerUp = (e) => {
    touches.current.delete(e.pointerId);
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pinch') {
      // Lifting one finger of a pinch ends it; the other finger doesn't start a scrub
      if (touches.current.size === 0) drag.current = null;
      return;
    }
    drag.current = null;
    if (d.kind === 'select' && selection) {
      const [a, b] = selection[0] < selection[1] ? selection : [selection[1], selection[0]];
      if (x(b) - x(a) >= MIN_DRAG_PX) setView(clampView([a, b], full, minSpan));
    } else if (d.kind === 'brush-new' && zoomed && Math.abs(local(e).px - d.px) < MIN_DRAG_PX) {
      // A click on the strip outside the window moves the window there
      setView(panView(view, full, d.from - (view[0] + view[1]) / 2));
    }
    setSelection(null);
  };

  const onPointerCancel = (e) => {
    // The browser took the gesture over (e.g. a vertical scroll): drop it and hide the readout
    touches.current.delete(e.pointerId);
    drag.current = null;
    setSelection(null);
    setHoverT(null);
  };

  // Keyboard equivalent of hovering and zooming: arrows move the cursor 1% of the view,
  // Shift+arrows pan 10%, + / - zoom around the cursor, 0 resets, Escape hides the cursor.
  const onKey = (e) => {
    const span = t1 - t0;
    const center = hoverT ?? (t0 + t1) / 2;
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.shiftKey) {
      e.preventDefault();
      const next = panView(view, full, (e.key === 'ArrowRight' ? 1 : -1) * span * 0.1);
      setView(next);
      if (hoverT !== null) setHoverT(clampT(hoverT, next));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = span / 100;
      const base = hoverT ?? (e.key === 'ArrowRight' ? t0 : t1);
      setHoverT(clampT(base + (e.key === 'ArrowRight' ? step : -step)));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setView(zoomView(view, full, center, 0.5, minSpan));
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setView(zoomView(view, full, center, 2, minSpan));
    } else if (e.key === '0') {
      e.preventDefault();
      resetZoom();
    } else if (e.key === 'Escape') {
      setHoverT(null);
    }
  };

  // Tooltip sits right of the crosshair, flipping to the left near the right edge
  const hx = hoverT === null ? null : x(hoverT);
  const tooltipFlip = hx !== null && hx + 12 + TOOLTIP_W > width;
  const tooltipLeft = hx === null ? 0 : tooltipFlip ? Math.max(0, hx - 12 - TOOLTIP_W) : Math.max(hx + 12, 0);
  const sel = selection && [Math.min(x(selection[0]), x(selection[1])), Math.max(x(selection[0]), x(selection[1]))];
  const win = [ox(view[0]), ox(view[1])];
  const peakText = peak ? `${zoomed ? 'Peak in view' : 'Peak'} ${peak.v.toFixed(2)} ft at ${formatDateTime(new Date(peak.t).toISOString())}` : 'No readings in view';

  return (
    <div className="hx-chart-block">
      <div className="hx-chart-bar">
        <p className="hx-chart-note" aria-live="polite">
          <span className="hx-chart-range">
            {zoomed
              ? `Zoomed: ${formatDateTime(new Date(t0).toISOString())} to ${formatDateTime(new Date(t1).toISOString())}`
              : 'Full range'}
          </span>
          <span className="hx-chart-peak">{peakText}</span>
        </p>
        <ActionButton tone="ghost" size="px-3 py-1.5 text-xs" onClick={resetZoom} disabled={!zoomed} aria-label="Reset zoom to the full range">
          Reset zoom
        </ActionButton>
      </div>

      <div className="hx-chart" ref={wrapRef}>
        <svg
          ref={svgRef}
          width={width}
          height={svgH}
          viewBox={`0 0 ${width} ${svgH}`}
          role="application"
          aria-label={`${valueLabel} chart. ${peakText}. Left and right arrows move through time, plus and minus zoom, Shift with arrows pans, 0 resets the zoom.`}
          tabIndex={0}
          className={selection ? 'is-selecting' : ''}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={(e) => e.pointerType !== 'touch' && !drag.current && setHoverT(null)}
          onDoubleClick={resetZoom}
          onKeyDown={onKey}
          onBlur={() => setHoverT(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={M.left} y={M.top - 6} width={plotW} height={plotH + 12} />
            </clipPath>
          </defs>

          {/* Plot background: the target for crosshair hover and drag-to-zoom */}
          <rect className="hx-plot-hit" x={M.left} y={M.top} width={plotW} height={plotH} />

          {/* Grid + y axis */}
          {yTicks.map((v) => (
            <g key={v}>
              <line className="hx-grid" x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} />
              <text className="hx-tick" x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                {v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </text>
            </g>
          ))}

          {/* x axis */}
          <line className="hx-axis" x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} />
          {xt.ticks.filter((t) => x(t) >= M.left + 16 && x(t) <= M.left + plotW - 24).map((t) => (
            <text key={t} className="hx-tick" x={x(t)} y={M.top + plotH + 20} textAnchor="middle">
              {xt.format(t)}
            </text>
          ))}

          {/* Trigger level */}
          {trigger !== null && (
            <g>
              <line className={`hx-trigger ${triggerClassName}`} x1={M.left} x2={M.left + plotW} y1={y(trigger)} y2={y(trigger)} />
              <text className="hx-trigger-label" x={M.left + 8} y={y(trigger) - 6}>
                Trigger {trigger.toFixed(2)} ft
              </text>
            </g>
          )}

          {/* Series, clipped to the plot so zoomed lines stop at its edges */}
          <g clipPath={`url(#${clipId})`}>
            {paths.map((d, i) => (
              <path key={series[i].id} d={d} className="hx-line" style={{ stroke: series[i].color }} />
            ))}
          </g>

          {/* Peak label: only the single highest reading in view is labelled, and it hides while hovering */}
          {peak && hoverT === null && !selection && (
            <g>
              <circle className="hx-dot" cx={x(peak.t)} cy={y(peak.v)} r={4} style={{ fill: peak.color }} />
              <text
                className="hx-peak-label"
                x={Math.min(Math.max(x(peak.t), M.left + 60), M.left + plotW - 60)}
                y={Math.max(y(peak.v) - 10, M.top + 10)}
                textAnchor="middle"
              >
                Peak {peak.v.toFixed(2)} ft
              </text>
            </g>
          )}

          {/* Drag-to-zoom selection */}
          {sel && <rect className="hx-selection" x={sel[0]} y={M.top} width={sel[1] - sel[0]} height={plotH} />}

          {/* Crosshair */}
          {hx !== null && (
            <g>
              <line className="hx-crosshair" x1={hx} x2={hx} y1={M.top} y2={M.top + plotH} />
              {readout.map(({ s, r }) =>
                r && r.v !== null ? (
                  <circle key={s.id} className="hx-dot" cx={x(Date.parse(r.t))} cy={y(r.v)} r={4} style={{ fill: s.color }} />
                ) : null,
              )}
            </g>
          )}

          {/* Overview strip: the whole range, with the visible window outlined */}
          <g className="hx-brush" aria-hidden="true">
            <rect className="hx-brush-bg" x={M.left} y={brushTop} width={plotW} height={BRUSH_H} />
            {overview.paths.map((d, i) => (
              <path key={series[i].id} d={d} className="hx-brush-line" style={{ stroke: series[i].color }} />
            ))}
            {zoomed && (
              <>
                <rect className="hx-brush-shade" x={M.left} y={brushTop} width={Math.max(0, win[0] - M.left)} height={BRUSH_H} />
                <rect className="hx-brush-shade" x={win[1]} y={brushTop} width={Math.max(0, M.left + plotW - win[1])} height={BRUSH_H} />
                <rect className="hx-brush-window" x={win[0]} y={brushTop} width={Math.max(2, win[1] - win[0])} height={BRUSH_H} />
                <rect className="hx-brush-handle" x={win[0] - 3} y={brushTop + BRUSH_H / 2 - 9} width={6} height={18} />
                <rect className="hx-brush-handle" x={win[1] - 3} y={brushTop + BRUSH_H / 2 - 9} width={6} height={18} />
              </>
            )}
          </g>
        </svg>

        {readout && (
          <div className="hx-tooltip" style={{ left: tooltipLeft, top: M.top }} role="status">
            <div className="hx-tooltip-time">{formatDateTime(new Date(hoverT).toISOString())}</div>
            {readout.map(({ s, r }) => (
              <div key={s.id} className="hx-tooltip-row">
                <span className="hx-key" style={{ background: s.color }} aria-hidden="true" />
                <strong>{r && r.v !== null ? `${r.v.toFixed(2)} ft` : 'No reading'}</strong>
                <span className="hx-tooltip-name">
                  {s.name}
                  {r && showReadingTime ? ` · ${formatDateTime(r.t)}` : ''}
                  {r && r.q ? ` · ${r.q === 'v' ? 'verified' : 'preliminary'}` : ''}
                  {r ? flagNote(r.f) : ''}
                </span>
              </div>
            ))}
            <div className="hx-tooltip-units">{unitsLabel}</div>
          </div>
        )}
      </div>

      <p className="hx-chart-hint">
        <span className="hx-hint-fine">Drag across the chart, or Ctrl/Cmd + scroll, to zoom. Drag the strip below to pan. Double-click to reset.</span>
        <span className="hx-hint-coarse">Drag a finger along the chart to read values. Pinch to zoom, or drag the strip below to pan.</span>
      </p>
    </div>
  );
}
