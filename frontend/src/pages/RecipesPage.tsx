import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import {
  api,
  type IngredientName,
  type Page,
  type RecipeSort,
  type RecipeSummary,
} from "../api";
import { firstParagraph } from "../description";
import { LoadFailure } from "../components/LoadError";
import { NoMatches } from "../components/NoMatches";
import { QuickRow, QuickRowPlaceholder } from "../components/QuickRow";
import { RecipePhoto, TagChips, TimeChips } from "../components/RecipeBits";
import { RecipeSearchBox } from "../components/RecipeSearchBox";
import { Button, EmptyState, LinkButton, PageHead, Toolbar } from "../components/ui";
import {
  describe,
  isEmpty,
  searchFromParams,
  sortFromParams,
  toFilters,
  toInput,
  writeParams,
  type Search,
} from "../recipeSearch";
import { useAppliedSearch } from "../useAppliedSearch";
import { useLoad } from "../useLoad";

const PER_PAGE = 24;

/** The sorts, in the menu's order. Biggest sale is offered only while sales are known. */
const SORTS: [RecipeSort, string][] = [
  ["title", "A-Z"],
  ["newest", "Recently added"],
  ["cooked", "Recently cooked"],
  ["sale", "Biggest sale"],
];

interface Listing extends Page<RecipeSummary> {
  /**
   * The search and order these results answer.
   *
   * While a search is in flight the box has moved on but the results have
   * not, and pairing the new search with the old total makes the page state
   * things that were never true ("31 recipes · zuppa" for a query nothing has
   * counted yet). Carrying the search with the results keeps every number and
   * every message describing the same request.
   */
  search: Search;
  sort: RecipeSort;
}

/**
 * A request's identity, for telling whether a page fetched for one search
 * still belongs to the search on screen.
 */
function requestKey(search: Search, sort: RecipeSort): string {
  return JSON.stringify([toFilters(search), sort]);
}

/**
 * `search` with its ingredients named the way the facets name them. The URL
 * carries only an ingredient's key; until the facets answer, the token is
 * the key spelled with spaces.
 */
function named(search: Search, names: IngredientName[] | undefined): Search {
  if (!names || search.ingredients.length === 0) return search;
  return {
    ...search,
    ingredients: search.ingredients.map(
      (ingredient) => names.find((n) => n.key === ingredient.key) ?? ingredient,
    ),
  };
}

const recipeCount = (n: number) => `${n} ${n === 1 ? "recipe" : "recipes"}`;

/**
 * Remembers a search a recipe was opened from, for the box's recent searches
 * and the quick row's most-searched tags. Never waited on and never reported:
 * history is a convenience, and opening the recipe is what was asked for.
 */
function remember(search: Search) {
  if (isEmpty(search)) return;
  api.recordSearch(toInput(search)).catch(() => {});
}

/**
 * How many recipes are in the box, for the header. An unfiltered listing is
 * the whole box, so its total is the count; a page opened already filtered
 * asks once.
 */
function useSavedCount(listing: Listing | null): number | null {
  const [saved, setSaved] = useState<number | null>(null);
  const whole = listing && isEmpty(listing.search) ? listing.total : null;
  // Kept for when the page goes on to filter, so the header holds still.
  if (whole !== null && whole !== saved) setSaved(whole);
  const missing = saved === null && whole === null && listing !== null;
  useEffect(() => {
    if (!missing) return;
    let current = true;
    api.listRecipes({ per_page: 1 }).then(
      (found) => current && setSaved(found.total),
      // The header goes without a count rather than the page failing for it.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [missing]);
  return whole ?? saved;
}

export default function RecipesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // The URL seeds the search and then mirrors it, so a search is shareable
  // and is still there after opening a recipe and coming back. An old link's
  // `q` and `tag` arrive as a text token and tags.
  const [search, setSearch] = useState(() => searchFromParams(searchParams));
  const [sort, setSort] = useState(() => sortFromParams(searchParams));
  // What is typed and not yet a token. The grid follows it once it settles.
  const [draft, setDraft] = useState("");
  // The search the page asks for: the tokens, with the typing standing in as
  // the text until there is a text token.
  const applied = useAppliedSearch(search, draft);

  // Asked with the list's own search, so each count is what picking that
  // tag would leave.
  const { data: facets, loading: facetsLoading } = useLoad(
    useCallback(() => api.recipeFacets(toFilters(applied)), [applied]),
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
        ...toFilters(applied),
        sort,
        page: 1,
        per_page: PER_PAGE,
      });
      return { ...first, search: applied, sort };
    }, [applied, sort]),
  );
  const saved = useSavedCount(listing);
  const [loadingMore, setLoadingMore] = useState(false);

  // Sales are unknown with pricing off or no store, and there is nothing then
  // to sort by. A bookmark asking for it is put back to A-Z once the facets
  // say so, so the menu, the URL and the request agree.
  if (facets && facets.on_sale === null && sort === "sale") setSort("title");
  const saleSortable = facets ? facets.on_sale !== null : sort === "sale";

  useEffect(() => {
    const next = writeParams(applied, sort, new URLSearchParams(searchParams));
    // Navigating only on a real change matters: setSearchParams is a new
    // function after each navigation, so an unconditional call here would
    // re-trigger this effect forever.
    if (next.toString() === searchParams.toString()) return;
    // Replaced rather than pushed, so Back leaves the page instead of
    // stepping back through every token and letter.
    setSearchParams(next, { replace: true });
  }, [applied, sort, searchParams, setSearchParams]);

  /** A search set from outside the box: what was typed is part of it now. */
  function replaceSearch(next: Search) {
    setSearch(next);
    setDraft("");
  }

  function openRecipe(id: number) {
    // The box's tokens are the search; the typing was finding this recipe.
    remember(search);
    navigate(`/recipes/${id}`);
  }

  async function loadMore() {
    if (!listing) return;
    // The next page of what is on screen, which is not always what is being
    // asked for: a new search may be in flight. useLoad guards its own
    // requests, but "load more" is ours to keep straight, so the page lands
    // only on the results it continues.
    const wanted = requestKey(listing.search, listing.sort);
    const after = listing.page;
    setLoadingMore(true);
    try {
      const more = await api.listRecipes({
        ...toFilters(listing.search),
        sort: listing.sort,
        page: after + 1,
        per_page: PER_PAGE,
      });
      // `more` carries the newer total too: the collection may have changed
      // since the first page was fetched.
      setListing((loaded) =>
        loaded && loaded.page === after && requestKey(loaded.search, loaded.sort) === wanted
          ? { ...more, search: loaded.search, sort: loaded.sort, items: [...loaded.items, ...more.items] }
          : loaded,
      );
    } catch {
      // What is on screen stays; the button is still there for another try.
    } finally {
      setLoadingMore(false);
    }
  }

  // Made once per change rather than per render: QuickRow measures itself
  // again whenever its tags change, and the box asks again when its search does.
  const boxSearch = useMemo(() => named(search, facets?.ingredients), [search, facets]);
  const quickTags = useMemo(
    () => (facets ? facets.tags.filter((tag) => !search.tags.includes(tag.name)) : []),
    [facets, search.tags],
  );
  // Everything below describes the results on screen, so it reads the search
  // they answer rather than the one the user is part-way through building.
  const answered = useMemo(
    () => listing && named(listing.search, facets?.ingredients),
    [listing, facets],
  );
  const shown = listing?.items.length ?? 0;
  const total = listing?.total ?? 0;
  const emptyBox = listing !== null && total === 0 && isEmpty(listing.search);
  // A failed refresh leaves results worth keeping, so the page empties itself
  // only when the failure left it with nothing at all.
  const blank = error !== null && listing === null;
  const sorts = SORTS.filter(([value]) => value !== "sale" || saleSortable);

  return (
    <>
      <PageHead title="Recipes" sub={saved === null ? "" : `${saved} saved`}>
        <Toolbar>
          <LinkButton to="/recipes/search">🔍 Find online</LinkButton>
          <LinkButton to="/recipes/new" variant="primary">
            + New recipe
          </LinkButton>
        </Toolbar>
      </PageHead>

      {/* An empty box has nothing to search or sort; its empty state says
          how to fill it. */}
      {!emptyBox && (
        <div className="recipes-controls">
          <RecipeSearchBox
            search={boxSearch}
            onChange={setSearch}
            draft={draft}
            onDraft={setDraft}
            onOpenRecipe={openRecipe}
          />
          <label className="recipes-sort">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as RecipeSort)}
            >
              {sorts.map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {/* Held only while the facets are on their way: if they fail, the
              row is simply absent rather than a blank line. */}
          {!blank && !facets && facetsLoading && <QuickRowPlaceholder />}
          {!blank && facets && (
            <QuickRow
              tags={quickTags}
              onSale={facets.on_sale}
              saleSelected={search.onSale}
              onPickTag={(name) =>
                setSearch((s) => (s.tags.includes(name) ? s : { ...s, tags: [...s.tags, name] }))
              }
              onPickSale={() => setSearch((s) => ({ ...s, onSale: true }))}
            />
          )}
          {answered && (
            <p className="recipes-result">
              {recipeCount(total)}
              {!isEmpty(answered) && ` · ${describe(answered)}`}
            </p>
          )}
        </div>
      )}

      {error && (
        <LoadFailure
          what="your recipes"
          message={error}
          onRetry={reload}
          showing={listing !== null}
        />
      )}

      {!blank && !listing && loading && <p className="list-status">Loading recipes…</p>}

      {!blank && emptyBox && (
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

      {!blank && listing && answered && shown > 0 && (
        // Results are dimmed rather than cleared while the next search loads,
        // so the page does not flash empty on every keystroke.
        <div className={`recipe-grid${loading ? " stale" : ""}`}>
          {listing.items.map((r) => (
            <Link
              to={`/recipes/${r.id}`}
              key={r.id}
              className="recipe-card"
              onClick={() => remember(answered)}
            >
              <div className="photo-wrap">
                <RecipePhoto recipe={r} />
                {r.sale_percent !== null && (
                  <span className="sale-ribbon">{r.sale_percent}% off</span>
                )}
              </div>
              <div className="body">
                <h3>{r.title}</h3>
                <TagChips tags={r.tags} />
                {/* Cut to a line or two, so the first paragraph only:
                    the rest would run on into it. */}
                {r.description.trim() && <p className="desc">{firstParagraph(r.description)}</p>}
                <TimeChips recipe={r} />
              </div>
            </Link>
          ))}
        </div>
      )}

      {!blank && shown > 0 && shown < total && (
        <div className="load-more">
          {/* Not while the next search loads: the page it would add belongs
              to the results about to be replaced. */}
          <Button onClick={loadMore} disabled={loadingMore || loading}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
          <span className="sub">
            Showing {shown} of {total}
          </span>
        </div>
      )}

      {!blank && answered && total === 0 && !isEmpty(answered) && (
        <NoMatches search={answered} onChange={replaceSearch} />
      )}
    </>
  );
}
