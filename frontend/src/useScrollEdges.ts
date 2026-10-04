import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Which edges of a sideways-scrolling strip have more of it hidden past them.
 *
 * For the strips that scroll rather than wrap - the search results' tabs, and
 * the tag bar on a phone - so each can fade the edge that has more behind it
 * instead of looking clipped. Measured again whenever `deps` changes, on
 * resize, and on the strip's own scroll, which the caller wires up by passing
 * `measure` as its onScroll.
 */
export function useScrollEdges(deps: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  useLayoutEffect(measure, [measure, deps]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return { ref, edges, measure };
}
