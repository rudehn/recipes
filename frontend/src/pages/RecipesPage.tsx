import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, type Page, type RecipeSummary } from "../api";
import { LoadFailure } from "../components/LoadError";
import { RecipePhoto, TimeChips } from "../components/RecipeBits";
import { Button, EmptyState, LinkButton, PageHead, Toolbar } from "../components/ui";
import { useDebounced } from "../useDebounced";
import { useLoad } from "../useLoad";

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
  filters: { q: string; tag: string | null };
}

export default function RecipesPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // The URL seeds the filters and then mirrors them, so a filtered view is
  // shareable and is still there after opening a recipe and coming back.
  const [input, setInput] = useState(() => searchParams.get("q") ?? "");
  const [activeTag, setActiveTag] = useState(() => searchParams.get("tag"));
  const query = useDebounced(input.trim());

  // The filter bar can no longer be derived from the recipes on screen, since
  // those are only ever one page of the collection.
  const { data: tags } = useLoad(useCallback(() => api.listRecipeTags(), []));

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
        tag: activeTag,
        page: 1,
        per_page: PER_PAGE,
      });
      return { ...first, filters: { q: query, tag: activeTag } };
    }, [query, activeTag]),
  );
  const [loadingMore, setLoadingMore] = useState(false);

  // A page fetched for one filter must not be appended under another. useLoad
  // guards its own requests, but "load more" is ours to keep straight. The
  // parts are joined on a character neither a query nor a tag can hold, so
  // no two different filters share a key; it is written as an escape
  // because a raw NUL in the source makes git treat this file as binary.
  const filters = `${query}\u0000${activeTag ?? ""}`;
  const currentFilters = useRef(filters);
  useEffect(() => {
    currentFilters.current = filters;
  }, [filters]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (query) next.set("q", query);
    else next.delete("q");
    if (activeTag) next.set("tag", activeTag);
    else next.delete("tag");
    // Navigating only on a real change matters: setSearchParams is a new
    // function after each navigation, so an unconditional call here would
    // re-trigger this effect forever.
    if (next.toString() === searchParams.toString()) return;
    // Replaced rather than pushed, so Back leaves the page instead of
    // stepping back through every letter the user typed.
    setSearchParams(next, { replace: true });
  }, [query, activeTag, searchParams, setSearchParams]);

  async function loadMore() {
    if (!listing) return;
    const wanted = currentFilters.current;
    setLoadingMore(true);
    try {
      const more = await api.listRecipes({
        q: query,
        tag: activeTag,
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
  const filtering = Boolean(applied?.q || applied?.tag);
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

      {!blank && tags && tags.length > 0 && (
        <div className="tag-filter">
          <button
            className={`tag-pill${activeTag === null ? " active" : ""}`}
            onClick={() => setActiveTag(null)}
          >
            All
          </button>
          {tags.map((tag) => (
            <button
              key={tag.name}
              className={`tag-pill${activeTag === tag.name ? " active" : ""}`}
              // The visible count is a bare number; spell it out for a reader.
              aria-label={`${tag.name}, ${tag.count} ${tag.count === 1 ? "recipe" : "recipes"}`}
              onClick={() => setActiveTag(activeTag === tag.name ? null : tag.name)}
            >
              {tag.name}
              <span className="count">{tag.count}</span>
            </button>
          ))}
        </div>
      )}

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
            {applied?.tag ? ` with tag “${applied.tag}”` : ""}.
          </p>
        </EmptyState>
      )}
    </>
  );
}
