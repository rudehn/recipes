import { useCallback, useMemo, useState } from "react";

import {
  api,
  type Conflict,
  type FoodSide,
  type IngredientSummary,
  type MergeChoices,
  type MergeNeed,
  type MergePreview,
  type MergeSide,
  type ProductSide,
  type StapleSide,
} from "../api";
import { matchesSearch, proposeDirection } from "../ingredients";
import { useLoad } from "../useLoad";
import { Banner, Button, Modal } from "./ui";

export interface Merged {
  fromKey: string;
  fromName: string;
  toKey: string;
  toName: string;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Saying two names are one ingredient: find the other, see what changes, merge.
 *
 * Nothing changes until Merge is pressed. The preview is the server's, so
 * what it says will move is what the merge moves, and the choices it asks
 * for are exactly the ones the merge would refuse without (ADR 10).
 */
export function MergeDialog({
  ingredient,
  pair,
  onMerged,
  onClose,
}: {
  /** The ingredient whose page the dialog was opened from. */
  ingredient: IngredientSummary;
  /** A suggested pair to preview straight away, [from, to]. */
  pair?: readonly [string, string];
  onMerged: (merged: Merged) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<readonly [string, string] | null>(pair ?? null);
  const [query, setQuery] = useState("");
  const { data: listing } = useLoad(useCallback(() => api.listIngredients(), []));

  const candidates = useMemo(
    () =>
      (listing?.ingredients ?? []).filter(
        (i) => i.key !== ingredient.key && matchesSearch(i, query),
      ),
    [listing, ingredient.key, query],
  );

  function pick(other: IngredientSummary) {
    const [from, to] = proposeDirection(ingredient, other);
    setChosen([from.key, to.key]);
  }

  return (
    <Modal title={chosen ? "Merge" : "Same as another ingredient"} onClose={onClose}>
      {chosen ? (
        <div className="modal-body">
          <MergePreviewPanel
            // A new direction is a new question: remount so neither the old
            // preview nor answers to it can be acted on while the new one loads.
            key={`${chosen[0]}>${chosen[1]}`}
            pair={chosen}
            onSwap={() => setChosen([chosen[1], chosen[0]])}
            onMerged={onMerged}
            onCancel={onClose}
          />
        </div>
      ) : (
        <>
          <div className="modal-search">
            <input
              autoFocus
              aria-label="Find the ingredient"
              placeholder={`What else is “${ingredient.name}” called?`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="modal-list">
            {candidates.map((other) => (
              <button key={other.key} type="button" className="modal-food" onClick={() => pick(other)}>
                <span className="description">{other.name}</span>
              </button>
            ))}
            {listing && candidates.length === 0 && <p className="modal-note">No other ingredient matches that.</p>}
          </div>
        </>
      )}
    </Modal>
  );
}

function MergePreviewPanel({
  pair,
  onSwap,
  onMerged,
  onCancel,
}: {
  pair: readonly [string, string];
  onSwap: () => void;
  onMerged: (merged: Merged) => void;
  onCancel: () => void;
}) {
  const [from, to] = pair;
  const { data: preview, error } = useLoad(useCallback(() => api.previewMerge(from, to), [from, to]));
  const [choices, setChoices] = useState<MergeChoices>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!preview) return <p className="modal-note">Looking…</p>;

  const ready = preview.needs.every((need) => choices[need] !== undefined);

  async function merge() {
    setMerging(true);
    setFailure(null);
    try {
      await api.merge(from, to, choices);
      onMerged({ fromKey: from, fromName: preview!.from_name, toKey: to, toName: preview!.to_name });
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "That did not go through.");
      setMerging(false);
    }
  }

  return (
    <div className="merge-preview">
      <div className="merge-head">
        <p className="merge-title">
          Merge {preview.from_name} into {preview.to_name}
        </p>
        <Button size="small" onClick={onSwap}>
          Swap
        </Button>
      </div>

      <ul className="merge-changes">
        {preview.recipes.length > 0 && (
          <li>
            {preview.recipes.map((r) => r.title).join(", ")}{" "}
            {preview.recipes.length === 1 ? "keeps" : "keep"} saying “{preview.from_name}”, and{" "}
            {preview.recipes.length === 1 ? "shops" : "shop"} as {preview.to_name}.
          </li>
        )}
        <li>
          One grocery line, {preview.to_name}, instead of two.
        </li>
        <ConflictLine label="Product" need="product" preview={preview} describe={describeProduct} choices={choices} setChoices={setChoices} />
        <ConflictLine label="Food" need="food" preview={preview} describe={describeFood} choices={choices} setChoices={setChoices} />
        <ConflictLine label="Staple" need="staple" preview={preview} describe={describeStaple} choices={choices} setChoices={setChoices} />
      </ul>

      {failure && <Banner tone="error">{failure}</Banner>}

      <div className="modal-actions">
        <Button variant="primary" onClick={merge} disabled={!ready || merging}>
          Merge
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

type Describe<T> = (side: T) => string;

const describeProduct: Describe<ProductSide> = (side) =>
  side.not_priced
    ? "not priced"
    : `${side.product ? `${side.product.description} ${money(side.product.promo ?? side.product.regular)}` : "a product"}${side.hand_picked ? " (your pick)" : ""}`;

const describeFood: Describe<FoodSide> = (side) =>
  side.skipped ? "doesn't count" : `${side.food?.description ?? "a food"}${side.hand_picked ? " (your choice)" : ""}`;

const describeStaple: Describe<StapleSide> = (side) =>
  `${side.name}, ${side.in_stock ? "in stock" : "out of stock"}`;

function ConflictLine<T>({
  label,
  need,
  preview,
  describe,
  choices,
  setChoices,
}: {
  label: string;
  need: MergeNeed;
  preview: MergePreview;
  describe: Describe<T>;
  choices: MergeChoices;
  setChoices: (next: MergeChoices) => void;
}) {
  const conflict = preview[need] as Conflict<T> | null;
  if (!conflict) return null;
  const sides: [MergeSide, T | null][] = [
    ["from", conflict.from_side],
    ["to", conflict.to_side],
  ];

  if (conflict.keeps === null) {
    return (
      <li>
        <fieldset className="merge-choice">
          <legend>Which {need} to keep?</legend>
          {sides.map(([side, value]) =>
            value === null ? null : (
              <label key={side}>
                <input
                  type="radio"
                  name={need}
                  checked={choices[need] === side}
                  onChange={() => setChoices({ ...choices, [need]: side })}
                />
                {describe(value)}
              </label>
            ),
          )}
        </fieldset>
      </li>
    );
  }
  const [kept, other] =
    conflict.keeps === "from" ? [conflict.from_side, conflict.to_side] : [conflict.to_side, conflict.from_side];
  if (kept === null) return null;
  // Two names can hold the same thing - both matched the same product on
  // their own - and then nothing is being chosen over anything.
  const over = other === null || describe(other) === describe(kept) ? "" : `, kept over ${describe(other)}`;
  return (
    <li>
      {label}: {describe(kept)}
      {over}
    </li>
  );
}
