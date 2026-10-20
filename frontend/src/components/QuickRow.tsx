import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { TagCount } from "../api";
import { chipsThatFit } from "../chipFit";

/** How many tags the row offers before the rest are left to All tags. */
const QUICK_TAGS = 4;

/**
 * The row of quick picks under the search box: the tags the owner searches
 * for most, On sale, and All tags for the rest.
 *
 * `tags` arrive in the order to offer them and without the ones already
 * picked. Always one line, and never scrolling sideways: On sale and All
 * tags are the row's tail and keep their room, and a tag that would not fit
 * beside them is left to All tags (see chipFit, which does the same for a
 * card's tags). Every candidate stays rendered, the ones not shown laid out
 * out of sight as "spare", so the row can be measured again whenever it
 * changes width.
 */
export function QuickRow({
  tags,
  onSale,
  saleSelected,
  onPickTag,
  onPickSale,
}: {
  tags: TagCount[];
  onSale: number | null;
  saleSelected: boolean;
  onPickTag: (name: string) => void;
  onPickSale: () => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  // A tag that would leave nothing is not worth offering on the row.
  const candidates = useMemo(
    () => tags.filter((tag) => tag.count > 0).slice(0, QUICK_TAGS),
    [tags],
  );
  const [kept, setKept] = useState(candidates.length);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = row.current;
    const tailEl = tail.current;
    if (!el || !tailEl) return;
    const measure = () => {
      const chips = [...el.querySelectorAll<HTMLElement>(".quick-tag")];
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      // The first chip may be squeezed (see .quick-tag:first-child), and it is
      // its name that is clipped, so add back what the name is cut by: the
      // fit must be judged on natural widths, or a row a little too narrow
      // for four tags would squeeze the first and wrongly keep all four.
      const widths = chips.map((chip) => {
        const name = chip.querySelector<HTMLElement>(".quick-name");
        const cut = name ? Math.max(0, name.scrollWidth - name.offsetWidth) : 0;
        return chip.offsetWidth + cut;
      });
      setKept(
        chipsThatFit({
          widths,
          total: widths.length,
          plus: 0,
          gap,
          room: el.clientWidth - tailEl.offsetWidth - gap,
        }),
      );
    };
    measure();
    // Absent under jsdom, which lays nothing out to measure anyway.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [candidates, onSale, saleSelected]);

  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "pointerdown" && wrap.current?.contains(e.target as Node)) return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const alphabetical = useMemo(
    () => [...tags].sort((a, b) => a.name.localeCompare(b.name)),
    [tags],
  );
  const showSale = onSale != null && onSale > 0 && !saleSelected;

  return (
    <div className="quick-row-wrap" ref={wrap}>
      <div className="quick-row" ref={row}>
        {candidates.map((tag, i) => {
          const spare = i >= kept;
          return (
            <button
              key={tag.name}
              type="button"
              className={spare ? "tag-pill quick-tag spare" : "tag-pill quick-tag"}
              aria-hidden={spare || undefined}
              tabIndex={spare ? -1 : undefined}
              onClick={() => onPickTag(tag.name)}
            >
              <span className="quick-name">{tag.name}</span>
              <span className="count">{tag.count}</span>
            </button>
          );
        })}
        <div className="quick-tail" ref={tail}>
          <span className="quick-divider" aria-hidden />
          {showSale && (
            <button type="button" className="tag-pill" onClick={onPickSale}>
              On sale
              <span className="count">{onSale}</span>
            </button>
          )}
          <button
            type="button"
            className="tag-pill"
            ref={toggle}
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            All tags ▾
          </button>
        </div>
      </div>
      {open && (
        <div className="quick-panel" role="group" aria-label="All tags">
          {alphabetical.map((tag) => (
            <button
              key={tag.name}
              type="button"
              className="tag-pill"
              disabled={tag.count === 0}
              onClick={() => {
                setOpen(false);
                onPickTag(tag.name);
              }}
            >
              {tag.name}
              <span className="count">{tag.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
