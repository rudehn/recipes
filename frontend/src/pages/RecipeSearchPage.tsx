import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, type RecipeDraft } from "../api";
import { formatQuantity } from "../quantity";

function totalMinutes(draft: RecipeDraft): number | null {
  const total = (draft.prep_minutes ?? 0) + (draft.cook_minutes ?? 0);
  return total > 0 ? total : null;
}

/** Compact stat used to compare drafts at a glance, before reading either. */
function CompareStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="compare-stat">
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  );
}

/** Which edges of the tab strip have more tabs hidden past them. */
function useScrollEdges(deps: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  useLayoutEffect(measure, [measure, deps]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return { ref, edges, measure };
}

export default function RecipeSearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<RecipeDraft[] | null>(null);
  // The query these results came from, so editing the box mid-read does not
  // rewrite the message describing them.
  const [searched, setSearched] = useState("");
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ref: tabsRef, edges, measure } = useScrollEdges(drafts);

  async function handleSearch() {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError(null);
    setDrafts(null);
    try {
      const results = await api.searchRecipes(q);
      setDrafts(results);
      setSearched(q);
      setActive(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }

  // Nothing is saved until the form is submitted; this just prefills it.
  function pickDraft(draft: RecipeDraft) {
    navigate("/recipes/new", { state: { draft } });
  }

  const current = drafts?.[active];
  const steps = current
    ? current.instructions.split("\n").map((s) => s.trim()).filter(Boolean)
    : [];

  return (
    <>
      <div className="page-head">
        <h1>Find a recipe</h1>
        <span className="spacer" />
        <Link to="/recipes" className="btn">
          Back to recipes
        </Link>
      </div>

      <div className="import-box">
        <div className="import-row">
          <input
            autoFocus
            placeholder="What do you want to cook? e.g. banana bread"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSearch();
              }
            }}
          />
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSearch()}
            disabled={searching || query.trim().length < 2}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>
        <span className="hint">
          Searches a handful of trusted cooking sites and pulls in each recipe so
          you can compare them side by side. Nothing is saved until you pick one.
        </span>
        {error && <div className="error-banner">{error}</div>}
      </div>

      {searching && (
        <div className="empty-state">
          <div className="glyph">🥣</div>
          <h2>Gathering recipes…</h2>
          <p>Reading a few cooking sites at once.</p>
        </div>
      )}

      {drafts && drafts.length > 0 && current && (
        <>
          <div className="result-tabs-header">
            <span className="count">
              {drafts.length} recipes found - pick one to compare
            </span>
            <div
              className={`result-tabs-wrap${edges.left ? " fade-left" : ""}${
                edges.right ? " fade-right" : ""
              }`}
            >
              <div
                className="result-tabs"
                role="tablist"
                aria-label="Search results"
                ref={tabsRef}
                onScroll={measure}
              >
                {drafts.map((draft, i) => (
                  <button
                    key={draft.source_url}
                    role="tab"
                    aria-selected={i === active}
                    className={`result-tab${i === active ? " active" : ""}`}
                    onClick={() => setActive(i)}
                  >
                    <span className="site">{draft.source_label}</span>
                    <span className="name">{draft.title}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="preview-banner">
            <span className="chip green">Preview</span>
            <span>
              From{" "}
              <a href={current.source_url} target="_blank" rel="noreferrer noopener">
                {current.source_label}
              </a>
              . Not saved yet.
            </span>
            <span className="spacer" />
            <button className="btn primary" onClick={() => pickDraft(current)}>
              Use this recipe
            </button>
          </div>

          <div className="detail-hero">
            {current.image_url ? (
              <img className="photo" src={current.image_url} alt={current.title} />
            ) : (
              <div className="photo-placeholder" aria-hidden>
                🍽️
              </div>
            )}
            <div>
              <h2>{current.title}</h2>
              {current.description && <p>{current.description}</p>}
              <div className="compare-row">
                <CompareStat
                  label="ingredients"
                  value={String(current.ingredients.length)}
                />
                <CompareStat
                  label="steps"
                  value={String(steps.length)}
                />
                <CompareStat
                  label="total time"
                  value={totalMinutes(current) ? `${totalMinutes(current)} min` : "-"}
                />
                <CompareStat
                  label="serves"
                  value={current.servings != null ? String(current.servings) : "-"}
                />
              </div>
            </div>
          </div>

          <div className="detail-cols">
            <div className="panel">
              <h2>Ingredients</h2>
              <ul className="ingredient-list">
                {current.ingredients.map((ing, i) => (
                  <li key={i}>
                    <span className="qty">{formatQuantity(ing.quantity, ing.unit)}</span>
                    <span>{ing.name}</span>
                  </li>
                ))}
                {current.ingredients.length === 0 && (
                  <li style={{ color: "var(--muted)" }}>No ingredients listed.</li>
                )}
              </ul>
            </div>
            <div className="panel">
              <h2>Instructions</h2>
              <ol className="steps">
                {steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {steps.length === 0 && (
                <p style={{ color: "var(--muted)", margin: 0 }}>
                  No instructions found.
                </p>
              )}
            </div>
          </div>

          <div className="form-actions">
            <button className="btn primary" onClick={() => pickDraft(current)}>
              Use this recipe
            </button>
            <span className="hint">
              You can edit everything before saving.
            </span>
          </div>
        </>
      )}

      {drafts && drafts.length === 0 && (
        <div className="empty-state">
          <div className="glyph">🔍</div>
          <h2>No recipes for “{searched}”</h2>
          <p>
            Try the dish name on its own, or{" "}
            <Link to="/recipes/new" className="inline-link">
              write the recipe yourself
            </Link>
            .
          </p>
        </div>
      )}
    </>
  );
}
