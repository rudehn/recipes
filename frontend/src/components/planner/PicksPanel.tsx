import { useCallback, useId, useMemo, useState } from "react";

import { api, imageUrl, type PlanPick, type PlannedMeal, type RecipeSummary } from "../../api";
import { EMPTY_SEARCH, isEmpty, toFilters, type Search } from "../../recipeSearch";
import { useAction } from "../../useAction";
import { useDebounced } from "../../useDebounced";
import { useLoad } from "../../useLoad";
import { RecipeSearchBox } from "../RecipeSearchBox";
import { placedDays, type Placing } from "./placing";

/**
 * How many results the panel lists under its search. A column 240px wide is
 * not where to browse; a search that needs more than this needs another word.
 */
const RESULTS = 8;

/** A recipe's photo at row size, or the plate that stands in for one. */
function Thumb({ recipe }: { recipe: RecipeSummary }) {
  const url = imageUrl(recipe.image_filename);
  if (url) return <img className="pick-thumb" src={url} alt="" />;
  return (
    <span className="pick-thumb" aria-hidden="true">
      🍽️
    </span>
  );
}

/**
 * The week's picks, beside the plan: the recipes chosen for the week, found
 * with the Recipes page's search and placed from here onto the cells.
 *
 * Choosing what to cook and putting it on a day are two jobs, and this is the
 * first of them. Pressing a pick (or a result) starts placing it; the plan's
 * cells are then the targets, and the page owns that state since the cells
 * are not ours. The search is the panel's own and not the URL's: the planner's
 * URL already carries its label filter, and a search here is a passing thing.
 */
export function PicksPanel({
  week,
  meals,
  placing,
  onPlacing,
}: {
  /** The Monday (ISO) of the week being viewed. */
  week: string;
  /** That week's meals, for which picks are on the plan already and on which days. */
  meals: PlannedMeal[];
  placing: Placing | null;
  onPlacing: (placing: Placing | null) => void;
}) {
  const [search, setSearch] = useState<Search>(EMPTY_SEARCH);
  const [draft, setDraft] = useState("");
  const settled = useDebounced(draft.trim());
  // As on the Recipes page, the typing searches before it is entered: it
  // stands in as the text token until there is one.
  const applied = useMemo(
    () => (search.text || !settled ? search : { ...search, text: settled }),
    [search, settled],
  );

  const { data: found, error: searchError } = useLoad(
    useCallback(
      async () =>
        isEmpty(applied) ? null : api.listRecipes({ ...toFilters(applied), per_page: RESULTS }),
      [applied],
    ),
  );

  const {
    data: loadedPicks,
    setData: setPicks,
    error: picksError,
    reload: reloadPicks,
  } = useLoad(useCallback(() => api.listPicks(week), [week]));
  // The last week's picks stay loaded while the next week's are asked for,
  // and they are not this week's to show.
  const picks = useMemo(
    () => loadedPicks?.filter((p) => p.week_start === week) ?? [],
    [loadedPicks, week],
  );
  const picked = new Set(picks.map((p) => p.recipe.id));

  const action = useAction();
  const headingId = useId();

  const choosing = (r: RecipeSummary) => placing?.kind === "recipe" && placing.recipe.id === r.id;
  const press = (r: RecipeSummary) => onPlacing(choosing(r) ? null : { kind: "recipe", recipe: r });

  async function add(recipe: RecipeSummary) {
    let saved: PlanPick | undefined;
    const ok = await action.run(async () => {
      saved = await api.addPick(week, recipe.id);
    });
    if (!ok || !saved) return;
    const pick = saved;
    if (loadedPicks === null) reloadPicks();
    // Picking a recipe twice answers the pick it already has.
    else setPicks((prev) => (prev && !prev.some((p) => p.id === pick.id) ? [...prev, pick] : prev));
  }

  function remove(pick: PlanPick) {
    const before = loadedPicks;
    setPicks((prev) => prev && prev.filter((p) => p.id !== pick.id));
    void action.run(
      () => api.removePick(pick.id),
      () => setPicks(before),
    );
  }

  return (
    <aside className="picks-panel" aria-label="Picks">
      <RecipeSearchBox
        search={search}
        onChange={setSearch}
        draft={draft}
        onDraft={setDraft}
        onOpenRecipe={(id) => window.open(`/recipes/${id}`, "_blank", "noopener")}
        placeholder="Search recipes…"
      />

      {action.error && (
        <p className="picks-error" role="alert">
          {action.error}
        </p>
      )}

      {!isEmpty(applied) && found && (
        <>
          <ul className="pick-list" aria-label="Search results">
            {found.items.map((r) => (
              <li key={r.id} className="pick-row">
                <button
                  type="button"
                  className="pick-choose"
                  aria-pressed={choosing(r)}
                  onClick={() => press(r)}
                >
                  <Thumb recipe={r} />
                  <span className="pick-title">{r.title}</span>
                </button>
                {picked.has(r.id) ? (
                  <span
                    className="pick-mark"
                    role="img"
                    aria-label="In this week's picks"
                    title="In this week's picks"
                  >
                    ✓
                  </span>
                ) : (
                  <button
                    type="button"
                    className="pick-act"
                    aria-label={`Add ${r.title} to picks`}
                    onClick={() => add(r)}
                  >
                    +
                  </button>
                )}
              </li>
            ))}
          </ul>
          {found.items.length === 0 && <p className="picks-note">No recipes found.</p>}
        </>
      )}
      {!isEmpty(applied) && searchError && (
        <p className="picks-note">Could not search your recipes. {searchError}</p>
      )}

      <h2 className="picks-heading" id={headingId}>
        This week's picks
      </h2>
      {/* Always there, so a pick added to an empty week lands in the list a
          reader already found rather than one that appears around it. */}
      <ul className="pick-list" aria-labelledby={headingId}>
        {picks.map((p) => {
          const days = placedDays(p.recipe.id, meals);
          return (
            <li key={p.id} className={`pick-row${days.length > 0 ? " placed" : ""}`}>
              <button
                type="button"
                className="pick-choose"
                aria-pressed={choosing(p.recipe)}
                onClick={() => press(p.recipe)}
              >
                <Thumb recipe={p.recipe} />
                <span className="pick-text">
                  <span className="pick-title">{p.recipe.title}</span>
                  {days.length > 0 && <span className="pick-days">{days.join(", ")}</span>}
                </span>
              </button>
              <button
                type="button"
                className="pick-act"
                aria-label={`Remove ${p.recipe.title} from picks`}
                onClick={() => remove(p)}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      {loadedPicks !== null && picks.length === 0 && (
        <p className="picks-note">
          Search for a recipe and press + to pick it for this week, then press it to place it.
        </p>
      )}
      {picksError && <p className="picks-note">Could not load this week's picks. {picksError}</p>}
    </aside>
  );
}
