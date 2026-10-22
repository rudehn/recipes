import { Link } from "react-router-dom";

import type { EntryCost, Label, PlannedMeal } from "../../api";
import { LabelPills } from "./LabelPills";
import { MealMenu } from "./MealMenu";
import { PlanFigure } from "./PlanFigure";
import { priced, type EntryActions } from "./plan";

/** One day's one meal: what is planned for it, and the way to plan more. */
export function PlanCell({
  className,
  entries,
  costs,
  dimmed,
  labels,
  onAdd,
  onRemove,
  onChangeServings,
  onSetLabels,
  onCreateLabel,
}: {
  className: string;
  entries: PlannedMeal[];
  costs: Map<string, EntryCost>;
  dimmed: Set<string>;
  labels: Label[];
  onAdd: () => void;
} & EntryActions) {
  return (
    <div className={className}>
      {entries.map((e) => {
        const servings = e.servings ?? e.recipe.servings;
        const cost = costs.get(e.key);
        return (
          <div
            key={e.key}
            className={`plan-entry${dimmed.has(e.key) ? " dimmed" : ""}`}
          >
            <div className="plan-entry-main">
              <Link to={`/recipes/${e.recipe.id}`}>{e.recipe.title}</Link>
              <MealMenu
                meal={e}
                labels={labels}
                onCreateLabel={onCreateLabel}
                onSetLabels={onSetLabels}
                onRemove={onRemove}
              />
            </div>
            <LabelPills labels={e.labels} />
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
