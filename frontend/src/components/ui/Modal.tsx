import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { IconButton } from "./Button";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * A modal dialog.
 *
 * Deliberately built from divs rather than <dialog>: jsdom 29 ships
 * HTMLDialogElement but not showModal(), so the native element cannot be
 * driven by the tests that cover this. The behaviour showModal() would have
 * given for free is therefore written out here - the focus trap, the focus
 * restore, and the escape key.
 *
 * Focus goes in on open and back where it came from on close. Without the
 * restore, dismissing the picker drops focus onto <body> and a keyboard user
 * starts again from the top of the page.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Captured during the first render, which is the last moment it is still
  // correct: React applies a child's autoFocus while committing, so by the
  // time an effect runs document.activeElement is already inside the dialog
  // and whatever opened it has been lost.
  const [returnTo] = useState(() => document.activeElement as HTMLElement | null);
  // The latest onClose, read when it is needed. A page passes a new one on
  // every render, and the effect below must not run again for it: its
  // cleanup hands focus back to the trigger, which would pull it out of the
  // field being typed in whenever the page behind happened to re-render.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // What had focus inside the dialog when the effect below was last cleaned
  // up while the dialog stayed, which in development StrictMode does once on
  // every open: without it the second run found focus back on the trigger and
  // moved it to the Close button, away from the field marked autoFocus.
  const focusedInside = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = dialog.current;

    // Only pull focus in if nothing inside has claimed it already, so a child
    // marked autoFocus still wins - it knows better than we do which control
    // the user came here to use.
    if (root && !root.contains(document.activeElement)) {
      const before = focusedInside.current;
      (before && root.contains(before)
        ? before
        : root.querySelector<HTMLElement>(FOCUSABLE)
      )?.focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Not an Escape already spent inside the dialog, closing a search's
        // suggestions or a list of its own.
        if (!event.defaultPrevented) close.current();
        return;
      }
      if (event.key !== "Tab" || !root) return;

      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped entirely.
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (root?.contains(document.activeElement)) {
        focusedInside.current = document.activeElement as HTMLElement;
      }
      // Guarded: the trigger may itself have been removed by whatever the
      // dialog just did, and focusing a detached node silently does nothing.
      if (returnTo && document.body.contains(returnTo)) returnTo.focus();
    };
  }, [returnTo]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 id={titleId}>{title}</h3>
          <IconButton label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}
