import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "react-router-dom";

import { api, type PlannedMeal, type RecipeSummary } from "../api";
import { LoadFailure } from "../components/LoadError";
import { DayAgenda } from "../components/planner/DayAgenda";
import { LabelFilterBar } from "../components/planner/LabelFilter";
import { MealSheet } from "../components/planner/MealSheet";
import { PicksDock } from "../components/planner/PicksDock";
import { PicksPanel } from "../components/planner/PicksPanel";
import { PlaceSheet } from "../components/planner/PlaceSheet";
import { WeekGrid } from "../components/planner/WeekGrid";
import {
  EVERYTHING,
  byCell,
  filterFromParams,
  money,
  shownMeals,
  writeFilter,
  type Costs,
  type EntryActions,
  type LabelFilter,
} from "../components/planner/plan";
import { placingTitle, type CellRef, type Placing } from "../components/planner/placing";
import { useDragGuard } from "../components/planner/useDragGuard";
import { usePlannedServings } from "../components/planner/usePlannedServings";
import { usePlanWrites } from "../components/planner/usePlanWrites";
import { RecipePickerModal } from "../components/RecipeBits";
import { Banner, Button, LinkButton, Modal, PageHead } from "../components/ui";
import { PHONE, PICKS_PANEL, WEEK_GRID, below } from "../layout";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";
import { useMediaQuery } from "../useMediaQuery";
import { addDays, formatRange, startOfWeek, toISODate } from "../dates";

export default function PlannerPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [picker, setPicker] = useState<CellRef | null>(null);
  // What is being put on the plan by pressing it and then a cell.
  const [placing, setPlacing] = useState<Placing | null>(null);
  // What is being dragged onto the plan, from its drag's start to its end.
  // Kept here rather than in the drag's data, which a browser lets no one
  // read until the drop, while the cells need it as soon as they are hovered.
  const [dragging, setDragging] = useState<Placing | null>(null);

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
    loading,
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
  const writes = usePlanWrites({ action, filter, setEntries, reload, reloadLabels });
  const servings = usePlannedServings(entries, action.run, writes.putSaved, reload);
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

  /** Plans the recipe chosen in the picker on the cell that opened it. */
  async function addEntry(recipeId: number) {
    if (picker && (await writes.plan(picker, recipeId))) setPicker(null);
  }

  /** Puts what is being placed on the cell chosen for it, which ends placing it. */
  function place(cell: CellRef) {
    if (!placing) return;
    setPlacing(null);
    void writes.dropOn(cell, placing, false);
  }

  /**
   * Starts or ends a drag. A drag is another way to place, so it lets go of
   * whatever was chosen to place by pressing.
   */
  function drag(next: Placing | null) {
    setDragging(next);
    if (next) setPlacing(null);
  }

  /** Puts what was dragged on the cell it was let go on, which ends the drag. */
  function drop(cell: CellRef, altKey: boolean) {
    const dropped = dragging;
    setDragging(null);
    if (dropped) void writes.dropOn(cell, dropped, altKey);
  }

  useDragGuard(dragging, setDragging);

  // What every cell can do to its meals. The writes report their own
  // failures, so a cell has nothing to wait for.
  const actions: EntryActions = {
    onRemove: (target) => void writes.removeEntry(target),
    onChangeServings: servings.step,
    onAnswerServings: (meal, scope) => void servings.answer(meal, scope),
    onSetLabels: writes.setLabels,
    onRepeat: (meal, weekdays) => void writes.repeat(meal, weekdays),
    onCreateLabel: writes.createLabel,
    onPlacing: setPlacing,
    onDrag: drag,
  };

  /*
   * Seven columns of meals, with the Picks strip beside them, need about
   * 1140px before each meal's title has room for its words, and a phone has
   * a third of that: the grid was 988px wide inside a 343px window, so two
   * days were visible at a time and the sticky label column ate a third of
   * what was left. Below that width the same week is a stack of days
   * instead, which reads top to bottom like the rest of the app.
   */
  const agenda = useMediaQuery(below(WEEK_GRID));
  // Where the Picks panel and the grid do not both fit, the panel folds to a
  // strip whose toggle opens it over the plan's left edge.
  const folded = useMediaQuery(below(WEEK_GRID + PICKS_PANEL));

  /*
   * A phone has room for neither the strip (56px of a 375px screen, with its
   * gap) nor a meal's controls on the meal. The picks open in a sheet from a
   * button instead, and a meal opens a sheet of its own controls.
   */
  const phone = useMediaQuery(below(PHONE));
  const [picksSheet, setPicksSheet] = useState(false);
  // The pick being placed from the Picks sheet, and where the last one went.
  const [toPlace, setToPlace] = useState<RecipeSummary | null>(null);
  const [placedOn, setPlacedOn] = useState<CellRef | null>(null);
  // Where something put from a sheet goes, until the week has loaded again
  // with it: a meal moved off an earlier day shortens that day, which would
  // push a day scrolled to before then up under the top bar.
  const toReveal = useRef<CellRef | null>(null);
  useEffect(() => {
    if (loading || !toReveal.current) return;
    setPlacedOn(toReveal.current);
    toReveal.current = null;
  }, [loading]);
  // The meal whose sheet is open, by key, so the sheet shows each change to
  // it as it lands, and goes once the meal does.
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const sheetMeal =
    phone && sheetKey !== null
      ? (shown(entries ?? []).find((e) => e.key === sheetKey) ?? null)
      : null;

  /**
   * A pick chosen in the Picks sheet is placed from a sheet of its own. The
   * Picks sheet is taken down first, handing focus back to its button, so
   * the next one hands it back there too rather than to a row now gone.
   */
  function choosePick(next: Placing | null) {
    if (next?.kind !== "recipe") return;
    flushSync(() => setPicksSheet(false));
    setToPlace(next.recipe);
  }

  async function placePick(cell: CellRef) {
    if (!toPlace) return false;
    const ok = await writes.plan(cell, toPlace.id);
    if (ok) {
      setToPlace(null);
      toReveal.current = cell;
    }
    return ok;
  }

  /** Moves or copies a meal from its sheet, and brings where it went into view. */
  async function placeMeal(meal: PlannedMeal, cell: CellRef, copy: boolean) {
    if (await writes.dropOn(cell, { kind: "meal", meal, copy }, false)) toReveal.current = cell;
  }

  // Escape lets go of what is being placed. Not an Escape something else has
  // already answered: a meal's menu, the search's suggestions.
  useEffect(() => {
    if (!placing) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setPlacing(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [placing]);

  const week = toISODate(weekStart);
  // Only the week's own meals: the last week's stay up while this one loads,
  // and say nothing about this week's picks.
  const weekMeals = loadedWeek === week ? (entries ?? []) : [];

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
          {phone && (
            <Button size="small" aria-haspopup="dialog" onClick={() => setPicksSheet(true)}>
              Picks
            </Button>
          )}
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
        <div
          className={[
            "planner-body",
            folded && !phone && "picks-collapsed",
            dragging && "dragging",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {!phone && (
            <PicksDock folded={folded} placing={placing} dragging={dragging}>
              <PicksPanel
                week={week}
                meals={weekMeals}
                placing={placing}
                onPlacing={setPlacing}
                onDrag={drag}
              />
            </PicksDock>
          )}
          {agenda ? (
            <DayAgenda
              loadedWeek={loadedWeek}
              days={days}
              byCell={cells}
              costs={costs}
              dimmed={dimmed}
              asking={servings.asking}
              labels={labels ?? []}
              actions={actions}
              placing={placing}
              onAdd={setPicker}
              onPlace={place}
              dragging={dragging}
              onDrop={drop}
              onOpen={phone ? (meal) => setSheetKey(meal.key) : undefined}
              reveal={placedOn}
            />
          ) : (
            <WeekGrid
              days={days}
              byCell={cells}
              costs={costs}
              dimmed={dimmed}
              asking={servings.asking}
              labels={labels ?? []}
              actions={actions}
              placing={placing}
              onAdd={setPicker}
              onPlace={place}
              dragging={dragging}
              onDrop={drop}
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

      {sheetMeal && (
        <MealSheet
          key={sheetMeal.key}
          meal={sheetMeal}
          days={days}
          cost={costs.entries.get(sheetMeal.key)}
          labels={labels ?? []}
          onCreateLabel={writes.createLabel}
          onStepServings={servings.step}
          onChange={writes.changeMeal}
          onRemove={writes.removeEntry}
          onRepeat={writes.repeat}
          onPlace={placeMeal}
          onClose={() => setSheetKey(null)}
        />
      )}

      {phone && picksSheet && (
        <Modal title="Picks" onClose={() => setPicksSheet(false)}>
          <div className="modal-body picks-sheet-body">
            <PicksPanel
              week={week}
              meals={weekMeals}
              placing={null}
              onPlacing={choosePick}
            />
          </div>
        </Modal>
      )}

      {phone && toPlace && (
        <PlaceSheet
          key={toPlace.id}
          recipe={toPlace}
          days={days}
          error={action.error}
          onPlace={placePick}
          onClose={() => setToPlace(null)}
        />
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
