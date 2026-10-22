import { useCallback, useMemo, useState } from "react";

import { api, type Meal, type PlannedMeal } from "../api";
import { LoadFailure } from "../components/LoadError";
import { DayAgenda } from "../components/planner/DayAgenda";
import { WeekGrid } from "../components/planner/WeekGrid";
import { byCell, money, type Costs } from "../components/planner/plan";
import { usePlannedServings } from "../components/planner/usePlannedServings";
import { RecipePickerModal } from "../components/RecipeBits";
import { Banner, Button, LinkButton, PageHead } from "../components/ui";
import { WEEK_GRID, below } from "../layout";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";
import { useMediaQuery } from "../useMediaQuery";
import { addDays, formatRange, startOfWeek, toISODate } from "../dates";

export default function PlannerPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [picker, setPicker] = useState<{ date: string; meal: Meal } | null>(
    null,
  );

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
  const action = useAction();
  const { shown, step: changeServings } = usePlannedServings(
    action.run,
    // The saved entry in place of the loaded one, which also asks for the
    // cost again: the meal's figure follows its new count.
    (saved) =>
      setEntries(
        (prev) => prev?.map((e) => (e.key === saved.key ? saved : e)) ?? prev,
      ),
    // An earlier count in the burst may have landed, so the week is asked
    // for again rather than assumed to be what was loaded.
    reload,
  );

  const cells = useMemo(() => byCell(shown(entries ?? [])), [entries, shown]);

  const costs = useMemo<Costs>(
    () => ({
      days: new Map(cost?.days.map((d) => [d.plan_date, d])),
      entries: new Map(cost?.entries.map((e) => [e.key, e])),
    }),
    [cost],
  );

  async function addEntry(recipeId: number) {
    if (!picker) return;
    if (
      await action.run(() =>
        api.addMealPlanEntry({
          plan_date: picker.date,
          meal: picker.meal,
          recipe_id: recipeId,
        }),
      )
    ) {
      setPicker(null);
      reload();
    }
  }

  async function removeEntry(entryId: number) {
    if (await action.run(() => api.deleteMealPlanEntry(entryId))) reload();
  }

  async function setLabels(meal: PlannedMeal, labelIds: number[]) {
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

  async function createLabel(name: string) {
    const label = await api.createLabel(name);
    reloadLabels();
    return label;
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
            loadedWeek={loadedWeek}
            days={days}
            byCell={cells}
            costs={costs}
            labels={labels ?? []}
            onAdd={setPicker}
            onRemove={removeEntry}
            onChangeServings={changeServings}
            onSetLabels={setLabels}
            onCreateLabel={createLabel}
          />
        ) : (
          <WeekGrid
            days={days}
            byCell={cells}
            costs={costs}
            labels={labels ?? []}
            onAdd={setPicker}
            onRemove={removeEntry}
            onChangeServings={changeServings}
            onSetLabels={setLabels}
            onCreateLabel={createLabel}
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
