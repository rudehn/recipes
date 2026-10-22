import { useState } from "react";

import type { Label } from "../../api";
import { errorMessage } from "../../useLoad";

/**
 * The labels being chosen for a meal, before they are saved: which are
 * ticked, whether that differs from what the meal has, and a new label being
 * named, which is ticked as soon as it is made, since nobody makes a label
 * they do not mean to use.
 *
 * Shared by the desktop's checklist and the phone's sheet, which save the
 * choice in their own ways (when the checklist closes, when the sheet does).
 */
export function useLabelChoice({
  labels,
  chosen,
  onCreate,
}: {
  /** Every label there is to choose from. */
  labels: Label[];
  /** The meal's labels, by id, as it has them now. */
  chosen: number[];
  /** Makes a label, answering it, or rejecting with the reason it was refused. */
  onCreate: (name: string) => Promise<Label>;
}) {
  const [ticked, setTicked] = useState(() => new Set(chosen));
  // Labels made here, kept beside the ones given until the page's list
  // catches up with them.
  const [made, setMade] = useState<Label[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const all = [...labels, ...made.filter((m) => !labels.some((l) => l.id === m.id))];

  function toggle(id: number) {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  }

  /** Makes a label of the name typed, and ticks it; a refusal stays to be read. */
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
    }
  }

  /** Lets go of a name being typed, and of why the last one was refused. */
  function stopNaming() {
    setDraft("");
    setError(null);
  }

  return {
    /** Every label to show: the ones given, then any made here since. */
    all,
    ticked,
    /** The ticked labels' ids, in order, as a write sends them. */
    ids: [...ticked].sort((a, b) => a - b),
    /** Whether the ticked labels are other than the meal's own. */
    changed: ticked.size !== chosen.length || chosen.some((id) => !ticked.has(id)),
    toggle,
    draft,
    setDraft,
    error,
    creating,
    create,
    stopNaming,
  };
}

export type LabelChoice = ReturnType<typeof useLabelChoice>;
