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

  useEffect(() => {
    const root = dialog.current;

    // Only pull focus in if nothing inside has claimed it already, so a child
    // marked autoFocus still wins - it knows better than we do which control
    // the user came here to use.
    if (root && !root.contains(document.activeElement)) {
      root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
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
      // Guarded: the trigger may itself have been removed by whatever the
      // dialog just did, and focusing a detached node silently does nothing.
      if (returnTo && document.body.contains(returnTo)) returnTo.focus();
    };
  }, [onClose, returnTo]);

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
