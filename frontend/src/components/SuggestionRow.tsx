import type { ReactNode } from "react";

import type { MergeSuggestion } from "../api";
import { Button } from "./ui";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A suggested merge, put as a question with its two answers.
 *
 * The app never merges by itself (ADR 10); turning a pair down costs one
 * tap and is remembered, which is the price of never guessing silently.
 * `merge` is the control that starts the merge: a link from the list, which
 * opens the ingredient's page with the preview, or a button on the page.
 */
export function SuggestionRow({
  suggestion,
  merge,
  onDismiss,
}: {
  suggestion: MergeSuggestion;
  merge: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className="suggestion-row">
      <span className="question">
        {capitalized(suggestion.from_name)} and {suggestion.to_name} look like the same thing to buy.
      </span>
      <span className="answers">
        {merge}
        <Button size="small" onClick={onDismiss}>
          Not the same
        </Button>
      </span>
    </div>
  );
}
