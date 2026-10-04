import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api, type DayCost, type EntryCost, type Meal, type MealPlanEntry } from "../api";
import { LoadFailure } from "../components/LoadError";
import { RecipePickerModal } from "../components/RecipeBits";
import { Banner, Button, LinkButton, PageHead } from "../components/ui";
import { WEEK_GRID, below } from "../layout";
import { type Action, useAction } from "../useAction";
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

/** A figure and how much of it is priced, which a day and a meal both carry. */
type Costed = Pick<DayCost, "total" | "priced" | "total_lines">;

/** What each day and each planned meal costs, for the layouts to look up. */
interface Costs {
  days: Map<string, DayCost>;
  entries: Map<number, EntryCost>;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Whether a figure has anything priced in it to show. */
const priced = (cost: Costed | undefined): cost is Costed => cost !== undefined && cost.priced > 0;

export default function PlannerPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [picker, setPicker] = useState<{ date: string; meal: Meal } | null>(null);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekEnd = days[6];

  const {
    data: entries,
    setData: setEntries,
    error,
    reload,
  } = useLoad(
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
  const { shown, step: changeServings } = usePlannedServings(
    action.run,
    // The saved entry in place of the loaded one, which also asks for the
    // cost again: the meal's figure follows its new count.
    (saved) => setEntries((prev) => prev?.map((e) => (e.id === saved.id ? saved : e)) ?? prev),
    // An earlier count in the burst may have landed, so the week is asked
    // for again rather than assumed to be what was loaded.
    reload,
  );

  const byCell = useMemo(() => {
    const map: Cells = new Map();
    for (const e of shown(entries ?? [])) {
      const key = `${e.plan_date}|${e.meal}`;
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return map;
  }, [entries, shown]);

  const costs = useMemo<Costs>(
    () => ({
      days: new Map(cost?.days.map((d) => [d.plan_date, d])),
      entries: new Map(cost?.entries.map((e) => [e.entry_id, e])),
    }),
    [cost],
  );

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
   * Seven columns of meals need about 1100px before each meal's title has
   * room for its words, and a phone has a third of that: the grid was 988px
   * wide inside a 343px window, so two days were visible at a time and the
   * sticky label column ate a third of what was left. Below that width the
   * same week is a stack of days instead, which reads top to bottom like the
   * rest of the app.
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
            costs={costs}
            onAdd={setPicker}
            onRemove={removeEntry}
            onChangeServings={changeServings}
          />
        ) : (
          <WeekGrid
            days={days}
            byCell={byCell}
            costs={costs}
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
  costs: Costs;
  /** Opens the picker on the day and meal that asked for it. */
  onAdd: (cell: { date: string; meal: Meal }) => void;
}

/**
 * The week as a grid: a row per meal, a column per day.
 *
 * Row-major, because that is the order a CSS grid fills itself in - the meal
 * label, then its seven days, then the next meal.
 */
function WeekGrid({ days, byCell, costs, onAdd, onRemove, onChangeServings }: LayoutProps) {
  return (
    <div className="week-grid">
      <div className="corner" />
      {days.map((d) => {
        const cost = costs.days.get(toISODate(d));
        return (
          <div key={d.toISOString()} className={`day-head${isToday(d) ? " today" : ""}`}>
            <div className="dow">{formatDay(d)}</div>
            <div className="date">{formatDate(d)}</div>
            {priced(cost) && <PlanFigure cost={cost} />}
          </div>
        );
      })}

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
                costs={costs.entries}
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
function DayAgenda({ days, byCell, costs, onAdd, onRemove, onChangeServings }: LayoutProps) {
  return (
    <div className="day-agenda">
      {days.map((d) => {
        const iso = toISODate(d);
        const today = isToday(d);
        const cost = costs.days.get(iso);
        return (
          <section key={iso} className={`agenda-day${today ? " today" : ""}`}>
            <h2 className="day-head">
              <span className="dow">{formatDay(d)}</span>
              <span className="date">{formatDate(d)}</span>
              {today && <span className="today-tag">Today</span>}
              {priced(cost) && <PlanFigure cost={cost} />}
            </h2>
            {MEALS.map((meal) => (
              <div key={meal} className="agenda-meal">
                <div className="meal-label">{meal}</div>
                <PlanCell
                  className="plan-cell"
                  entries={byCell.get(`${iso}|${meal}`) ?? []}
                  costs={costs.entries}
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
  costs,
  onAdd,
  onRemove,
  onChangeServings,
}: {
  className: string;
  entries: MealPlanEntry[];
  costs: Map<number, EntryCost>;
  onAdd: () => void;
} & EntryActions) {
  return (
    <div className={className}>
      {entries.map((e) => {
        const servings = e.servings ?? e.recipe.servings;
        const cost = costs.get(e.id);
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
            {/* The servings and what they cost, the line under the title. A
                recipe that says nothing of servings has no stepper here, and
                still has a cost. */}
            {(servings != null || priced(cost)) && (
              <div className="plan-entry-meta">
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

/**
 * What a day or a meal costs to cook, as far as it is known.
 *
 * Shown plain when every ingredient is priced, and as "$6.20+" when only some
 * are: the figure is then a floor, and a bare number would read as the whole.
 * The plus is shorthand a screen reader cannot speak, so the words travel in
 * the title and the accessible name. The role is what lets that name be read
 * at all; a label on a plain span is one assistive tech may skip.
 */
function PlanFigure({ cost }: { cost: Costed }) {
  const floor = cost.priced < cost.total_lines;
  const label =
    `${floor ? "at least " : ""}${money(cost.total)}, ` +
    `${cost.priced} of ${cost.total_lines} ingredient${cost.total_lines === 1 ? "" : "s"} priced`;
  return (
    <span className="plan-cost" role="img" aria-label={label} title={label}>
      {money(cost.total)}
      {floor && "+"}
    </span>
  );
}

/**
 * A count as it is stored. The recipe's own count is null, so a later edit to
 * the recipe flows through to the meals planned from it.
 */
const asStored = (entry: MealPlanEntry, count: number) =>
  count === entry.recipe.servings ? null : count;

/**
 * Planned servings, stepped a tap at a time and saved one write at a time.
 *
 * A tap used to count from the servings the page last loaded, save, and
 * reload. Two taps inside one round trip both counted from four, so a meal
 * tapped up twice landed on five rather than six. Here a tap counts from the
 * tap before it and shows at once, before the server has answered.
 *
 * Only one write per meal is out at a time, carrying the newest count when it
 * leaves, and a tap made meanwhile is sent when it lands. So an older count
 * can never land after a newer one, and a burst of taps costs two writes
 * rather than one each.
 */
function usePlannedServings(
  run: Action["run"],
  onSaved: (saved: MealPlanEntry) => void,
  onFailed: () => void,
) {
  // The count each meal has been stepped to and not yet saved. The ref is
  // what the next tap counts from, so taps between two renders still add up;
  // the state is the same map, for drawing.
  const stepped = useRef(new Map<number, number>());
  const [counts, setCounts] = useState<ReadonlyMap<number, number>>(() => new Map());
  const saving = useRef(new Set<number>());

  // The page's newest callbacks, since a write can outlive the render that
  // sent it: one that fails after moving to another week reloads that week.
  const callbacks = useRef({ onSaved, onFailed });
  useEffect(() => {
    callbacks.current = { onSaved, onFailed };
  });

  function set(id: number, count: number | undefined) {
    const next = new Map(stepped.current);
    if (count === undefined) next.delete(id);
    else next.set(id, count);
    stepped.current = next;
    setCounts(next);
  }

  async function save(entry: MealPlanEntry) {
    saving.current.add(entry.id);
    const result: { saved?: MealPlanEntry } = {};
    let sent: number | undefined;
    let ok = true;
    // Looked at again after every write: a tap made while it was out goes next.
    while (ok && stepped.current.get(entry.id) !== sent) {
      const count = stepped.current.get(entry.id)!;
      sent = count;
      ok = await run(async () => {
        result.saved = await api.updateMealPlanServings(entry.id, asStored(entry, count));
      });
    }
    saving.current.delete(entry.id);
    // In the same tick as the callback, so the count never flickers back to
    // the loaded one between the two.
    set(entry.id, undefined);
    if (ok && result.saved) callbacks.current.onSaved(result.saved);
    else callbacks.current.onFailed();
  }

  function step(entry: MealPlanEntry, delta: number) {
    const base = stepped.current.get(entry.id) ?? entry.servings ?? entry.recipe.servings;
    if (base == null) return;
    set(entry.id, Math.max(1, base + delta));
    if (!saving.current.has(entry.id)) void save(entry);
  }

  /** The entries with every count still being saved shown as it will be. */
  const shown = useCallback(
    (entries: MealPlanEntry[]) =>
      counts.size === 0
        ? entries
        : entries.map((e) => {
            const count = counts.get(e.id);
            return count === undefined ? e : { ...e, servings: asStored(e, count) };
          }),
    [counts],
  );

  return { shown, step };
}
