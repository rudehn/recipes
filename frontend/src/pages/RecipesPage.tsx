import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, type RecipeSummary } from "../api";
import { RecipePhoto, TimeChips } from "../components/RecipeBits";

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<RecipeSummary[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.listRecipes().then(setRecipes).catch(() => setRecipes([]));
  }, []);

  const filtered = useMemo(() => {
    if (!recipes) return [];
    const q = query.trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter(
      (r) =>
        r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
    );
  }, [recipes, query]);

  return (
    <>
      <div className="page-head">
        <h1>Recipes</h1>
        <span className="sub">{recipes ? `${recipes.length} saved` : ""}</span>
        <span className="spacer" />
        <div className="toolbar">
          <input
            className="searchbar"
            placeholder="Search recipes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Link to="/recipes/new" className="btn primary">
            + New recipe
          </Link>
        </div>
      </div>

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
          <p>No recipes match “{query}”.</p>
        </div>
      )}
    </>
  );
}
