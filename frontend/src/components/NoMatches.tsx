import { useCallback } from "react";

import { api } from "../api";
import { EMPTY_SEARCH, describe, toFilters, tokensOf, without } from "../recipeSearch";
import type { Search, Token } from "../recipeSearch";
import { useLoad } from "../useLoad";
import { Button, EmptyState, Toolbar } from "./ui";

/** A token as the way out names it: bare, without the box's glyph or quotes. */
function label(t: Token): string {
  switch (t.kind) {
    case "tag":
    case "ingredient":
      return t.name;
    case "sale":
      return "on sale";
    case "text":
      return t.text;
  }
}

/**
 * Where in the box the first token is that, taken out, brings recipes back,
 * and how many. Every token is tried at once and the box's order decides
 * between those that help, so the offer does not depend on which answer
 * lands first. A count that cannot be had is a removal that cannot be
 * promised.
 */
async function firstRemoval(search: Search): Promise<{ at: number; count: number } | null> {
  const counts = await Promise.all(
    tokensOf(search).map((token) =>
      api.listRecipes({ ...toFilters(without(search, token)), per_page: 1 }).then(
        (found) => found.total,
        () => 0,
      ),
    ),
  );
  const at = counts.findIndex((count) => count > 0);
  return at < 0 ? null : { at, count: counts[at] };
}

/**
 * What the Recipes page says when a search matches nothing: the search, named
 * the way the result line names it, and the one token to drop to get recipes
 * back. When no single token would, it offers to clear the lot.
 */
export function NoMatches({
  search,
  onChange,
}: {
  search: Search;
  onChange: (search: Search) => void;
}) {
  const filtersKey = JSON.stringify(toFilters(search));
  const { data: removal, loading } = useLoad(
    // Asked again only when what is searched for changes, not when an
    // ingredient's name arrives: the removal is kept by its place in the box,
    // so it is named from the search as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useCallback(() => firstRemoval(search), [filtersKey]),
  );
  const token = removal ? tokensOf(search)[removal.at] : undefined;

  return (
    <EmptyState glyph="🔍" title="No matches">
      <p>No recipes match {describe(search)}.</p>
      {!loading && (
        <Toolbar center>
          {removal && token ? (
            <Button onClick={() => onChange(without(search, token))}>
              Remove “{label(token)}” to see {removal.count}
            </Button>
          ) : (
            <Button onClick={() => onChange(EMPTY_SEARCH)}>Clear the search</Button>
          )}
        </Toolbar>
      )}
    </EmptyState>
  );
}
