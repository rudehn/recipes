import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  api,
  type Affects,
  type Page,
  type RecipeAttention,
  type RecipeSummary,
  type TagCount,
} from "../api";
import { ISSUE_LABELS, NO_SERVINGS_LABEL } from "../issues";
import { recipeIngredientPath, recipeNutritionPath } from "../recipeLink";
import { LoadFailure } from "../components/LoadError";
import { RecipePhoto, TagChips, TimeChips } from "../components/RecipeBits";
import { Button, EmptyState, LinkButton, PageHead, Toolbar } from "../components/ui";
import { useDebounced } from "../useDebounced";
import { useLoad } from "../useLoad";
import { useScrollEdges } from "../useScrollEdges";

const PER_PAGE = 24;

interface Listing extends Page<RecipeSummary> {
  /**
   * The filters these results answer.
   *
   * While a search is in flight the input has moved on but the results have
   * not, and pairing the new filters with the old total makes the page state
   * things that were never true ("31 matches" for a query nothing has counted
   * yet). Carrying the filters with the results keeps every number and every
   * message describing the same request.
   */
  filters: { q: string; tags: string[] };
}

/** “a”, “b” and “c”: names quoted the way the page quotes a search. */
function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  return quoted.length < 2
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

export default function RecipesPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // The URL seeds the filters and then mirrors them, so a filtered view is
  // shareable and is still there after opening a recipe and coming back.
  // Several tags are several `tag` params, the same shape the server reads.
  const [input, setInput] = useState(() => searchParams.get("q") ?? "");
  const [activeTags, setActiveTags] = useState(() => searchParams.getAll("tag"));
  const query = useDebounced(input.trim());

  // The filter bar can no longer be derived from the recipes on screen, since
  // those are only ever one page of the collection. It is asked with the
  // list's own filters, so each count is what tapping that pill would leave.
  const { data: tags } = useLoad(
    useCallback(() => api.listRecipeTags({ q: query, tags: activeTags }), [query, activeTags]),
  );

  const {
    data: listing,
    setData: setListing,
    error,
    loading,
    reload,
  } = useLoad<Listing>(
    useCallback(async () => {
      const first = await api.listRecipes({
        q: query,
        tags: activeTags,
        page: 1,
        per_page: PER_PAGE,
      });
      return { ...first, filters: { q: query, tags: activeTags } };
    }, [query, activeTags]),
  );
  const [loadingMore, setLoadingMore] = useState(false);

  // A page fetched for one filter must not be appended under another. useLoad
  // guards its own requests, but "load more" is ours to keep straight. The
  // parts are joined on a character neither a query nor a tag can hold, so
  // no two different filters share a key; it is written as an escape
  // because a raw NUL in the source makes git treat this file as binary.
  const filters = [query, ...activeTags].join("\u0000");
  const currentFilters = useRef(filters);
  useEffect(() => {
    currentFilters.current = filters;
  }, [filters]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (query) next.set("q", query);
    else next.delete("q");
    next.delete("tag");
    for (const tag of activeTags) next.append("tag", tag);
    // Navigating only on a real change matters: setSearchParams is a new
    // function after each navigation, so an unconditional call here would
    // re-trigger this effect forever.
    if (next.toString() === searchParams.toString()) return;
    // Replaced rather than pushed, so Back leaves the page instead of
    // stepping back through every letter the user typed.
    setSearchParams(next, { replace: true });
  }, [query, activeTags, searchParams, setSearchParams]);

  function toggleTag(name: string) {
    setActiveTags((selected) =>
      selected.includes(name) ? selected.filter((t) => t !== name) : [...selected, name],
    );
  }

  async function loadMore() {
    if (!listing) return;
    const wanted = currentFilters.current;
    setLoadingMore(true);
    try {
      const more = await api.listRecipes({
        q: query,
        tags: activeTags,
        page: listing.page + 1,
        per_page: PER_PAGE,
      });
      if (currentFilters.current !== wanted) return;
      // `more` carries the newer total too: the collection may have changed
      // since the first page was fetched. The filters are unchanged - that is
      // what the guard above just established.
      setListing((loaded) =>
        loaded
          ? { ...more, filters: loaded.filters, items: [...loaded.items, ...more.items] }
          : loaded,
      );
    } catch {
      // What is on screen stays; the button is still there for another try.
    } finally {
      setLoadingMore(false);
    }
  }

  // Everything below describes the results on screen, so it reads the filters
  // they answer rather than the ones the user is part-way through typing.
  const applied = listing?.filters;
  const filtering = Boolean(applied?.q || applied?.tags.length);
  const shown = listing?.items.length ?? 0;
  const total = listing?.total ?? 0;
  // A failed refresh leaves results worth keeping, so the page empties itself
  // only when the failure left it with nothing at all.
  const blank = error !== null && listing === null;

  return (
    <>
      <PageHead
        title="Recipes"
        sub={
          !listing
            ? ""
            : filtering
              ? `${total} ${total === 1 ? "match" : "matches"}`
              : `${total} saved`
        }
      >
        <Toolbar>
          <input
            className="searchbar"
            placeholder="Search recipes or ingredients…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <LinkButton to="/recipes/search">🔍 Find online</LinkButton>
          <LinkButton to="/recipes/new" variant="primary">
            + New recipe
          </LinkButton>
        </Toolbar>
      </PageHead>

      {error && (
        <LoadFailure
          what="your recipes"
          message={error}
          onRetry={reload}
          showing={listing !== null}
        />
      )}

      {!blank && tags && (
        <TagFilter
          tags={tags}
          selected={activeTags}
          onToggle={toggleTag}
          onClear={() => setActiveTags([])}
        />
      )}

      {!blank && <SuggestionPanels />}

      {!blank && <NeedsALook />}

      {!blank && !listing && loading && <p className="list-status">Loading recipes…</p>}

      {!blank && listing && listing.items.length === 0 && !filtering && (
        <EmptyState glyph="🍳" title="Your recipe box is empty">
          <p>Search for a dish to fill one in for you, or write your own.</p>
          <Toolbar center>
            <LinkButton to="/recipes/search" variant="primary">
              🔍 Find a recipe online
            </LinkButton>
            <LinkButton to="/recipes/new">+ New recipe</LinkButton>
          </Toolbar>
        </EmptyState>
      )}

      {!blank && listing && listing.items.length > 0 && (
        // Results are dimmed rather than cleared while the next filter loads,
        // so the page does not flash empty on every keystroke.
        <div className={`recipe-grid${loading ? " stale" : ""}`}>
          {listing.items.map((r) => (
            <Link to={`/recipes/${r.id}`} key={r.id} className="recipe-card">
              <RecipePhoto recipe={r} />
              <div className="body">
                <h3>{r.title}</h3>
                <TagChips tags={r.tags} />
                {r.description && <p className="desc">{r.description}</p>}
                <TimeChips recipe={r} />
              </div>
            </Link>
          ))}
        </div>
      )}

      {!blank && shown > 0 && shown < total && (
        <div className="load-more">
          <Button onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
          <span className="sub">
            Showing {shown} of {total}
          </span>
        </div>
      )}

      {!blank && listing && listing.items.length === 0 && filtering && (
        <EmptyState glyph="🔍" title="No matches">
          <p>
            No recipes match
            {applied?.q ? ` “${applied.q}”` : ""}
            {applied?.tags.length
              ? ` with ${applied.tags.length === 1 ? "tag" : "tags"} ${quotedList(applied.tags)}`
              : ""}
            .
          </p>
        </EmptyState>
      )}
    </>
  );
}

/**
 * The tag pills. Tapping several narrows the list to recipes carrying all of
 * them, and each pill counts what tapping it would leave.
 *
 * A pill that would leave nothing is dimmed and cannot be tapped, rather than
 * hidden, so the bar keeps its shape as the filters change. A selected pill is
 * never dimmed, whatever its count: it is the way back out of the filter. For
 * the same reason a selected tag the box no longer has - a link from before it
 * was renamed - still gets a pill, at the end, so it can be taken off.
 *
 * On a phone the bar is one row that scrolls sideways (see styles.css), and
 * the edges fade where there are more pills past them.
 */
function TagFilter({
  tags,
  selected,
  onToggle,
  onClear,
}: {
  tags: TagCount[];
  selected: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
}) {
  const gone = selected.filter((name) => !tags.some((t) => t.name === name));
  const pills = [...tags, ...gone.map((name) => ({ name, count: 0 }))];
  const { ref, edges, measure } = useScrollEdges(pills.length);
  if (pills.length === 0) return null;

  return (
    <div
      className={`tag-filter-wrap${edges.left ? " fade-left" : ""}${
        edges.right ? " fade-right" : ""
      }`}
    >
      <div
        className="tag-filter"
        role="group"
        aria-label="Filter by tag"
        ref={ref}
        onScroll={measure}
      >
        <button
          className={`tag-pill${selected.length === 0 ? " active" : ""}`}
          aria-pressed={selected.length === 0}
          onClick={onClear}
        >
          All
        </button>
        {pills.map((tag) => {
          const on = selected.includes(tag.name);
          return (
            <button
              key={tag.name}
              className={`tag-pill${on ? " active" : ""}`}
              aria-pressed={on}
              disabled={!on && tag.count === 0}
              // The visible count is a bare number; spell it out for a reader.
              aria-label={`${tag.name}, ${tag.count} ${tag.count === 1 ? "recipe" : "recipes"}`}
              onClick={() => onToggle(tag.name)}
            >
              {tag.name}
              <span className="count">{tag.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const money = (n: number) => `$${n.toFixed(2)}`;

const recipeCount = (n: number) => `${n} recipe${n === 1 ? "" : "s"}`;

/**
 * Reasons to cook something this week.
 *
 * Three folds, each present only when it has something to say, and every one
 * folded away because the answer is usually "nothing much" and none of them
 * may push the recipes themselves down the page. Absent entirely for a
 * household without a Kroger account, except the pantry fold, which needs no
 * price at all.
 *
 * The offers used to be a list of discounted ingredients on the grocery page,
 * where they answered a question nobody there was asking. What a discount is
 * good for is deciding what to cook, so it lives here, phrased as recipes.
 */
function SuggestionPanels() {
  const { data } = useLoad(useCallback(() => api.suggestions(), []));
  if (!data) return null;
  const { on_sale, cheap, median_per_serving, pantry } = data;
  return (
    <>
      {on_sale.length > 0 && (
        <details className="offers-section">
          <summary>
            On sale this week <span className="count">{recipeCount(on_sale.length)}</span>
          </summary>
          {on_sale.map((entry) => (
            <div key={entry.recipe.id} className="offer">
              <div className="offer-recipe">
                <Link to={`/recipes/${entry.recipe.id}`}>{entry.recipe.title}</Link>
                <span className="offer-coverage">
                  {entry.on_sale.length} of {entry.ingredient_count} ingredient
                  {entry.ingredient_count === 1 ? "" : "s"} on offer
                </span>
              </div>
              <ul className="offer-items">
                {entry.on_sale.map((sale) => (
                  <li key={sale.key}>
                    <span className="name">{sale.name}</span>
                    <span className="item-price on-sale">
                      <span className="amount">
                        <s>{money(sale.price.regular)}</s>{" "}
                        {money(sale.price.promo ?? sale.price.regular)}
                      </span>
                      <span className="product">
                        {sale.price.description}
                        {sale.price.size && (
                          <>
                            {" · "}
                            <span className="product-size">{sale.price.size}</span>
                          </>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}

      {cheap.length > 0 && median_per_serving !== null && (
        // Below the median across the box, never against a price history.
        // The median is on the heading so "cheap" has a number attached.
        <details className="offers-section">
          <summary>
            Under {money(median_per_serving)} a serving{" "}
            <span className="count">{recipeCount(cheap.length)}</span>
          </summary>
          {cheap.map((entry) => (
            <div key={entry.recipe.id} className="offer">
              <div className="offer-recipe">
                <Link to={`/recipes/${entry.recipe.id}`}>{entry.recipe.title}</Link>
                <span className="offer-coverage">
                  {entry.priced} of {entry.total_lines} ingredient
                  {entry.total_lines === 1 ? "" : "s"} priced
                </span>
              </div>
              <span className="offer-figure">{money(entry.per_serving)} a serving</span>
            </div>
          ))}
        </details>
      )}

      {pantry.length > 0 && (
        <details className="offers-section">
          <summary>
            Mostly in your pantry <span className="count">{recipeCount(pantry.length)}</span>
          </summary>
          {pantry.map((entry) => (
            <div key={entry.recipe.id} className="offer">
              <div className="offer-recipe">
                <Link to={`/recipes/${entry.recipe.id}`}>{entry.recipe.title}</Link>
              </div>
              <span className="offer-figure">
                {entry.in_pantry} of {entry.total_lines} ingredient
                {entry.total_lines === 1 ? "" : "s"} in stock
              </span>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

/** What a line of "Needs a look" holds up, which decides the list it is in. */
type Holds = "both" | "nutrition" | "price";

/**
 * The lists, in order. A row the recipe has wrong comes first, since one edit
 * to it settles the price and the nutrition together.
 */
const HOLDS: [Holds, string][] = [
  ["both", "Price and nutrition"],
  ["nutrition", "Nutrition"],
  ["price", "Price"],
];

function holds(affects: Affects[]): Holds {
  const price = affects.includes("price");
  const nutrition = affects.includes("nutrition");
  return price && nutrition ? "both" : price ? "price" : "nutrition";
}

interface AttentionLine {
  key: string;
  /** Where the fix is. */
  to: string;
  name: string;
  why: string;
}

/**
 * A recipe's lines sorted by what they hold up, each linked to its fix. A
 * price, or a row the recipe has wrong, is fixed on the row; a food is chosen
 * in the nutrition breakdown; the servings are in the edit form. A row held up
 * for a reason on each side - nothing matched, and no food chosen - is in both
 * lists, since each has its own fix.
 */
function attentionLines(entry: RecipeAttention): Map<Holds, AttentionLine[]> {
  const id = entry.recipe.id;
  const lines = new Map<Holds, AttentionLine[]>(HOLDS.map(([h]) => [h, []]));
  if (entry.no_servings) {
    lines.get("nutrition")!.push({
      key: "servings",
      to: `/recipes/${id}/edit`,
      name: "Whole recipe",
      why: NO_SERVINGS_LABEL,
    });
  }
  for (const row of entry.issues) {
    const held = holds(row.affects);
    lines.get(held)!.push({
      key: String(row.ingredient_id),
      to:
        held === "nutrition"
          ? recipeNutritionPath(id, row.ingredient_id)
          : recipeIngredientPath(id, [row.ingredient_id]),
      name: row.name,
      why: ISSUE_LABELS[row.issue],
    });
  }
  return lines;
}

/**
 * How much of a recipe's price and nutrition is held up: "2 for nutrition ·
 * 1 for price". A row the recipe has wrong is counted in both, since fixing
 * it settles both.
 */
function heldUp(lines: Map<Holds, AttentionLine[]>): string {
  const both = lines.get("both")!.length;
  const counts: [string, number][] = [
    ["nutrition", both + lines.get("nutrition")!.length],
    ["price", both + lines.get("price")!.length],
  ];
  return counts
    .filter(([, n]) => n > 0)
    .map(([what, n]) => `${n} for ${what}`)
    .join(" · ");
}

/** One list of a recipe's lines, under what they hold up. */
function AttentionGroup({ heading, lines }: { heading: string; lines: AttentionLine[] }) {
  const headingId = useId();
  return (
    <div className="attention-group">
      <p className="attention-heading" id={headingId}>
        {heading}
      </p>
      <ul className="attention-items" aria-labelledby={headingId}>
        {lines.map((line) => (
          <li key={line.key}>
            <Link to={line.to}>{line.name}</Link>
            <span className="issue-tag">{line.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Recipes with rows that will price, shop or count wrongly.
 *
 * The reasons the grocery list and the nutrition breakdown show, gathered by
 * recipe so the fixes can be made in one sitting. Within a recipe the lines
 * are listed under what they hold up - the price, the nutrition, or both -
 * since the fixes differ, and each links to where its fix is. Folded like the
 * suggestions, and absent when there is nothing to say - which is the state
 * to aim for.
 */
function NeedsALook() {
  const { data } = useLoad(useCallback(() => api.recipesAttention(), []));
  if (!data || data.length === 0) return null;
  return (
    <details className="offers-section attention-section">
      <summary>
        Needs a look <span className="count">{recipeCount(data.length)}</span>
      </summary>
      {data.map((entry) => {
        const lines = attentionLines(entry);
        return (
          <div key={entry.recipe.id} className="offer">
            <div className="offer-recipe">
              <Link to={`/recipes/${entry.recipe.id}`}>{entry.recipe.title}</Link>
              <span className="offer-coverage">{heldUp(lines)}</span>
            </div>
            <div className="attention-groups">
              {HOLDS.filter(([held]) => lines.get(held)!.length > 0).map(([held, heading]) => (
                <AttentionGroup key={held} heading={heading} lines={lines.get(held)!} />
              ))}
            </div>
          </div>
        );
      })}
    </details>
  );
}
