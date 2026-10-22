import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, type PlannedMeal } from "../api";
import { LoadFailure } from "../components/LoadError";
import { DayAgenda } from "../components/planner/DayAgenda";
import { PicksPanel } from "../components/planner/PicksPanel";
import { WeekGrid } from "../components/planner/WeekGrid";
import { LabelFilterBar } from "../components/planner/LabelFilter";
import {
  EVERYTHING,
  byCell,
  filterFromParams,
  labelsForNew,
  money,
  shownMeals,
  writeFilter,
  type ChangeTarget,
  type Costs,
  type LabelFilter,
} from "../components/planner/plan";
import { placingTitle, type CellRef, type Placing } from "../components/planner/placing";
import { usePlannedServings } from "../components/planner/usePlannedServings";
import { RecipePickerModal } from "../components/RecipeBits";
import { Banner, Button, LinkButton, PageHead } from "../components/ui";
import { PICKS_PANEL, WEEK_GRID, below } from "../layout";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";
import { useMediaQuery } from "../useMediaQuery";
import { addDays, formatRange, startOfWeek, toISODate } from "../dates";

export default function PlannerPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [picker, setPicker] = useState<CellRef | null>(null);
  // What is being put on the plan by pressing it and then a cell.
  const [placing, setPlacing] = useState<Placing | null>(null);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekEnd = days[6];

  // The week the entries were last loaded for: the entries themselves stay
  // up from the week before while the next one is asked for.
  const [loadedWeek, setLoadedWeek] = useState<string | null>(null);

  const {
    data: entries,
    setData: setEntries,
    error,
    reload,
  } = useLoad(
    useCallback(async () => {
      const meals = await api.listMealPlan(
        toISODate(weekStart),
        toISODate(weekEnd),
      );
      setLoadedWeek(toISODate(weekStart));
      return meals;
    }, [weekStart, weekEnd]),
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
  // The labels to choose from. A failed load leaves the checklists empty
  // rather than the planner unusable.
  const { data: labels, reload: reloadLabels } = useLoad(
    useCallback(() => api.listLabels(), []),
  );
  // The filter lives in the URL, so a reload or a shared link keeps it. A
  // label that has since been deleted is Everything, not an empty week.
  const [searchParams, setSearchParams] = useSearchParams();
  // Until the labels are known the URL's choice stands, so a reload does not
  // flash the whole week, nor add a meal without its label.
  const filter = useMemo<LabelFilter>(() => {
    const requested = filterFromParams(searchParams);
    return labels && !labels.some((l) => l.id === requested.label) ? EVERYTHING : requested;
  }, [searchParams, labels]);
  const setFilter = (f: LabelFilter) =>
    setSearchParams((p) => writeFilter(f, new URLSearchParams(p)), { replace: true });

  const action = useAction();
  const servings = usePlannedServings(
    entries,
    action.run,
    // The saved entry in place of the loaded one, which also asks for the
    // cost again: the meal's figure follows its new count.
    (saved) =>
      setEntries(
        (prev) => prev?.map((e) => (e.key === saved.key ? saved : e)) ?? prev,
      ),
    reload,
  );
  const { shown } = servings;

  // The filter changes what the grid shows and nothing else: the costs and
  // the Grocery list link below stay on the whole plan.
  const { cells, dimmed } = useMemo(() => {
    const visible = shownMeals(shown(entries ?? []), filter);
    return {
      cells: byCell(visible.map((v) => v.meal)),
      dimmed: new Set(visible.filter((v) => v.dimmed).map((v) => v.meal.key)),
    };
  }, [entries, shown, filter]);

  const costs = useMemo<Costs>(
    () => ({
      days: new Map(cost?.days.map((d) => [d.plan_date, d])),
      entries: new Map(cost?.entries.map((e) => [e.key, e])),
    }),
    [cost],
  );

  /** Plans a recipe on a cell, as a one-off with the recipe's own servings. */
  function addMeal({ date, meal }: CellRef, recipeId: number) {
    return action.run(() =>
      api.addMealPlanEntry({
        plan_date: date,
        meal,
        recipe_id: recipeId,
        // Every way of adding a meal passes this: the selected label.
        ...(labelsForNew(filter).length > 0 && { label_ids: labelsForNew(filter) }),
      }),
    );
  }

  async function addEntry(recipeId: number) {
    if (!picker) return;
    if (await addMeal(picker, recipeId)) {
      setPicker(null);
      reload();
    }
  }

  /** Puts the recipe being placed on the cell chosen for it, which ends placing it. */
  async function place(cell: CellRef) {
    if (placing?.kind !== "recipe") return;
    setPlacing(null);
    if (await addMeal(cell, placing.recipe.id)) reload();
  }

  /*
   * A repeated meal is changed through its repeat, never as a row of its
   * own: even a day that already has a row (changed on its own before) is
   * still the repeat's, and its Just this day goes through the repeat too.
   * A change from a day on reaches days other than the one shown, so the week
   * is loaded again after any of them.
   */

  async function removeEntry(target: ChangeTarget) {
    let write: () => Promise<void>;
    if (target.length === 2) {
      const [meal, scope] = target;
      write = () => api.removeRepeatDay(meal.repeat.id, meal.plan_date, scope);
    } else {
      const [{ entry_id }] = target;
      if (entry_id === null) return;
      write = () => api.deleteMealPlanEntry(entry_id);
    }
    if (await action.run(write)) reload();
  }

  async function setLabels(target: ChangeTarget, labelIds: number[]) {
    if (target.length === 2) {
      const [meal, scope] = target;
      if (
        await action.run(() =>
          api.changeRepeatDay(meal.repeat.id, meal.plan_date, { scope, label_ids: labelIds }),
        )
      ) {
        reload();
        reloadLabels();
      }
      return;
    }
    const [meal] = target;
    if (meal.entry_id === null) return;
    const entryId = meal.entry_id;
    let saved: PlannedMeal | undefined;
    const ok = await action.run(async () => {
      saved = await api.updateMealPlanEntry(entryId, { label_ids: labelIds });
    });
    // The saved entry in place of the loaded one, and the counts beside the
    // labels are asked for again.
    if (ok && saved) {
      setEntries((prev) => prev?.map((e) => (e.key === saved!.key ? saved! : e)) ?? prev);
      reloadLabels();
    } else {
      reload();
    }
  }

  /**
   * A one-off starts repeating from its day; a repeat's days change from this
   * day on, and Just this day ends it after this day. Choosing what a meal
   * already does changes nothing.
   */
  async function repeat(meal: PlannedMeal, weekdays: number[] | null) {
    const current = meal.repeat?.weekdays ?? null;
    if (weekdays === null ? current === null : current?.join() === weekdays.join()) return;
    let write: () => Promise<unknown>;
    if (!meal.repeat) {
      if (meal.entry_id === null || weekdays === null) return;
      const entryId = meal.entry_id;
      write = () => api.startRepeat(entryId, weekdays);
    } else {
      const repeatId = meal.repeat.id;
      write =
        weekdays === null
          ? () => api.stopRepeat(repeatId, meal.plan_date)
          : () => api.changeRepeatDay(repeatId, meal.plan_date, { scope: "from", weekdays });
    }
    if (await action.run(write)) reload();
  }

  async function createLabel(name: string) {
    const label = await api.createLabel(name);
    reloadLabels();
    return label;
  }

  /*
   * Seven columns of meals, with the Picks strip beside them, need about
   * 1140px before each meal's title has room for its words, and a phone has
   * a third of that: the grid was 988px
   * wide inside a 343px window, so two days were visible at a time and the
   * sticky label column ate a third of what was left. Below that width the
   * same week is a stack of days instead, which reads top to bottom like the
   * rest of the app.
   */
  const agenda = useMediaQuery(below(WEEK_GRID));
  // Where the Picks panel and the grid do not both fit, the panel folds to a
  // strip whose toggle opens it over the plan's left edge.
  const folded = useMediaQuery(below(WEEK_GRID + PICKS_PANEL));
  const [picksOpen, setPicksOpen] = useState(false);
  const picksDock = useRef<HTMLDivElement>(null);
  const picksId = useId();
  const overlaid = folded && picksOpen;

  /** Starts or stops placing; a folded panel is put away so every cell can be chosen. */
  function choosePlacing(next: Placing | null) {
    setPlacing(next);
    if (next) setPicksOpen(false);
  }

  // Escape lets go of what is being placed, or else puts the opened panel
  // away. Not an Escape something else has already answered: a meal's menu,
  // the search's suggestions.
  useEffect(() => {
    if (!placing && !overlaid) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (placing) setPlacing(null);
      else setPicksOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [placing, overlaid]);

  // A press anywhere outside the opened panel puts it away, as a menu would.
  useEffect(() => {
    if (!overlaid) return;
    function onPointerDown(event: MouseEvent) {
      if (!picksDock.current?.contains(event.target as Node)) setPicksOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [overlaid]);

  const week = toISODate(weekStart);

  // The wrapper is what widens the page for the Picks panel (see
  // .planner-page in styles.css), whatever the page shows.
  return (
    <div className="planner-page">
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
            <Button
              size="small"
              onClick={() => setWeekStart(startOfWeek(new Date()))}
            >
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

      {labels && labels.length > 0 && (
        <LabelFilterBar labels={labels} filter={filter} onChange={setFilter} />
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
      {!(error && entries === null) && (
        <div className={`planner-body${folded ? " picks-collapsed" : ""}`}>
          <div className="picks-dock" ref={picksDock}>
            {folded && (
              <button
                type="button"
                className="picks-toggle"
                aria-expanded={picksOpen}
                aria-controls={picksId}
                onClick={() => setPicksOpen((open) => !open)}
              >
                Picks
              </button>
            )}
            {/* Kept while folded away, so a search there is still there
                when it opens again. */}
            <div className="picks-sheet" id={picksId} hidden={folded && !picksOpen}>
              <PicksPanel
                week={week}
                // Only the week's own meals: the last week's stay up while
                // this one loads, and say nothing about this week's picks.
                meals={loadedWeek === week ? (entries ?? []) : []}
                placing={placing}
                onPlacing={choosePlacing}
              />
            </div>
          </div>
          {agenda ? (
            <DayAgenda
              loadedWeek={loadedWeek}
              days={days}
              byCell={cells}
              costs={costs}
              dimmed={dimmed}
              asking={servings.asking}
              labels={labels ?? []}
              placing={placing}
              onAdd={setPicker}
              onPlace={place}
              onRemove={removeEntry}
              onChangeServings={servings.step}
              onAnswerServings={servings.answer}
              onSetLabels={setLabels}
              onRepeat={repeat}
              onCreateLabel={createLabel}
            />
          ) : (
            <WeekGrid
              days={days}
              byCell={cells}
              costs={costs}
              dimmed={dimmed}
              asking={servings.asking}
              labels={labels ?? []}
              placing={placing}
              onAdd={setPicker}
              onPlace={place}
              onRemove={removeEntry}
              onChangeServings={servings.step}
              onAnswerServings={servings.answer}
              onSetLabels={setLabels}
              onRepeat={repeat}
              onCreateLabel={createLabel}
            />
          )}
        </div>
      )}

      {placing && (
        <div className="placing-bar" role="status">
          <span>
            Choose a day and meal for <strong>{placingTitle(placing)}</strong>
          </span>
          <Button size="small" onClick={() => setPlacing(null)}>
            Cancel
          </Button>
        </div>
      )}

      {picker && (
        <RecipePickerModal
          title={`Add to ${picker.meal}`}
          onPick={(r) => addEntry(r.id)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
