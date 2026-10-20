import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";

import { api } from "../api";
import type { RecentSearch, SearchSuggestions } from "../api";
import { EMPTY_SEARCH, describe, toFilters, tokensOf, without } from "../recipeSearch";
import type { Search, Token } from "../recipeSearch";
import { useDebounced } from "../useDebounced";
import { Chip } from "./ui";

/** Room left under the dropdown when it is scrolled into sight. */
const LIST_CLEARANCE = 8;

/** One row of the dropdown, whatever group it is in. */
type Option =
  | { kind: "recent"; search: Search; signature: string }
  | { kind: "ingredient"; key: string; name: string; count: number }
  | { kind: "tag"; name: string; count: number }
  | { kind: "recipe"; id: number; title: string }
  | { kind: "text" };

type Row = { heading: string } | { option: Option };

function searchOf(recent: RecentSearch): Search {
  return {
    text: recent.text,
    tags: recent.tags,
    ingredients: recent.ingredients,
    onSale: recent.on_sale,
  };
}

function tokenLabel(t: Token): string {
  switch (t.kind) {
    case "tag":
    case "ingredient":
      return t.name;
    case "sale":
      return "on sale";
    case "text":
      return `“${t.text}”`;
  }
}

function recipeCount(count: number): string {
  return `${count} ${count === 1 ? "recipe" : "recipes"}`;
}

/** `name` with the typed letters picked out, whatever case either is in. */
function Highlighted({ text, typed }: { text: string; typed: string }) {
  const at = typed ? text.toLowerCase().indexOf(typed.toLowerCase()) : -1;
  if (at < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + typed.length)}</mark>
      {text.slice(at + typed.length)}
    </span>
  );
}

/**
 * The Recipes page's search field: tokens and the typing in one box, with a
 * dropdown that offers recent searches to an empty box and grouped suggestions
 * to a typed one.
 *
 * The suggestions are a combobox's listbox, the way TagInput's are: the arrow
 * keys move through them and one is only taken when moved to or tapped. Enter
 * with nothing moved to turns the typing into the search's text token, so the
 * box is free for the next word. The page owns the search and the draft, since
 * it filters the grid by both.
 */
export function RecipeSearchBox({
  search,
  onChange,
  draft,
  onDraft,
  onOpenRecipe,
}: {
  search: Search;
  onChange: (search: Search) => void;
  /** What is typed and not yet a token. */
  draft: string;
  onDraft: (text: string) => void;
  onOpenRecipe: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // Index into the options of the one moved to, or -1 for the typing.
  const [active, setActive] = useState(-1);
  const [recents, setRecents] = useState<RecentSearch[] | null>(null);
  const [suggested, setSuggested] = useState<{ text: string; found: SearchSuggestions } | null>(
    null,
  );
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // A press inside the dropdown is about to pick a row; see onBlur.
  const pressingList = useRef(false);
  const listId = useId();

  const typed = draft.trim();
  const settled = useDebounced(typed);
  const tokens = tokensOf(search);
  const filtersKey = JSON.stringify(toFilters(search));
  const showingRecents = open && typed === "";

  // Asked for when the empty box gains focus rather than on mount, so the
  // page does not pay for them until someone looks.
  useEffect(() => {
    if (!showingRecents) return;
    let current = true;
    api
      .recentSearches()
      .then((found) => current && setRecents(found))
      .catch(() => current && setRecents(null));
    return () => {
      current = false;
    };
  }, [showingRecents]);

  // What the typing could add, given the tokens already in the box. The draft
  // is left out of the filters: it is what is being completed.
  useEffect(() => {
    if (settled === "") return;
    let current = true;
    api
      .suggestRecipes(settled, toFilters(search))
      .then((found) => current && setSuggested({ text: settled, found }))
      .catch(() => current && setSuggested(null));
    return () => {
      current = false;
    };
    // `search` is read through its key: a new object with the same contents
    // must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, filtersKey]);

  const rows: Row[] = [];
  if (typed === "") {
    if (recents && recents.length > 0) {
      rows.push({ heading: "Recent searches" });
      for (const r of recents) {
        rows.push({ option: { kind: "recent", search: searchOf(r), signature: r.signature } });
      }
    }
  } else {
    const found = suggested?.found;
    if (found && found.ingredients.length > 0) {
      rows.push({ heading: "Ingredient" });
      for (const i of found.ingredients) rows.push({ option: { kind: "ingredient", ...i } });
    }
    if (found && found.tags.length > 0) {
      rows.push({ heading: "Tag" });
      for (const t of found.tags) rows.push({ option: { kind: "tag", ...t } });
    }
    if (found && found.recipes.length > 0) {
      rows.push({ heading: "Recipe" });
      for (const r of found.recipes) {
        rows.push({ option: { kind: "recipe", id: r.id, title: r.title } });
      }
    }
    rows.push({ option: { kind: "text" } });
  }
  const options = rows.flatMap((row) => ("option" in row ? [row.option] : []));
  const listed = open && options.length > 0;
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // On a phone the keyboard is not part of the page, so a dropdown hanging
  // below a field near the bottom of what is left of the screen opens behind
  // it. Scroll just far enough to show its last row, when it opens or changes
  // size and when the keyboard slides up. See TagInput.
  useLayoutEffect(() => {
    if (!open) return;
    const reveal = () => {
      const el = list.current;
      if (!el) return;
      const viewport = window.visualViewport;
      const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const hidden = el.getBoundingClientRect().bottom + LIST_CLEARANCE - visibleBottom;
      if (hidden > 0) window.scrollBy({ top: hidden });
    };
    reveal();
    window.visualViewport?.addEventListener("resize", reveal);
    return () => window.visualViewport?.removeEventListener("resize", reveal);
  }, [open, options.length]);

  function close() {
    setOpen(false);
    setActive(-1);
  }

  /** Something was chosen: the typing is spent and the dropdown put away. */
  function finish() {
    onDraft("");
    close();
    input.current?.focus();
  }

  function takeText() {
    if (typed === "") return;
    onChange({ ...search, text: typed });
    finish();
  }

  function choose(option: Option) {
    switch (option.kind) {
      case "recent":
        onChange(option.search);
        break;
      case "ingredient":
        if (!search.ingredients.some((i) => i.key === option.key)) {
          onChange({
            ...search,
            ingredients: [...search.ingredients, { key: option.key, name: option.name }],
          });
        }
        break;
      case "tag":
        if (!search.tags.includes(option.name)) {
          onChange({ ...search, tags: [...search.tags, option.name] });
        }
        break;
      case "recipe":
        onOpenRecipe(option.id);
        break;
      case "text":
        takeText();
        return;
    }
    finish();
  }

  function forget(signature: string) {
    const before = recents;
    setRecents((all) => all && all.filter((r) => r.signature !== signature));
    api.forgetSearch(signature).catch(() => setRecents(before));
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    onDraft(e.target.value);
    setActive(-1);
    setOpen(true);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Mid-composition the keys are the keyboard's own; see TagInput.
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "Enter":
        // Never the form's submit: Enter is how the typing becomes a token.
        e.preventDefault();
        if (listed && active >= 0) choose(options[active]);
        else takeText();
        break;
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const count = options.length;
        if (count === 0) break;
        if (!open) {
          setOpen(true);
          setActive(e.key === "ArrowDown" ? 0 : count - 1);
        } else if (e.key === "ArrowDown") {
          setActive((active + 1) % count);
        } else {
          setActive(active <= 0 ? count - 1 : active - 1);
        }
        break;
      }
      case "Escape":
        if (open) {
          e.preventDefault();
          close();
        }
        break;
      case "Tab":
        close();
        break;
      case "Delete": {
        // The keyboard's way to the visible x: forgets the recent search moved to.
        const option = listed && active >= 0 ? options[active] : null;
        if (option?.kind !== "recent") break;
        e.preventDefault();
        forget(option.signature);
        // The next search slides into this row; past the last, step back.
        setActive(active === options.length - 1 ? active - 1 : active);
        break;
      }
      case "Backspace":
        if (draft === "" && tokens.length > 0) onChange(without(search, tokens[tokens.length - 1]));
        break;
    }
  }

  function renderOption(option: Option): ReactNode {
    const text = suggested?.text ?? typed;
    switch (option.kind) {
      case "recent":
        return (
          <>
            <span className="search-drop-icon" aria-hidden="true">↺</span>
            <span className="search-drop-name">{describe(option.search)}</span>
            <button
              type="button"
              className="search-drop-forget"
              aria-label={`Forget ${describe(option.search)}`}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                forget(option.signature);
              }}
            >
              ✕
            </button>
          </>
        );
      case "ingredient":
        return (
          <>
            <span className="search-drop-icon" aria-hidden="true">🥕</span>
            <span className="search-drop-name"><Highlighted text={option.name} typed={text} /></span>
            <span className="search-drop-count">{recipeCount(option.count)}</span>
          </>
        );
      case "tag":
        return (
          <>
            <span className="search-drop-icon" aria-hidden="true">#</span>
            <span className="search-drop-name"><Highlighted text={option.name} typed={text} /></span>
            <span className="search-drop-count">{recipeCount(option.count)}</span>
          </>
        );
      case "recipe":
        return (
          <span className="search-drop-name"><Highlighted text={option.title} typed={text} /></span>
        );
      case "text":
        return <span className="search-drop-name">Search for “{typed}”</span>;
    }
  }

  let index = -1;
  return (
    <div className="recipe-search">
      <div
        className="recipe-search-box"
        onClick={(e) => {
          if (e.target === e.currentTarget) input.current?.focus();
        }}
      >
        {tokens.map((t) => (
          <Chip
            // An ingredient by its key: its name can arrive late, and two
            // ingredients can share one.
            key={t.kind === "ingredient" ? `ingredient:${t.key}` : `${t.kind}:${tokenLabel(t)}`}
            tone={t.kind === "sale" ? "accent" : "green"}
            className="recipe-search-token"
            title={tokenLabel(t)}
          >
            <span className="recipe-search-token-name">
              {t.kind === "ingredient" ? `🥕 ${t.name}` : tokenLabel(t)}
            </span>
            <button
              type="button"
              className="tag-input-remove"
              aria-label={`Remove ${tokenLabel(t)}`}
              onClick={() => {
                onChange(without(search, t));
                input.current?.focus();
              }}
            >
              ✕
            </button>
          </Chip>
        ))}
        <input
          ref={input}
          role="combobox"
          aria-label="Search recipes"
          aria-autocomplete="list"
          aria-expanded={listed}
          aria-controls={listed ? listId : undefined}
          aria-activedescendant={listed && active >= 0 ? optionId(active) : undefined}
          value={draft}
          placeholder={tokens.length === 0 ? "Search recipes, ingredients or tags…" : ""}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            pressingList.current = false;
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onBlur={() => {
            // A press on a row can take focus on some touch browsers before
            // its click arrives; closing then would drop the click.
            if (pressingList.current) {
              pressingList.current = false;
              return;
            }
            close();
          }}
        />
        {(tokens.length > 0 || draft !== "") && (
          <button
            type="button"
            className="recipe-search-clear"
            onClick={() => {
              onChange(EMPTY_SEARCH);
              onDraft("");
              input.current?.focus();
            }}
          >
            Clear
          </button>
        )}
      </div>
      {open && (
        <div
          className="search-drop"
          onPointerDown={() => {
            pressingList.current = true;
          }}
          // A press dragged off the dropdown never clicks a row, and must not
          // leave the next real blur to be swallowed.
          onPointerUp={() => {
            pressingList.current = false;
          }}
          onPointerCancel={() => {
            pressingList.current = false;
          }}
          // Keeps focus in the field, so the keyboard stays up on a phone and
          // the field never blurs on the way to the click.
          onMouseDown={(e) => e.preventDefault()}
        >
          {listed && (
            <ul className="search-drop-list" ref={list} id={listId} role="listbox" aria-label="Suggestions">
              {rows.map((row) => {
                if ("heading" in row) {
                  return (
                    <li key={row.heading} role="presentation" className="search-drop-heading">
                      {row.heading}
                    </li>
                  );
                }
                index += 1;
                const at = index;
                return (
                  <li
                    key={at}
                    id={optionId(at)}
                    role="option"
                    aria-selected={at === active}
                    className={[
                      "search-drop-option",
                      row.option.kind === "text" ? "search-drop-text" : "",
                      at === active ? "active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      pressingList.current = false;
                      choose(row.option);
                    }}
                  >
                    {renderOption(row.option)}
                  </li>
                );
              })}
            </ul>
          )}
          {typed === "" && recents?.length === 0 && (
            <p className="search-drop-note">
              Nothing yet. Searches you open a recipe from show up here.
            </p>
          )}
          {typed === "" && (
            <p className="search-drop-hint">Start typing for ingredients, tags and recipes</p>
          )}
        </div>
      )}
    </div>
  );
}
