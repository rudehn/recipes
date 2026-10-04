import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { api, imageUrl, type RecipeSummary } from "../api";
import { chipsThatFit } from "../chipFit";
import { useDebounced } from "../useDebounced";
import { useLoad } from "../useLoad";
import { Chip, Chips, Modal } from "./ui";

/** How many matches the picker shows before asking for a narrower search. */
const PICKER_LIMIT = 20;

export function TimeChips({
  recipe,
}: {
  recipe: Pick<RecipeSummary, "prep_minutes" | "cook_minutes" | "servings">;
}) {
  const total = (recipe.prep_minutes ?? 0) + (recipe.cook_minutes ?? 0);
  return (
    <Chips>
      {total > 0 && <Chip tone="accent">⏱ {total} min</Chip>}
      {recipe.servings != null && <Chip>Serves {recipe.servings}</Chip>}
    </Chips>
  );
}

/** How many of a recipe's tags a card names before counting the rest. */
const CARD_TAGS = 3;

/**
 * A recipe's tags on its card: the first few by name and a count of the rest,
 * so a recipe tagged a dozen ways is still a card and not a tag cloud. The
 * count names what it stands for on hover. Nothing at all for an untagged
 * recipe, rather than an empty row holding space open.
 *
 * Always one line. A chip that would wrap is given up to the count instead
 * (see chipFit), which takes measuring: every candidate chip and the count
 * stay rendered, the ones not shown laid out out of sight as "spare", so the
 * row can be measured again whenever the card's width changes.
 */
export function TagChips({ tags }: { tags: readonly string[] }) {
  const row = useRef<HTMLDivElement>(null);
  const candidates = tags.slice(0, CARD_TAGS);
  const [kept, setKept] = useState(candidates.length);

  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const chips = [...el.children] as HTMLElement[];
      setKept(
        chipsThatFit({
          // A chip already cut short reports its cut width; scrollWidth is
          // the width it wants.
          widths: chips
            .slice(0, -1)
            .map((chip) => Math.max(chip.offsetWidth, chip.scrollWidth)),
          total: tags.length,
          plus: chips[chips.length - 1].offsetWidth,
          gap: parseFloat(getComputedStyle(el).columnGap) || 0,
          room: el.clientWidth,
        }),
      );
    };
    measure();
    // Absent under jsdom, which lays nothing out to measure anyway.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tags]);

  if (tags.length === 0) return null;
  const counted = tags.length - kept;
  return (
    <div className="card-tags" ref={row}>
      {candidates.map((tag, i) => (
        <Chip key={tag} tone="green" className={i < kept ? undefined : "spare"}>
          {tag}
        </Chip>
      ))}
      <Chip
        tone="green"
        className={counted > 0 ? undefined : "spare"}
        title={counted > 0 ? tags.slice(kept).join(", ") : undefined}
      >
        +{Math.max(counted, 1)}
      </Chip>
    </div>
  );
}

export function RecipePhoto({
  recipe,
  className = "photo",
}: {
  recipe: Pick<RecipeSummary, "image_filename" | "title">;
  className?: string;
}) {
  const url = imageUrl(recipe.image_filename);
  if (url) return <img className={className} src={url} alt={recipe.title} />;
  return (
    <div className="photo-placeholder" aria-hidden>
      🍽️
    </div>
  );
}

export function RecipePickerModal({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (recipe: RecipeSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  // A modal paging through recipes would be a worse way to find one than
  // typing, so it shows the first screenful of matches and asks for more
  // letters instead of a page number.
  const { data: matches, error } = useLoad(
    useCallback(() => api.listRecipes({ q: search, per_page: PICKER_LIMIT }), [search]),
  );

  const found = matches?.items ?? [];
  const hidden = (matches?.total ?? 0) - found.length;

  // Escape, the focus trap and the focus restore belong to Modal.
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-search">
        <input
          autoFocus
          placeholder="Search recipes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="modal-list">
        {found.map((r) => (
          <button key={r.id} className="modal-recipe" onClick={() => onPick(r)}>
            {r.image_filename ? (
              <img src={imageUrl(r.image_filename)!} alt="" />
            ) : (
              <span className="thumb-placeholder">🍽️</span>
            )}
            <span>{r.title}</span>
          </button>
        ))}
        {found.length === 0 && (
          <p className="modal-note">
            {error ? `Could not load your recipes. ${error}` : "No recipes found."}
          </p>
        )}
        {hidden > 0 && (
          <p className="modal-note">
            {hidden} more {hidden === 1 ? "match" : "matches"} - keep typing to narrow.
          </p>
        )}
      </div>
    </Modal>
  );
}
