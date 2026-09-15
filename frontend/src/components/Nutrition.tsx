import { useCallback, useMemo, useState, type Ref } from "react";
import { Link } from "react-router-dom";

import {
  api,
  type FoodChoice,
  type NutritionIssue,
  type NutritionLine,
  type RecipeNutrition,
} from "../api";
import { useDebounced } from "../useDebounced";
import { useLoad } from "../useLoad";
import { Button, LinkButton, Modal } from "./ui";

/** Why an ingredient is not counted, in the words the recipe rows use. */
const NUTRITION_ISSUES: Record<NutritionIssue, string> = {
  amount_in_name: "amount is in the name",
  no_amount: "no amount",
  check_line: "check this line",
  no_food: "no food chosen",
  unweighable: "can't weigh the amount",
};

/** The reasons whose fix is editing the recipe line rather than choosing a food. */
const RECIPE_SIDE: ReadonlySet<NutritionIssue> = new Set<NutritionIssue>([
  "amount_in_name",
  "no_amount",
  "check_line",
]);

/** How many other recipes are named before the rest are counted instead. */
const NAMED_RECIPES = 3;

/** Whole numbers: a tenth of a gram of fat is precision the data does not have. */
const whole = (n: number) => Math.round(n).toLocaleString("en-US");

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function unmeasured(nutrition: RecipeNutrition): NutritionLine[] {
  return nutrition.lines.filter((line) => !line.measured);
}

/**
 * Nutrition per serving, under the cost in the recipe's header.
 *
 * Either the whole figure or none of it. A recipe with one ingredient that
 * cannot be counted does not show a smaller number with a footnote: calories
 * short by the butter are not roughly right, they are wrong in the way that
 * looks right. So the line says it is unavailable and how much is in the way,
 * and "See why" opens the breakdown where each reason is.
 */
export function NutritionStatus({
  nutrition,
  onExplain,
}: {
  nutrition: RecipeNutrition;
  onExplain: () => void;
}) {
  // Nothing measured at all - an empty recipe, or one made only of things to
  // taste - has nothing to say, rather than a figure of zero.
  if (nutrition.total_lines === 0) return null;

  const figure = nutrition.per_serving;
  // Left to taste, or left out by a person: either way not in the figure.
  const notCounted = nutrition.lines.filter((line) => !line.measured || line.skipped).length;
  if (figure) {
    return (
      <p className="recipe-nutrition">
        <span className="kcal">{whole(figure.kcal)} kcal a serving</span>
        <span className="macros">
          {whole(figure.protein_g)} g protein · {whole(figure.fat_g)} g fat ·{" "}
          {whole(figure.carbs_g)} g carbs · {whole(figure.sodium_mg)} mg sodium
        </span>
        {notCounted > 0 && (
          <span className="coverage">not counting {plural(notCounted, "ingredient")}</span>
        )}
        <button type="button" className="explain" onClick={onExplain}>
          How it&rsquo;s counted
        </button>
      </p>
    );
  }

  const blocked = nutrition.total_lines - nutrition.counted;
  return (
    <p className="recipe-nutrition doubtful">
      <span className="kcal">Nutrition unavailable</span>
      <span className="coverage">
        {blocked > 0
          ? `${blocked} of ${plural(nutrition.total_lines, "ingredient")} can't be counted`
          : "the recipe doesn't say how many it serves"}
      </span>
      <button type="button" className="explain" onClick={onExplain}>
        See why
      </button>
    </p>
  );
}

/**
 * Every ingredient's part in the nutrition, and the way to fix each one.
 *
 * Shown even when the figure is complete, because a complete figure can
 * still be wrong: an ingredient counted as the wrong food is only visible by
 * reading which food it was counted as. Folded unless there is something to
 * fix or someone asked.
 */
export function NutritionBreakdown({
  nutrition,
  recipeId,
  open,
  onToggle,
  onChoose,
  onForget,
  sectionRef,
}: {
  nutrition: RecipeNutrition;
  recipeId: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  onChoose: (line: NutritionLine) => void;
  onForget: (line: NutritionLine) => void;
  sectionRef: Ref<HTMLDetailsElement>;
}) {
  if (nutrition.total_lines === 0) return null;

  const blocked = nutrition.total_lines - nutrition.counted;
  const measured = nutrition.lines.filter((line) => line.measured);
  const toTaste = unmeasured(nutrition);

  return (
    <details
      className="offers-section nutrition-section"
      id="nutrition"
      ref={sectionRef}
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
    >
      <summary>
        Nutrition breakdown
        <span className="count">
          {blocked > 0 ? `${blocked} to fix` : nutrition.servings ? "all counted" : "needs servings"}
        </span>
      </summary>
      <p className="section-note">
        Each ingredient is weighed and counted as a USDA food. A food chosen here holds for every
        recipe that uses the ingredient, and one that doesn&rsquo;t matter to the figure, like a
        garnish, can be left out. An amount that can&rsquo;t be weighed - a can, a bunch - is fixed by
        editing the recipe to give a weight.
      </p>
      {!nutrition.servings && (
        <p className="section-note">
          The recipe doesn&rsquo;t say how many it serves, so there is nothing to divide by.{" "}
          <Link to={`/recipes/${recipeId}/edit`}>Add the servings</Link>.
        </p>
      )}
      <ul className="nutrition-lines">
        {measured.map((line) => {
          const recipeSide = line.issue !== null && RECIPE_SIDE.has(line.issue);
          return (
            <li key={line.ingredient_id} className={line.issue ? "doubtful" : undefined}>
              <span className="what">
                <span className="name">{line.name}</span>
                <span className="food">
                  {line.skipped ? "Not counted" : line.food ? line.food.description : "No food chosen"}
                  {line.hand_picked && <span className="chosen-by"> · your choice</span>}
                </span>
              </span>
              <span className="figures">
                {line.skipped ? null : line.nutrients && line.grams !== null ? (
                  `${whole(line.grams)} g · ${whole(line.nutrients.kcal)} kcal`
                ) : (
                  <span className="issue-tag">{NUTRITION_ISSUES[line.issue ?? "no_food"]}</span>
                )}
              </span>
              <span className="fix">
                {line.skipped ? (
                  <Button size="small" onClick={() => onForget(line)}>
                    Count it
                  </Button>
                ) : recipeSide ? (
                  <LinkButton size="small" to={`/recipes/${recipeId}/edit`}>
                    Edit line
                  </LinkButton>
                ) : (
                  <Button size="small" onClick={() => onChoose(line)}>
                    {line.food ? "Change food" : "Choose food"}
                  </Button>
                )}
                {line.hand_picked && !line.skipped && (
                  <Button size="small" onClick={() => onForget(line)}>
                    Use default
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {toTaste.length > 0 && (
        <p className="section-note">
          Not counted, since the recipe leaves them to taste:{" "}
          {toTaste.map((line) => line.name).join(", ")}.
        </p>
      )}
    </details>
  );
}

/**
 * Choose which USDA food an ingredient means.
 *
 * Starts searched for the ingredient itself, since that is nearly always the
 * right first guess and saves typing it on a phone.
 */
export function FoodPickerModal({
  line,
  recipeId,
  onPick,
  onClose,
}: {
  line: NutritionLine;
  /** The recipe the picker was opened from, which is not an "other" recipe. */
  recipeId: number;
  /** Null: the ingredient does not count. */
  onPick: (food: FoodChoice | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(() => line.key.split("-").join(" "));
  const search = useDebounced(query.trim());
  const { data, error, loading } = useLoad(
    useCallback(() => (search ? api.searchFoods(search) : Promise.resolve([])), [search]),
  );

  // A choice holds for every recipe with this ingredient, so the picker says
  // which ones before it is made. Quiet if it cannot be asked: the choice is
  // no less valid for the list being missing.
  const { data: uses } = useLoad(
    useCallback(() => api.nutritionUses(line.key), [line.key]),
  );
  const others = (uses ?? []).filter((recipe) => recipe.id !== recipeId);
  const named = others.slice(0, NAMED_RECIPES).map((recipe) => recipe.title);
  const unnamed = others.length - named.length;

  // The food in force comes first, whatever the search returns: it is what
  // the reader is deciding whether to keep, and a search ranks the plainest
  // descriptions first, which can bury it several rows down.
  const found = useMemo(() => {
    const current = line.food;
    const rest = (data ?? []).filter((food) => food.fdc_id !== current?.fdc_id);
    return current ? [current, ...rest] : rest;
  }, [data, line.food]);
  return (
    <Modal title={`Food for “${line.name}”`} onClose={onClose}>
      {uses && (
        <p className="modal-reach">
          {others.length === 0
            ? `No other recipe uses “${line.name}” yet. A choice here holds for any that do later.`
            : `Also changes ${plural(others.length, "other recipe")}: ${named.join(", ")}${
                unnamed > 0 ? ` and ${unnamed} more` : ""
              }.`}
        </p>
      )}
      <div className="modal-search">
        <input
          autoFocus
          aria-label="Search foods"
          placeholder="Search USDA foods…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="modal-list">
        {found.map((food) => {
          const chosen = food.fdc_id === line.food?.fdc_id;
          return (
            <button
              key={food.fdc_id}
              type="button"
              className={`modal-food${chosen ? " chosen" : ""}`}
              aria-pressed={chosen}
              onClick={() => onPick(food)}
            >
              <span className="description">{food.description}</span>
              <span className="per">{whole(food.per_100g.kcal)} kcal / 100 g</span>
            </button>
          );
        })}
        {found.length === 0 && (
          <p className="modal-note">
            {error ?? (loading ? "Looking…" : search ? "No foods match that." : "Type to search.")}
          </p>
        )}
        {/* For what does not matter to the figure - a garnish, a sprinkle -
            and for what no food list has, which a misspelling makes of
            anything. */}
        <button type="button" className="modal-food skip" onClick={() => onPick(null)}>
          Don&rsquo;t count this ingredient
        </button>
      </div>
    </Modal>
  );
}
