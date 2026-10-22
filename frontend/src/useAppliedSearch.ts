import { useMemo } from "react";

import type { Search } from "./recipeSearch";
import { useDebounced } from "./useDebounced";

/**
 * The search a recipe search box asks the server for: its tokens, with what
 * is typed and not yet entered standing in as the text until there is a text
 * token. The typing counts once it settles, so the results follow it without
 * Enter but not on every letter.
 *
 * One rule for every box that searches recipes - the Recipes page, the
 * planner's Picks and its "+ Add" picker - so they cannot drift apart.
 * Memoised, so a caller can key a load on it.
 */
export function useAppliedSearch(search: Search, draft: string): Search {
  const settled = useDebounced(draft.trim());
  return useMemo(
    () => (search.text || !settled ? search : { ...search, text: settled }),
    [search, settled],
  );
}
