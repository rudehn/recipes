import { useCallback, useState } from "react";

import { api, imageUrl, type RecipeSummary } from "../api";
import { useDebounced } from "../useDebounced";
import { useLoad } from "../useLoad";
import { Chip, Chips, Modal } from "./ui";

/** How many matches the picker shows before asking for a narrower search. */
const PICKER_LIMIT = 20;

export function TimeChips({
  recipe,
}: {
  recipe: Pick<RecipeSummary, "prep_minutes" | "cook_minutes" | "servings">;
}) {
  const total = (recipe.prep_minutes ?? 0) + (recipe.cook_minutes ?? 0);
  return (
    <Chips>
      {total > 0 && <Chip tone="accent">⏱ {total} min</Chip>}
      {recipe.servings != null && <Chip>Serves {recipe.servings}</Chip>}
    </Chips>
  );
}

export function RecipePhoto({
  recipe,
  className = "photo",
}: {
  recipe: Pick<RecipeSummary, "image_filename" | "title">;
  className?: string;
}) {
  const url = imageUrl(recipe.image_filename);
  if (url) return <img className={className} src={url} alt={recipe.title} />;
  return (
    <div className="photo-placeholder" aria-hidden>
      🍽️
    </div>
  );
}

export function RecipePickerModal({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (recipe: RecipeSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  // A modal paging through recipes would be a worse way to find one than
  // typing, so it shows the first screenful of matches and asks for more
  // letters instead of a page number.
  const { data: matches, error } = useLoad(
    useCallback(() => api.listRecipes({ q: search, per_page: PICKER_LIMIT }), [search]),
  );

  const found = matches?.items ?? [];
  const hidden = (matches?.total ?? 0) - found.length;

  // Escape, the focus trap and the focus restore belong to Modal.
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-search">
        <input
          autoFocus
          placeholder="Search recipes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="modal-list">
        {found.map((r) => (
          <button key={r.id} className="modal-recipe" onClick={() => onPick(r)}>
            {r.image_filename ? (
              <img src={imageUrl(r.image_filename)!} alt="" />
            ) : (
              <span className="thumb-placeholder">🍽️</span>
            )}
            <span>{r.title}</span>
          </button>
        ))}
        {found.length === 0 && (
          <p className="modal-note">
            {error ? `Could not load your recipes. ${error}` : "No recipes found."}
          </p>
        )}
        {hidden > 0 && (
          <p className="modal-note">
            {hidden} more {hidden === 1 ? "match" : "matches"} - keep typing to narrow.
          </p>
        )}
      </div>
    </Modal>
  );
}
