import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, type RecipeSummary } from "../api";
import { RecipePhoto, TimeChips } from "../components/RecipeBits";

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<RecipeSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);

  useEffect(() => {
    api.listRecipes().then(setRecipes).catch(() => setRecipes([]));
  }, []);

  const allTags = useMemo(
    () => [...new Set((recipes ?? []).flatMap((r) => r.tags))].sort(),
    [recipes],
  );

  const filtered = useMemo(() => {
    if (!recipes) return [];
    const q = query.trim().toLowerCase();
    return recipes.filter((r) => {
      if (activeTag && !r.tags.includes(activeTag)) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.tags.some((t) => t.includes(q)) ||
        r.ingredient_names.some((n) => n.toLowerCase().includes(q))
      );
    });
  }, [recipes, query, activeTag]);

  return (
    <>
      <div className="page-head">
        <h1>Recipes</h1>
        <span className="sub">{recipes ? `${recipes.length} saved` : ""}</span>
        <span className="spacer" />
        <div className="toolbar">
          <input
            className="searchbar"
            placeholder="Search recipes or ingredients…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Link to="/recipes/new" className="btn primary">
            + New recipe
          </Link>
        </div>
      </div>

      {allTags.length > 0 && (
        <div className="tag-filter">
          <button
            className={`tag-pill${activeTag === null ? " active" : ""}`}
            onClick={() => setActiveTag(null)}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`tag-pill${activeTag === tag ? " active" : ""}`}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {recipes && recipes.length === 0 && (
        <div className="empty-state">
          <div className="glyph">🍳</div>
          <h2>Your recipe box is empty</h2>
          <p>Add your first recipe and start planning meals.</p>
          <p>
            <Link to="/recipes/new" className="btn primary">
              + New recipe
            </Link>
          </p>
        </div>
      )}

      <div className="recipe-grid">
        {filtered.map((r) => (
          <Link to={`/recipes/${r.id}`} key={r.id} className="recipe-card">
            <RecipePhoto recipe={r} />
            <div className="body">
              <h3>{r.title}</h3>
              {r.description && <p className="desc">{r.description}</p>}
              <TimeChips recipe={r} />
            </div>
          </Link>
        ))}
      </div>

      {recipes && recipes.length > 0 && filtered.length === 0 && (
        <div className="empty-state">
          <div className="glyph">🔍</div>
          <h2>No matches</h2>
          <p>
            No recipes match
            {query ? ` “${query}”` : ""}
            {activeTag ? ` with tag “${activeTag}”` : ""}.
          </p>
        </div>
      )}
    </>
  );
}
