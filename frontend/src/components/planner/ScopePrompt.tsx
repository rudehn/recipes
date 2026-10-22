import type { Scope } from "../../api";
import { dayName, isPast } from "./plan";

/**
 * The one question a change to a repeated meal asks: is it for this day, or
 * for this day and every one after it.
 *
 * A day that has passed only offers itself, since a repeat never changes the
 * past; changing that one day still records what was really eaten.
 */
export function ScopePrompt({
  day,
  question = "Which days?",
  onChoose,
  onCancel,
}: {
  /** The meal's day, ISO. */
  day: string;
  /** What is about to change, said as a question. */
  question?: string;
  onChoose: (scope: Scope) => void;
  onCancel: () => void;
}) {
  return (
    <div className="scope-prompt" role="group" aria-label={question}>
      <p className="scope-question">{question}</p>
      <button type="button" className="scope-choice" onClick={() => onChoose("day")}>
        Just this day
      </button>
      {!isPast(day) && (
        <button type="button" className="scope-choice" onClick={() => onChoose("from")}>
          From {dayName(day)} on
        </button>
      )}
      <button type="button" className="scope-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
