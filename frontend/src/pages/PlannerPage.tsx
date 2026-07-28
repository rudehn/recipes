import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, type Meal, type MealPlanEntry } from "../api";
import { LoadError } from "../components/LoadError";
import { RecipePickerModal } from "../components/RecipeBits";
import { useLoad } from "../useLoad";
import {
  addDays,
  formatDate,
  formatDay,
  formatRange,
  isToday,
  startOfWeek,
  toISODate,
} from "../dates";

const MEALS: Meal[] = ["breakfast", "lunch", "dinner", "snack"];

export default function PlannerPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [picker, setPicker] = useState<{ date: string; meal: Meal } | null>(null);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekEnd = days[6];

  const { data: entries, error, reload } = useLoad(
    useCallback(
      () => api.listMealPlan(toISODate(weekStart), toISODate(weekEnd)),
      [weekStart, weekEnd],
    ),
  );

  const byCell = useMemo(() => {
    const map = new Map<string, MealPlanEntry[]>();
    for (const e of entries ?? []) {
      const key = `${e.plan_date}|${e.meal}`;
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return map;
  }, [entries]);

  async function addEntry(recipeId: number) {
    if (!picker) return;
    await api.addMealPlanEntry(picker.date, picker.meal, recipeId);
    setPicker(null);
    reload();
  }

  async function removeEntry(id: number) {
    await api.deleteMealPlanEntry(id);
    reload();
  }

  async function changeServings(entry: MealPlanEntry, delta: number) {
    const base = entry.servings ?? entry.recipe.servings;
    if (base == null) return;
    const next = Math.max(1, base + delta);
    // Back to the recipe default? Store null so future recipe edits flow through.
    await api.updateMealPlanServings(
      entry.id,
      next === entry.recipe.servings ? null : next,
    );
    reload();
  }

  async function copyLastWeek() {
    const created = await api.copyWeek(
      toISODate(addDays(weekStart, -7)),
      toISODate(weekStart),
    );
    if (created.length === 0) {
      window.alert("Nothing new to copy from last week.");
    }
    reload();
  }

  return (
    <>
      <div className="page-head">
        <h1>Planner</h1>
        <span className="sub">{formatRange(weekStart, weekEnd)}</span>
        <span className="spacer" />
        <div className="planner-controls">
          <button
            className="btn small"
            onClick={() => setWeekStart((d) => addDays(d, -7))}
            aria-label="Previous week"
          >
            ← Prev
          </button>
          <button className="btn small" onClick={() => setWeekStart(startOfWeek(new Date()))}>
            Today
          </button>
          <button
            className="btn small"
            onClick={() => setWeekStart((d) => addDays(d, 7))}
            aria-label="Next week"
          >
            Next →
          </button>
          <button className="btn small" onClick={copyLastWeek}>
            ⧉ Copy last week
          </button>
          <Link
            to={`/groceries?start=${toISODate(weekStart)}&end=${toISODate(weekEnd)}`}
            className="btn primary small"
          >
            🛒 Grocery list
          </Link>
        </div>
      </div>

      {error && <LoadError what="your meal plan" message={error} onRetry={reload} />}

      {!error && (
      <div className="week-grid">
        <div className="corner" />
        {days.map((d) => (
          <div key={d.toISOString()} className={`day-head${isToday(d) ? " today" : ""}`}>
            <div className="dow">{formatDay(d)}</div>
            <div className="date">{formatDate(d)}</div>
          </div>
        ))}

        {MEALS.map((meal) => (
          <MealRow
            key={meal}
            meal={meal}
            days={days}
            byCell={byCell}
            onAdd={(date) => setPicker({ date, meal })}
            onRemove={removeEntry}
            onChangeServings={changeServings}
          />
        ))}
      </div>
      )}

      {picker && (
        <RecipePickerModal
          title={`Add to ${picker.meal}`}
          onPick={(r) => addEntry(r.id)}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}

function MealRow({
  meal,
  days,
  byCell,
  onAdd,
  onRemove,
  onChangeServings,
}: {
  meal: Meal;
  days: Date[];
  byCell: Map<string, MealPlanEntry[]>;
  onAdd: (date: string) => void;
  onRemove: (id: number) => void;
  onChangeServings: (entry: MealPlanEntry, delta: number) => void;
}) {
  return (
    <>
      <div className="meal-label">{meal}</div>
      {days.map((d) => {
        const iso = toISODate(d);
        const cellEntries = byCell.get(`${iso}|${meal}`) ?? [];
        return (
          <div key={iso} className={`plan-cell${isToday(d) ? " today" : ""}`}>
            {cellEntries.map((e) => {
              const servings = e.servings ?? e.recipe.servings;
              return (
                <div key={e.id} className="plan-entry">
                  <div className="plan-entry-main">
                    <Link to={`/recipes/${e.recipe.id}`}>{e.recipe.title}</Link>
                    <button
                      className="remove"
                      aria-label={`Remove ${e.recipe.title}`}
                      onClick={() => onRemove(e.id)}
                    >
                      ✕
                    </button>
                  </div>
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
                </div>
              );
            })}
            <button className="plan-add" onClick={() => onAdd(iso)}>
              + Add
            </button>
          </div>
        );
      })}
    </>
  );
}
