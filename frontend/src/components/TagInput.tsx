import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

import { Chip } from "./ui";

/** The longest tag the server keeps. See RecipeIn.normalized_tags. */
const MAX_TAG_LENGTH = 50;

/** Enough to choose from at a glance; past this, another letter narrows it. */
const MAX_SUGGESTIONS = 8;

/** Room left under the suggestions when they are scrolled into sight. */
const LIST_CLEARANCE = 8;

/**
 * A tag spelled the way the server stores it - trimmed and lowercased - so
 * the chip on screen is the tag that will be saved, and "Quick" typed beside
 * an existing "quick" is recognised as the same tag before it is sent.
 */
function normalizeTag(text: string): string {
  return text.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
}

/** The tags worth offering for `typed`: those starting with it, then those containing it. */
function suggest(typed: string, suggestions: readonly string[], chosen: readonly string[]) {
  const open = suggestions.filter((s) => !chosen.includes(s) && s.includes(typed));
  const starting = open.filter((s) => s.startsWith(typed));
  const containing = open.filter((s) => !s.startsWith(typed));
  return [...starting, ...containing].slice(0, MAX_SUGGESTIONS);
}

/**
 * An option's name with the typed letters picked out, so a long list scans.
 * One span around the lot, because an option on a phone is a flex box (to
 * centre it in a fingertip's height) and every bare piece of text in a flex
 * box is an item of its own, trimmed at its edges: "main <strong>co</strong>urse"
 * would lose its space and read "maincourse".
 */
function Highlighted({ text, typed }: { text: string; typed: string }) {
  const at = typed ? text.indexOf(typed) : -1;
  if (at < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, at)}
      <strong>{text.slice(at, at + typed.length)}</strong>
      {text.slice(at + typed.length)}
    </span>
  );
}

/**
 * Tags as chips, typed or picked from the ones the recipe box already uses.
 *
 * Enter, a comma or Tab turns the typing into a chip; so does leaving the
 * field, because a tag typed on the way to Save is a tag the person meant.
 * The comma is read from the text rather than the key, since a phone's
 * keyboard does not reliably say which key it pressed - and that way a
 * pasted "quick, vegetarian" becomes two chips as well.
 *
 * The suggestions are a combobox's listbox (the ARIA pattern with list
 * autocomplete): typing filters them, the arrow keys move through them, and
 * a suggestion is only taken when moved to or tapped. One is never taken on
 * the person's behalf, so "din" typed and entered is "din" rather than
 * whichever tag happened to start with it. Tapping the field opens them all,
 * which on a phone is quicker than typing.
 */
export function TagInput({
  id,
  tags,
  onChange,
  suggestions,
}: {
  /** The text field's id, for the label that names it. */
  id: string;
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  /** Tags already in the recipe box. */
  suggestions: readonly string[];
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  // Index into `options` of the suggestion moved to, or -1 for the typing.
  const [active, setActive] = useState(-1);
  // What a screen reader is told after a chip comes or goes, since the field
  // itself only ever empties.
  const [announcement, setAnnouncement] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // A press inside the suggestions is about to pick one; see onBlur.
  const pressingList = useRef(false);
  const listId = useId();

  const typed = normalizeTag(text);
  const options = suggest(typed, suggestions, tags);
  const expanded = open && options.length > 0;
  const optionId = (index: number) => `${listId}-${index}`;

  // The list scrolls past six or so rows, and the row moved to has to be
  // the one on screen.
  useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  // On a phone the browser scrolls the focused field into view and stops:
  // the keyboard is not part of the page, so a list hanging below a field
  // near the bottom of what is left of the screen opens behind it. So when
  // the list opens or changes size, and when the visible part of the screen
  // shrinks under it as the keyboard slides up, the page is scrolled just far
  // enough to show the list's last row.
  useLayoutEffect(() => {
    if (!expanded) return;
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
  }, [expanded, options.length]);

  function add(names: string[]) {
    const next = [...tags];
    for (const name of names.map(normalizeTag)) {
      if (name && !next.includes(name)) next.push(name);
    }
    if (next.length === tags.length) return;
    onChange(next);
    setAnnouncement(`Added ${next.slice(tags.length).join(", ")}`);
  }

  function remove(tag: string) {
    onChange(tags.filter((t) => t !== tag));
    setAnnouncement(`Removed ${tag}`);
  }

  /** Take the typing, or the suggestion moved to, as a chip. */
  function commit() {
    add([active >= 0 && expanded ? options[active] : text]);
    setText("");
    setActive(-1);
  }

  function pick(option: string) {
    add([option]);
    setText("");
    setActive(-1);
    setOpen(false);
    input.current?.focus();
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const parts = e.target.value.split(",");
    const rest = parts.pop() ?? "";
    if (parts.length > 0) add(parts);
    setText(rest.trimStart());
    setActive(-1);
    setOpen(true);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Mid-composition the keys are the keyboard's own: with a Japanese or
    // Chinese keyboard, Enter picks the characters being composed, and
    // taking it as "add this tag" would add half a word.
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "Enter":
        // Never the form's submit: Enter is how a tag is added, and a second
        // press to add another must not save a recipe half-written.
        e.preventDefault();
        commit();
        break;
      case "Tab":
        // Not prevented: the chip is made and focus moves on as usual.
        commit();
        setOpen(false);
        break;
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const count = options.length;
        if (count === 0) break;
        if (!expanded) {
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
        if (expanded) {
          e.preventDefault();
          setOpen(false);
          setActive(-1);
        }
        break;
      case "Backspace":
        if (text === "" && tags.length > 0) remove(tags[tags.length - 1]);
        break;
    }
  }

  return (
    <div className="tag-input-wrap">
      {/* Clicking the field's padding is clicking the field. */}
      <div
        className="tag-input"
        onClick={(e) => {
          if (e.target === e.currentTarget) input.current?.focus();
        }}
      >
        {tags.map((tag) => (
          <Chip key={tag} tone="green" title={tag}>
            <span className="tag-input-name">{tag}</span>
            <button
              type="button"
              className="tag-input-remove"
              aria-label={`Remove ${tag}`}
              onClick={() => {
                remove(tag);
                input.current?.focus();
              }}
            >
              ✕
            </button>
          </Chip>
        ))}
        <input
          id={id}
          ref={input}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
          value={text}
          maxLength={MAX_TAG_LENGTH}
          placeholder={tags.length === 0 ? "Add a tag…" : "Add another…"}
          // Tags are stored lowercased, so a capital the keyboard adds on its
          // own would only be taken away again.
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="enter"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={() => setOpen(true)}
          onBlur={() => {
            // A press on a suggestion can take focus on some touch browsers
            // before its click arrives; taking the typing as a tag then would
            // add "din" as well as the "dinner" that was tapped.
            if (pressingList.current) {
              pressingList.current = false;
              return;
            }
            commit();
            setOpen(false);
          }}
        />
      </div>
      {expanded && (
        <ul
          className="tag-suggestions"
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Tags already in your recipe box"
          onPointerDown={() => {
            pressingList.current = true;
          }}
          // Keeps focus in the field, so the keyboard stays up on a phone and
          // the field never blurs on the way to the click.
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((option, index) => (
            <li
              key={option}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : undefined}
              onClick={() => {
                pressingList.current = false;
                pick(option);
              }}
            >
              <Highlighted text={option} typed={typed} />
            </li>
          ))}
        </ul>
      )}
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
    </div>
  );
}
