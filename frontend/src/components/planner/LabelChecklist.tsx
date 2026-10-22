import { useEffect, useId, useRef, useState } from "react";

import type { Label } from "../../api";
import { Button } from "../ui";
import { errorMessage } from "../../useLoad";

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
  const [ticked, setTicked] = useState(() => new Set(chosen));
  // Labels made here, kept beside the ones given: the parent's list only
  // catches up when it next loads.
  const [made, setMade] = useState<Label[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const all = [...labels, ...made.filter((m) => !labels.some((l) => l.id === m.id))];

  // The newest set, for the close handlers below, which outlive a render.
  const latest = useRef({ ticked, chosen, onDone, onClose });
  useEffect(() => {
    latest.current = { ticked, chosen, onDone, onClose };
  });
  const finished = useRef(false);

  function finish() {
    if (finished.current) return;
    finished.current = true;
    const { ticked, chosen, onDone, onClose } = latest.current;
    const same = ticked.size === chosen.length && chosen.every((id) => ticked.has(id));
    if (!same) onDone([...ticked].sort((a, b) => a - b));
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

  function toggle(id: number) {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  }

  async function create() {
    const name = draft.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const label = await onCreate(name);
      setMade((m) => [...m, label]);
      setTicked((t) => new Set(t).add(label.id));
      setDraft("");
    } catch (cause) {
      setError(errorMessage(cause, "Could not make that label."));
    } finally {
      setCreating(false);
      field.current?.focus();
    }
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
      {all.length > 0 && (
        <ul>
          {all.map((l) => (
            <li key={l.id}>
              <label>
                <input
                  type="checkbox"
                  checked={ticked.has(l.id)}
                  onChange={() => toggle(l.id)}
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
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void create();
          }
        }}
      />
      {error && (
        <p className="label-checklist-error" role="alert">
          {error}
        </p>
      )}
      <Button size="small" onClick={finish}>
        Done
      </Button>
    </div>
  );
}
