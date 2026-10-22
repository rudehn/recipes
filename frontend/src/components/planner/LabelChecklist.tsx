import { useEffect, useId, useRef } from "react";

import type { Label } from "../../api";
import { Button } from "../ui";
import { useLabelChoice } from "./useLabelChoice";

/**
 * The labels to put on a meal, as checkboxes, with a field to make a new one.
 *
 * Nothing is saved while boxes are ticked. `onDone` runs once, when the
 * checklist closes (Escape, a press outside it, a Tab out of it, or Done),
 * and only if the set of labels changed - so ticking Dad and Kids is one
 * write rather than two, and a look with no change is none.
 *
 * `onCreate` makes the label on the server and answers it; the new label is
 * ticked at once, since nobody makes a label they do not mean to use.
 */
export function LabelChecklist({
  labels,
  chosen,
  onCreate,
  onDone,
  onClose,
}: {
  labels: Label[];
  chosen: number[];
  onCreate: (name: string) => Promise<Label>;
  onDone: (ids: number[]) => void;
  /** However it closed, changed or not, so the parent can take it down. */
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const choice = useLabelChoice({ labels, chosen, onCreate });

  // The newest choice, for the close handlers below, which outlive a render.
  const latest = useRef({ choice, onDone, onClose });
  useEffect(() => {
    latest.current = { choice, onDone, onClose };
  });
  const finished = useRef(false);

  function finish() {
    if (finished.current) return;
    finished.current = true;
    const { choice, onDone, onClose } = latest.current;
    if (choice.changed) onDone(choice.ids);
    onClose();
  }

  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input")?.focus();
    function onPointerDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) finish();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        finish();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  async function create() {
    await choice.create();
    field.current?.focus();
  }

  return (
    <div
      className="label-checklist"
      role="group"
      aria-label="Labels"
      ref={root}
      onBlur={(e) => {
        // Tabbing out of the checklist closes it like a press outside does.
        if (e.relatedTarget && !root.current?.contains(e.relatedTarget)) finish();
      }}
    >
      {choice.all.length > 0 && (
        <ul>
          {choice.all.map((l) => (
            <li key={l.id}>
              <label>
                <input
                  type="checkbox"
                  checked={choice.ticked.has(l.id)}
                  onChange={() => choice.toggle(l.id)}
                />
                {l.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      <label className="visually-hidden" htmlFor={fieldId}>
        New label
      </label>
      <input
        id={fieldId}
        ref={field}
        placeholder="New label…"
        maxLength={40}
        value={choice.draft}
        onChange={(e) => choice.setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void create();
          }
        }}
      />
      {choice.error && (
        <p className="label-checklist-error" role="alert">
          {choice.error}
        </p>
      )}
      <Button size="small" onClick={finish}>
        Done
      </Button>
    </div>
  );
}
