import { Fragment, useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, type Meal, type MealPlanEntry } from "../api";
import { LoadFailure } from "../components/LoadError";
import { RecipePickerModal } from "../components/RecipeBits";
import { Banner, Button, LinkButton, PageHead } from "../components/ui";
import { WEEK_GRID, below } from "../layout";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";
import { useMediaQuery } from "../useMediaQuery";
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

/** The entries of one day's one meal, keyed the way byCell holds them. */
type Cells = Map<string, MealPlanEntry[]>;

/** What either layout can do to an entry already in a cell. */
interface EntryActions {
  onRemove: (id: number) => void;
  onChangeServings: (entry: MealPlanEntry, delta: number) => void;
}

const money = (n: number) => `$${n.toFixed(2)}`;

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
  // Asked once the entries are in, and again whenever they change, since
  // adding a meal changes the answer. Null for a household without pricing,
  // and a failure is not reported: a planner without a price is the
  // ordinary planner.
  const { data: cost } = useLoad(
    useCallback(
      async () =>
        entries ? api.planCost(toISODate(weekStart), toISODate(weekEnd)) : null,
      [weekStart, weekEnd, entries],
    ),
  );
  const action = useAction();

  const byCell = useMemo(() => {
    const map: Cells = new Map();
    for (const e of entries ?? []) {
      const key = `${e.plan_date}|${e.meal}`;
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return map;
  }, [entries]);

  async function addEntry(recipeId: number) {
    if (!picker) return;
    if (await action.run(() => api.addMealPlanEntry(picker.date, picker.meal, recipeId))) {
      setPicker(null);
      reload();
    }
  }

  async function removeEntry(id: number) {
    if (await action.run(() => api.deleteMealPlanEntry(id))) reload();
  }

  async function changeServings(entry: MealPlanEntry, delta: number) {
    const base = entry.servings ?? entry.recipe.servings;
    if (base == null) return;
    const next = Math.max(1, base + delta);
    // Back to the recipe default? Store null so future recipe edits flow through.
    const saved = await action.run(() =>
      api.updateMealPlanServings(entry.id, next === entry.recipe.servings ? null : next),
    );
    if (saved) reload();
  }

  async function copyLastWeek() {
    let created: MealPlanEntry[] = [];
    const copied = await action.run(async () => {
      created = await api.copyWeek(toISODate(addDays(weekStart, -7)), toISODate(weekStart));
    });
    if (!copied) return;
    if (created.length === 0) {
      window.alert("Nothing new to copy from last week.");
    }
    reload();
  }

  /*
   * Seven columns of meals need about 900px before they stop scrolling
   * sideways, and a phone has a third of that: the grid was 988px wide inside
   * a 343px window, so two days were visible at a time and the sticky label
   * column ate a third of what was left. Below that width the same week is a
   * stack of days instead, which reads top to bottom like the rest of the app.
   */
  const agenda = useMediaQuery(below(WEEK_GRID));

  return (
    <>
      <PageHead title="Planner" sub={formatRange(weekStart, weekEnd)}>
        <div className="planner-controls">
          {/* The three that move the same thing, grouped so they stay on one
              line together when the row wraps under a narrow heading. */}
          <div className="week-step">
            <Button
              size="small"
              onClick={() => setWeekStart((d) => addDays(d, -7))}
              aria-label="Previous week"
            >
              ← Prev
            </Button>
            <Button size="small" onClick={() => setWeekStart(startOfWeek(new Date()))}>
              Today
            </Button>
            <Button
              size="small"
              onClick={() => setWeekStart((d) => addDays(d, 7))}
              aria-label="Next week"
            >
              Next →
            </Button>
          </div>
          <Button size="small" onClick={copyLastWeek}>
            ⧉ Copy last week
          </Button>
          <LinkButton
            variant="primary"
            size="small"
            to={`/groceries?start=${toISODate(weekStart)}&end=${toISODate(weekEnd)}`}
          >
            🛒 Grocery list
          </LinkButton>
        </div>
      </PageHead>

      {cost && cost.priced > 0 && (
        // Two numbers on purpose. Cooking prices the share of each package the
        // meals use; shopping prices whole packages. The gap is what is left in
        // the cupboard after the week, and is worth seeing rather than hiding.
        <div className="pricing-summary">
          <span className="total">est. {money(cost.total)} to cook</span>
          <span className="coverage">
            {cost.priced} of {cost.total_lines} ingredient
            {cost.total_lines === 1 ? "" : "s"} priced
          </span>
          {cost.grocery_total !== null && (
            <span className="coverage">
              about {money(cost.grocery_total)} to shop for, in whole packages
            </span>
          )}
          <span className="store">{cost.store.name}</span>
        </div>
      )}

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      {error && (
        <LoadFailure
          what="your meal plan"
          message={error}
          onRetry={reload}
          showing={entries !== null}
        />
      )}

      {/* The empty week is also what a first load looks like, so it stays up
          unless the page has nothing and no prospect of any. */}
      {!(error && entries === null) &&
        (agenda ? (
          <DayAgenda
            days={days}
            byCell={byCell}
            onAdd={setPicker}
            onRemove={removeEntry}
            onChangeServings={changeServings}
          />
        ) : (
          <WeekGrid
            days={days}
            byCell={byCell}
            onAdd={setPicker}
            onRemove={removeEntry}
            onChangeServings={changeServings}
          />
        ))}

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

interface LayoutProps extends EntryActions {
  days: Date[];
  byCell: Cells;
  /** Opens the picker on the day and meal that asked for it. */
  onAdd: (cell: { date: string; meal: Meal }) => void;
}

/**
 * The week as a grid: a row per meal, a column per day.
 *
 * Row-major, because that is the order a CSS grid fills itself in - the meal
 * label, then its seven days, then the next meal.
 */
function WeekGrid({ days, byCell, onAdd, onRemove, onChangeServings }: LayoutProps) {
  return (
    <div className="week-grid">
      <div className="corner" />
      {days.map((d) => (
        <div key={d.toISOString()} className={`day-head${isToday(d) ? " today" : ""}`}>
          <div className="dow">{formatDay(d)}</div>
          <div className="date">{formatDate(d)}</div>
        </div>
      ))}

      {/* A fragment, not a wrapper: the cells are the grid's own children, and
          anything between them would be the thing placed in a track instead. */}
      {MEALS.map((meal) => (
        <Fragment key={meal}>
          <div className="meal-label">{meal}</div>
          {days.map((d) => {
            const iso = toISODate(d);
            return (
              <PlanCell
                key={iso}
                className={`plan-cell${isToday(d) ? " today" : ""}`}
                entries={byCell.get(`${iso}|${meal}`) ?? []}
                onAdd={() => onAdd({ date: iso, meal })}
                onRemove={onRemove}
                onChangeServings={onChangeServings}
              />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The same week as a stack of days, each listing its four meals.
 *
 * Day-major, which is how a week is read on a phone: you scroll to Thursday
 * and see all of Thursday, rather than scrolling sideways to Thursday four
 * separate times to collect its meals one row at a time.
 */
function DayAgenda({ days, byCell, onAdd, onRemove, onChangeServings }: LayoutProps) {
  return (
    <div className="day-agenda">
      {days.map((d) => {
        const iso = toISODate(d);
        const today = isToday(d);
        return (
          <section key={iso} className={`agenda-day${today ? " today" : ""}`}>
            <h2 className="day-head">
              <span className="dow">{formatDay(d)}</span>
              <span className="date">{formatDate(d)}</span>
              {today && <span className="today-tag">Today</span>}
            </h2>
            {MEALS.map((meal) => (
              <div key={meal} className="agenda-meal">
                <div className="meal-label">{meal}</div>
                <PlanCell
                  className="plan-cell"
                  entries={byCell.get(`${iso}|${meal}`) ?? []}
                  onAdd={() => onAdd({ date: iso, meal })}
                  onRemove={onRemove}
                  onChangeServings={onChangeServings}
                />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** One day's one meal: what is planned for it, and the way to plan more. */
function PlanCell({
  className,
  entries,
  onAdd,
  onRemove,
  onChangeServings,
}: {
  className: string;
  entries: MealPlanEntry[];
  onAdd: () => void;
} & EntryActions) {
  return (
    <div className={className}>
      {entries.map((e) => {
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
                <button aria-label="Fewer servings" onClick={() => onChangeServings(e, -1)}>
                  −
                </button>
                <span
                  className={e.servings != null ? "overridden" : ""}
                  title={`${servings} serving${servings === 1 ? "" : "s"}`}
                >
                  ×{servings}
                </span>
                <button aria-label="More servings" onClick={() => onChangeServings(e, 1)}>
                  +
                </button>
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
