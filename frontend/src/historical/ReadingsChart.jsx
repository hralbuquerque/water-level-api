/**
 * The readings page's line chart: one line per gauge, drawn as plain SVG.
 *
 * Built by hand rather than with a chart library because it has to stay fast with
 * ~260k points (a year of 6-minute data at three gauges) and must never smooth away
 * a storm peak, which matters more here than anything a library would add.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { formatDateTime, niceTicks, timeTicks } from './time.js';

const HEIGHT = 340; // px; the width follows the container
const M = { top: 16, right: 20, bottom: 34, left: 52 }; // margins around the plot for axis labels

/** Index of the reading nearest to time t (readings sorted by time). Binary search, O(log n). */
function nearestIndex(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

/**
 * SVG path for one series, decimated to the min and max reading per pixel column
 * (in time order) so peaks survive however many points there are. The line breaks
 * at missing values and at gaps longer than `gapMs`.
 */
function buildPath(times, values, x, y, gapMs) {
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

  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    // A missing value lifts the pen, so the line shows a gap instead of bridging it
    if (v === null) {
      flush();
      penDown = false;
      col = null;
      continue;
    }
    // So does a jump in time, e.g. a gauge that was offline for weeks
    if (i > 0 && times[i] - times[i - 1] > gapMs) {
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

/**
 * Multi-gauge water-level line chart with a crosshair readout.
 *
 * @param {Object} props
 * @param {Array<{ id, name, color, times: number[], values: (number|null)[], readings: Array }>} props.series
 * @param {[number, number]} props.domain - x domain in ms (the requested range)
 * @param {number|null} props.trigger - optional trigger level, ft
 * @param {number} props.stepMs - expected spacing between readings
 * @param {string} props.valueLabel - e.g. "Water level" or "Daily max"
 * @param {boolean} [props.showReadingTime] - show each reading's own time (daily max happens at a time of its own)
 */
export default function ReadingsChart({ series, domain, trigger, stepMs, valueLabel, showReadingTime = false }) {
  const [width, setWidth] = useState(0); // 0 until the container has been measured
  const [hoverT, setHoverT] = useState(null); // time (ms) under the pointer or keyboard cursor, or null

  // Measure the container whenever it mounts, and follow its size after that.
  // A callback ref (rather than useRef + useEffect) also catches the container
  // appearing later, e.g. after an empty result is replaced by real data.
  const observer = useRef(null);
  const wrapRef = useCallback((el) => {
    observer.current?.disconnect();
    if (!el) return;
    const measure = () => setWidth(Math.max(260, Math.floor(el.clientWidth - 8)));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);

  // Everything that depends on the data or the size: scales, ticks, paths and the peak.
  // Recomputed only when those change, not on every hover.
  const layout = useMemo(() => {
    const [t0, t1] = domain; // the requested range, so missing coverage shows as empty space
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (v === null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (trigger !== null) {
      lo = Math.min(lo, trigger);
      hi = Math.max(hi, trigger);
    }
    if (!Number.isFinite(lo)) return null;
    const yTicks = niceTicks(lo, hi, 6);
    const yLo = yTicks[0];
    const yHi = yTicks[yTicks.length - 1] === yLo ? yLo + 1 : yTicks[yTicks.length - 1];
    const plotW = width - M.left - M.right;
    const plotH = HEIGHT - M.top - M.bottom;
    // Scales: time (ms) -> px from the left, feet -> px from the top
    const x = (t) => M.left + ((t - t0) / (t1 - t0)) * plotW;
    const y = (v) => M.top + (1 - (v - yLo) / (yHi - yLo)) * plotH;
    const xt = timeTicks(t0, t1, Math.max(2, Math.floor(plotW / 110)));
    // Break a line where readings are more than 2.5 intervals apart (a real gap, not jitter)
    const paths = series.map((s) => buildPath(s.times, s.values, x, y, stepMs * 2.5));

    // Direct-label only the single highest reading across all gauges
    let peak = null;
    for (const s of series) {
      s.values.forEach((v, i) => {
        if (v !== null && (!peak || v > peak.v)) peak = { v, t: s.times[i], name: s.name };
      });
    }
    return { t0, t1, x, y, yTicks, xt, plotW, plotH, paths, peak };
  }, [series, domain, trigger, width, stepMs]);

  if (!layout) {
    return <p className="hx-empty">No readings with a value in this range.</p>;
  }
  // First render: draw an empty frame of the right height so it can be measured without a layout jump
  if (!width) return <div className="hx-chart" ref={wrapRef} style={{ height: HEIGHT + 12 }} />;

  const { t0, t1, x, y, yTicks, xt, plotW, plotH, paths, peak } = layout;
  const toT = (px) => t0 + ((px - M.left) / plotW) * (t1 - t0);

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
          return { s, r: near ? s.readings[i] : null, i: near ? i : null };
        });

  // Convert the pointer position to a time. The SVG can be scaled by CSS, so map
  // through its on-screen size rather than using offsetX directly.
  const onPointer = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    setHoverT(px < M.left || px > M.left + plotW ? null : toT(px));
  };
  // Keyboard equivalent of hovering: arrows move the cursor 1% of the range, Escape hides it
  const onKey = (e) => {
    const step = (t1 - t0) / 100;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const base = hoverT ?? (e.key === 'ArrowRight' ? t0 : t1);
      setHoverT(Math.min(t1, Math.max(t0, base + (e.key === 'ArrowRight' ? step : -step))));
    } else if (e.key === 'Escape') {
      setHoverT(null);
    }
  };

  // Tooltip sits right of the crosshair, flipping to the left near the right edge
  const hx = hoverT === null ? null : x(hoverT);
  const tooltipLeft = hx === null ? 0 : Math.min(Math.max(hx + 12, 0), width - 230);
  const tooltipFlip = hx !== null && hx + 12 + 230 > width;

  return (
    <div className="hx-chart" ref={wrapRef}>
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="application"
        aria-label={`${valueLabel} chart. Use left and right arrow keys to move through time.`}
        tabIndex={0}
        onPointerMove={onPointer}
        onPointerLeave={() => setHoverT(null)}
        onKeyDown={onKey}
        onBlur={() => setHoverT(null)}
      >
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
            <line className="hx-trigger" x1={M.left} x2={M.left + plotW} y1={y(trigger)} y2={y(trigger)} />
            <text className="hx-trigger-label" x={M.left + 8} y={y(trigger) - 6}>
              Trigger {trigger.toFixed(2)} ft
            </text>
          </g>
        )}

        {/* Series */}
        {paths.map((d, i) => (
          <path key={series[i].id} d={d} className="hx-line" style={{ stroke: series[i].color }} />
        ))}

        {/* Peak label: only the single highest reading is labelled, and it hides while hovering */}
        {peak && hoverT === null && (
          <g>
            <circle className="hx-dot" cx={x(peak.t)} cy={y(peak.v)} r={4} style={{ fill: series.find((s) => s.name === peak.name)?.color }} />
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
      </svg>

      {readout && (
        <div
          className="hx-tooltip"
          style={{ left: tooltipFlip ? Math.max(0, hx - 12 - 230) : tooltipLeft, top: M.top }}
          role="status"
        >
          <div className="hx-tooltip-time">{formatDateTime(new Date(hoverT).toISOString())}</div>
          {readout.map(({ s, r }) => (
            <div key={s.id} className="hx-tooltip-row">
              <span className="hx-key" style={{ background: s.color }} aria-hidden="true" />
              <strong>{r && r.v !== null ? `${r.v.toFixed(2)} ft` : 'No reading'}</strong>
              <span className="hx-tooltip-name">
                {s.name}
                {r && showReadingTime ? ` · ${formatDateTime(r.t)}` : ''}
                {r && r.q ? ` · ${r.q === 'v' ? 'verified' : 'preliminary'}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
