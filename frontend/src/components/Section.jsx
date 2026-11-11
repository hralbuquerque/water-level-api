import { useId, useState } from 'react';
import { Surface } from '../theme/Primitives.jsx';

/**
 * Numbered section card, after the "Build a bond" workshop page: a theme Surface
 * with a header row ("01  Deal parameters" + a × / + toggle), a hairline under
 * the header, and the content below.
 *
 * Collapsible sections can be uncontrolled (`defaultOpen`) or controlled
 * (`open` + `onToggle`), e.g. so an "Edit" link elsewhere can reopen one.
 * Collapsed sections don't render their children at all, which also keeps
 * heavy content (a big table) from being built until it's opened.
 *
 * @param {Object} props
 * @param {string|number} props.number - shown as a two-digit mono label ("01")
 * @param {string} props.title
 * @param {boolean} [props.collapsible=false]
 * @param {boolean} [props.defaultOpen=true]
 * @param {boolean} [props.open] - makes the section controlled
 * @param {(open: boolean) => void} [props.onToggle]
 * @param {string} [props.as='section'] - element for the card (e.g. 'form')
 */
export default function Section({
  number,
  title,
  collapsible = false,
  defaultOpen = true,
  open: openProp,
  onToggle,
  as = 'section',
  className = '',
  bodyClassName = '',
  children,
  ...props
}) {
  const bodyId = useId();
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const toggle = () => {
    setOpenState(!open);
    onToggle?.(!open);
  };

  return (
    <Surface as={as} className={`sec ${open ? 'is-open' : ''} ${className}`} {...props}>
      <header className="sec-head">
        <span className="sec-num">{String(number).padStart(2, '0')}</span>
        <h2 className="sec-title">{title}</h2>
        {collapsible && (
          <button
            type="button"
            className="sec-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            onClick={toggle}
          >
            {/* × when open, + when closed: the same two strokes, rotated */}
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={open ? 'is-x' : ''}>
              <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </header>
      {open && (
        <div className={`sec-body ${bodyClassName}`} id={bodyId}>
          {children}
        </div>
      )}
    </Surface>
  );
}

/** Uppercase sub-heading inside a section ("HISTORICAL", "YOUR LAYER"). */
export function SubLabel({ as: Comp = 'p', className = '', children, ...props }) {
  return (
    <Comp className={`sec-label ${className}`} {...props}>
      {children}
    </Comp>
  );
}
