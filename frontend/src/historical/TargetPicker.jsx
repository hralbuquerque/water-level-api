/**
 * Searchable dropdown ("combobox") for choosing what to fetch: a named location
 * (all its gauges) or any single NOAA station. Follows the WAI-ARIA combobox
 * pattern, so it works with a keyboard and screen readers.
 */
import { useId, useMemo, useRef, useState } from 'react';

// Cap on rendered options; rendering all ~300 stations on every keystroke is wasteful
const MAX_SHOWN = 60;

/**
 * Searchable picker over named locations (e.g. New York City) and every NOAA
 * water-level station. `value` is a key like "location:nyc" or "station:8518750".
 */
export default function TargetPicker({ locations, stations, value, onChange, disabled }) {
  const listId = useId();
  const inputRef = useRef(null);
  // `query` is null when not typing: the input then shows the selected option's name.
  // While focused it holds what the user typed ('' shows every option).
  const [query, setQuery] = useState(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0); // index in `shown` highlighted by keyboard or mouse

  // One flat list, locations first. `haystack` is the lower-cased text searched:
  // a location also matches its gauges' names and IDs, so "Battery" finds New York City.
  const options = useMemo(
    () => [
      ...locations.map((l) => ({
        key: `location:${l.id}`,
        group: 'Locations',
        label: l.name,
        detail: `${l.stations.length} gauges: ${l.stations.map((s) => s.name).join(', ')}`,
        haystack: `${l.name} ${l.id} ${l.stations.map((s) => `${s.name} ${s.id}`).join(' ')}`.toLowerCase(),
      })),
      ...stations.map((s) => ({
        key: `station:${s.id}`,
        group: 'Stations',
        label: s.name,
        detail: [s.state, s.id].filter(Boolean).join(' · '),
        haystack: `${s.name} ${s.state ?? ''} ${s.id}`.toLowerCase(),
      })),
    ],
    [locations, stations],
  );

  const selected = options.find((o) => o.key === value);

  // Every word typed must appear somewhere in the option ("sandy nj" finds Sandy Hook)
  const matches = useMemo(() => {
    const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length ? options.filter((o) => terms.every((t) => o.haystack.includes(t))) : options;
  }, [options, query]);
  const shown = matches.slice(0, MAX_SHOWN);

  const choose = (opt) => {
    onChange(opt.key);
    setQuery(null);
    setOpen(false);
    inputRef.current?.blur();
  };

  // Arrow keys move the highlight (wrapping around), Enter picks it, Escape closes
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => {
        const n = shown.length;
        if (!n) return 0;
        return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      });
    } else if (e.key === 'Enter') {
      if (open && shown[active]) {
        e.preventDefault();
        choose(shown[active]);
      }
    } else if (e.key === 'Escape') {
      setQuery(null);
      setOpen(false);
    }
  };

  // Tracks the group of the previous option while rendering, to insert a heading
  // ("Locations", "Stations") where the group changes
  let lastGroup = null;
  return (
    <div className="hx-picker">
      {/* Option box, as on the "Build a bond" page: the choice as a title, a description
          line under it, and a caret. Clicking anywhere in the box focuses the search. */}
      <div
        className={`hx-optbox hl${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
        onMouseDown={(e) => {
          // Keep focus in the input when clicking the box's padding or caret
          if (e.target !== inputRef.current) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
      <input
        ref={inputRef}
        id="hx-target"
        className="hx-optbox-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={selected ? selected.label : 'Search a city, gauge name, state or station ID'}
        value={query ?? (selected ? selected.label : '')}
        // Clear the box on focus so typing starts a fresh search; the current choice
        // stays visible as the placeholder
        onFocus={() => {
          setQuery('');
          setActive(0);
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        // Leaving without picking restores the current choice
        onBlur={() => {
          setQuery(null);
          setOpen(false);
        }}
        onKeyDown={onKeyDown}
      />
        <span className="hx-optbox-detail" aria-hidden="true">
          {query
            ? `${matches.length.toLocaleString()} ${matches.length === 1 ? 'match' : 'matches'}`
            : selected?.detail ?? (disabled ? 'Loading stations…' : 'Search a city, gauge name, state or station ID')}
        </span>
        <svg className="hx-optbox-caret" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {open && (
        <ul className="hx-listbox" id={listId} role="listbox">
          {shown.length === 0 && <li className="hx-option-empty">No location or station matches “{query}”.</li>}
          {shown.map((opt, i) => {
            const header = opt.group !== lastGroup ? opt.group : null;
            lastGroup = opt.group;
            return [
              header && (
                <li key={`h-${header}`} className="hx-option-group" role="presentation">
                  {header}
                </li>
              ),
              <li
                key={opt.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={opt.key === value}
                className={`hx-option${i === active ? ' is-active' : ''}`}
                // preventDefault keeps focus in the input, so blur doesn't close the
                // list before the click lands
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(opt)}
              >
                <span className="hx-option-label">{opt.label}</span>
                <span className="hx-option-detail">{opt.detail}</span>
              </li>,
            ];
          })}
          {matches.length > MAX_SHOWN && (
            <li className="hx-option-empty" role="presentation">
              {(matches.length - MAX_SHOWN).toLocaleString()} more. Keep typing to narrow down.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
