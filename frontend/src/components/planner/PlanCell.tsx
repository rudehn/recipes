import { Link } from "react-router-dom";

import type { EntryCost, Label, PlannedMeal } from "../../api";
import { LabelPills } from "./LabelPills";
import { MealMenu } from "./MealMenu";
import { PlanFigure } from "./PlanFigure";
import { ScopePrompt } from "./ScopePrompt";
import { priced, type EntryActions } from "./plan";

/** One day's one meal: what is planned for it, and the way to plan more. */
export function PlanCell({
  className,
  entries,
  costs,
  dimmed,
  asking,
  labels,
  onAdd,
  onRemove,
  onChangeServings,
  onAnswerServings,
  onSetLabels,
  onRepeat,
  onCreateLabel,
}: {
  className: string;
  entries: PlannedMeal[];
  costs: Map<string, EntryCost>;
  dimmed: Set<string>;
  asking: ReadonlySet<string>;
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
            className={[
              "plan-entry",
              e.repeat && "repeated",
              dimmed.has(e.key) && "dimmed",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="plan-entry-main">
              <Link to={`/recipes/${e.recipe.id}`}>
                {/* Drawn lighter, and marked: the routine, so the meals chosen
                    for this week stand out from it. Inside the title's first
                    line rather than a column beside it, which would take its
                    width from every line of a title with little to spare. */}
                {e.repeat && (
                  <span className="repeat-mark" role="img" aria-label="Repeats">
                    ↻
                  </span>
                )}
                <span>{e.recipe.title}</span>
              </Link>
              <MealMenu
                meal={e}
                labels={labels}
                onCreateLabel={onCreateLabel}
                onSetLabels={onSetLabels}
                onRemove={onRemove}
                onRepeat={onRepeat}
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
            {asking.has(e.key) && servings != null && (
              <ScopePrompt
                day={e.plan_date}
                question={`Which days get ×${servings}?`}
                onChoose={(scope) => onAnswerServings(e, scope)}
                onCancel={() => onAnswerServings(e, null)}
              />
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
