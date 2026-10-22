import { Link } from "react-router-dom";

import type { EntryCost, PlannedMeal } from "../../api";
import { PlanFigure } from "./PlanFigure";
import { priced, type EntryActions } from "./plan";

/** One day's one meal: what is planned for it, and the way to plan more. */
export function PlanCell({
  className,
  entries,
  costs,
  onAdd,
  onRemove,
  onChangeServings,
}: {
  className: string;
  entries: PlannedMeal[];
  costs: Map<string, EntryCost>;
  onAdd: () => void;
} & EntryActions) {
  return (
    <div className={className}>
      {entries.map((e) => {
        const servings = e.servings ?? e.recipe.servings;
        const cost = costs.get(e.key);
        return (
          <div key={e.key} className="plan-entry">
            <div className="plan-entry-main">
              <Link to={`/recipes/${e.recipe.id}`}>{e.recipe.title}</Link>
              <button
                className="remove"
                aria-label={`Remove ${e.recipe.title}`}
                onClick={() => e.entry_id !== null && onRemove(e.entry_id)}
              >
                ✕
              </button>
            </div>
            {/* The servings and what they cost, the line under the title. A
                recipe that says nothing of servings has no stepper here, and
                still has a cost. */}
            {(servings != null || priced(cost)) && (
              <div className="plan-entry-meta">
                {servings != null && (
                  <div className="serv">
                    <button
                      aria-label="Fewer servings"
                      onClick={() => onChangeServings(e, -1)}
                    >
                      −
                    </button>
                    <span
                      className={e.servings != null ? "overridden" : ""}
                      title={`${servings} serving${servings === 1 ? "" : "s"}`}
                    >
                      ×{servings}
                    </span>
                    <button
                      aria-label="More servings"
                      onClick={() => onChangeServings(e, 1)}
                    >
                      +
                    </button>
                  </div>
                )}
                {priced(cost) && <PlanFigure cost={cost} />}
              </div>
            )}
          </div>
        );
      })}
      <button className="plan-add" onClick={onAdd}>
        + Add
      </button>
    </div>
  );
}
