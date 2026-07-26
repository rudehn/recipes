import { useEffect, useMemo, useState } from "react";

import { api, imageUrl, type RecipeSummary } from "../api";

export function TimeChips({
  recipe,
}: {
  recipe: Pick<RecipeSummary, "prep_minutes" | "cook_minutes" | "servings">;
}) {
  const total = (recipe.prep_minutes ?? 0) + (recipe.cook_minutes ?? 0);
  return (
    <div className="chips">
      {total > 0 && <span className="chip accent">⏱ {total} min</span>}
      {recipe.servings != null && <span className="chip">Serves {recipe.servings}</span>}
    </div>
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
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.listRecipes().then(setRecipes).catch(() => setRecipes([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter((r) => r.title.toLowerCase().includes(q));
  }, [recipes, query]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-search">
          <input
            autoFocus
            placeholder="Search recipes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="modal-list">
          {filtered.map((r) => (
            <button key={r.id} className="modal-recipe" onClick={() => onPick(r)}>
              {r.image_filename ? (
                <img src={imageUrl(r.image_filename)!} alt="" />
              ) : (
                <span className="thumb-placeholder">🍽️</span>
              )}
              <span>{r.title}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p style={{ padding: "8px 10px", color: "var(--muted)" }}>
              No recipes found.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
