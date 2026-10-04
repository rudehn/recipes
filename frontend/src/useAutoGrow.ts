import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A ref for a textarea that keeps it as tall as what is written in it.
 *
 * Its stylesheet sets how far: `rows` is where it starts, since a height of
 * "auto" falls back to it, and a max-height is where it stops growing and
 * scrolls instead. CSS can do this alone with `field-sizing: content`, but
 * not yet in every browser the app is opened in, so it is measured here.
 *
 * Measured again when the window changes width as well as when the text
 * changes: the same words wrap onto more lines in a narrower field.
 */
export function useAutoGrow(value: string): RefObject<HTMLTextAreaElement> {
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const fit = () => {
      element.style.height = "auto";
      // scrollHeight leaves out the border, which a border-box height includes.
      const border = element.offsetHeight - element.clientHeight;
      element.style.height = `${element.scrollHeight + border}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [value]);

  return field;
}
