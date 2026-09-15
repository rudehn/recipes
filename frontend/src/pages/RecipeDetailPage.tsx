import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, type CostLine, type FoodChoice, type LineIssue, type NutritionLine } from "../api";
import { FoodPickerModal, NutritionBreakdown, NutritionStatus } from "../components/Nutrition";
import { ProductPickerModal } from "../components/ProductPicker";
import { RecipePhoto } from "../components/RecipeBits";
import {
  Banner,
  Button,
  Chip,
  Chips,
  EmptyState,
  LinkButton,
  PageHead,
  Panel,
  Toolbar,
} from "../components/ui";
import { formatQuantity } from "../quantity";

const money = (n: number) => `$${n.toFixed(2)}`;

const ROW_ISSUES: Record<LineIssue, string> = {
  amount_in_name: "amount is in the name",
  no_amount: "no amount",
  check_line: "check this line",
  no_match: "nothing matched",
  unsized: "can't size the amount",
  out_of_stock: "out of stock",
};
import { highlightedIngredients } from "../recipeLink";
import { recipeSteps } from "../steps";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

export default function RecipeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: recipe, error, reload } = useLoad(
    useCallback(() => api.getRecipe(Number(id)), [id]),
  );
  // Absent for a household without pricing, and absent again if Kroger is
  // unreachable: a recipe page without a price is the ordinary page, so a
  // failure here is not reported.
  const { data: cost, reload: reloadCost } = useLoad(
    useCallback(() => api.recipeCost(Number(id)), [id]),
  );
  // Bundled on the server, so always answered; a failure here is the server's,
  // and the recipe is still worth showing without it.
  const { data: nutrition, reload: reloadNutrition } = useLoad(
    useCallback(() => api.recipeNutrition(Number(id)), [id]),
  );
  const [explaining, setExplaining] = useState(false);
  const [choosingFor, setChoosingFor] = useState<NutritionLine | null>(null);
  const [pricingFor, setPricingFor] = useState<CostLine | null>(null);
  const nutritionSection = useRef<HTMLDetailsElement | null>(null);
  const action = useAction();
  // Cook-time scaling of the displayed ingredient amounts.
  const [scaledServings, setScaledServings] = useState<number | null>(null);

  // Arriving from a grocery line: the ingredients that line stood for, so the
  // cook lands on the one they tapped instead of hunting a list of twenty.
  const highlighted = useMemo(() => highlightedIngredients(params), [params]);
  const firstHighlighted = useRef<HTMLLIElement | null>(null);

  /**
   * Bring the marked ingredient into view once the recipe is on screen.
   *
   * Scrolled and focused, not just tinted: the ingredients sit below the photo,
   * often past the fold on a phone, where a highlight nobody scrolls to is no
   * answer at all - and focus is what carries the same arrival to a screen
   * reader. The scroll is separate from the focus because focus() alone leaves
   * the row wherever the browser likes, usually flush against an edge.
   *
   * Only when it is actually out of view. Centring a row the cook can already
   * see would scroll the page for nothing, and take the recipe's title under
   * the sticky header on the way. What counts as out of view is the row's own
   * scroll-margin, so the stylesheet keeps the one measurement of the header
   * that hides the top of the page.
   */
  useEffect(() => {
    const ingredient = firstHighlighted.current;
    if (!ingredient) return;
    const clearOfHeader = parseFloat(getComputedStyle(ingredient).scrollMarginTop) || 0;
    const box = ingredient.getBoundingClientRect();
    if (box.top < clearOfHeader || box.bottom > window.innerHeight) {
      ingredient.scrollIntoView({ block: "center" });
    }
    ingredient.focus({ preventScroll: true });
  }, [recipe, highlighted]);

  // Two ways to get here that want different offers: a recipe that is not
  // there, where the only move is back to the list, and a server that could
  // not be asked, where the answer may well be different in a moment. Both are
  // on screen because the message is the server's and we cannot reliably tell
  // them apart from it.
  if (error && !recipe) {
    return (
      <EmptyState glyph="🤷" title={error} role="alert">
        <Toolbar center>
          <Button variant="primary" onClick={reload}>
            Try again
          </Button>
          <LinkButton to="/recipes">Back to recipes</LinkButton>
        </Toolbar>
      </EmptyState>
    );
  }
  if (!recipe) return null;

  const costFactor =
    scaledServings != null && recipe?.servings ? scaledServings / recipe.servings : 1;
  const costLines = new Map((cost?.lines ?? []).map((l) => [l.ingredient_id, l]));

  const steps = recipeSteps(recipe.instructions);
  // Cook mode shows the amounts the stepper is showing, so a doubled recipe
  // is not cooked from the single quantities.
  const cookLink =
    scaledServings != null && scaledServings !== recipe.servings
      ? `/recipes/${recipe.id}/cook?servings=${scaledServings}`
      : `/recipes/${recipe.id}/cook`;

  // Undefined when the link named an ingredient this recipe no longer has,
  // which an edit between reading the grocery list and following it can do.
  // The recipe is still the right page, so it opens as it always would.
  const firstMarked = recipe.ingredients.find((ing) =>
    highlighted.has(String(ing.id)),
  )?.id;

  /** Open the breakdown and bring it into view, from the header's status line. */
  function explainNutrition() {
    setExplaining(true);
    nutritionSection.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function chooseFood(food: FoodChoice | null) {
    const line = choosingFor!;
    setChoosingFor(null);
    if (await action.run(() => api.chooseFood(line.key, food?.fdc_id ?? null))) reloadNutrition();
  }

  /** Pin a product, or say the ingredient is not to be priced. The grocery list's correction. */
  async function pickProduct(productId: string | null) {
    const line = pricingFor!;
    setPricingFor(null);
    if (await action.run(() => api.setMatch(line.key, productId))) reloadCost();
  }

  async function forgetProduct() {
    const line = pricingFor!;
    setPricingFor(null);
    if (await action.run(() => api.forgetMatch(line.key))) reloadCost();
  }

  async function forgetFood(line: NutritionLine) {
    if (await action.run(() => api.forgetFood(line.key))) reloadNutrition();
  }

  async function handleDelete() {
    if (!window.confirm(`Delete “${recipe!.title}”? This also removes it from your meal plan.`)) {
      return;
    }
    if (await action.run(() => api.deleteRecipe(recipe!.id))) navigate("/recipes");
  }

  return (
    <>
      <PageHead title={recipe.title}>
        <Toolbar>
          {steps.length > 0 && (
            <LinkButton variant="primary" to={cookLink}>
              Start cooking
            </LinkButton>
          )}
          <LinkButton to={`/recipes/${recipe.id}/edit`}>Edit</LinkButton>
          <Button variant="danger" onClick={handleDelete}>
            Delete
          </Button>
        </Toolbar>
      </PageHead>

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      <div className="detail-hero">
        <RecipePhoto recipe={recipe} />
        <div>
          {recipe.description && <p>{recipe.description}</p>}
          <Chips>
            {recipe.prep_minutes != null && (
              <Chip tone="accent">Prep {recipe.prep_minutes} min</Chip>
            )}
            {recipe.cook_minutes != null && (
              <Chip tone="accent">Cook {recipe.cook_minutes} min</Chip>
            )}
            {recipe.servings != null && <Chip>Serves {recipe.servings}</Chip>}
            {recipe.tags.map((tag) => (
              <Chip key={tag} tone="green">
                {tag}
              </Chip>
            ))}
          </Chips>
          {cost && cost.priced > 0 && (
            // Coverage is part of the number, not a footnote: "$8.40" with
            // three ingredients unpriced reads exactly like "$8.40" priced in
            // full. Scaled with the stepper, since the shares scale with it.
            <p className="recipe-cost">
              <span className="total">est. {money(cost.total * costFactor)}</span>
              {cost.per_serving !== null && (
                <span className="per-serving">{money(cost.per_serving)} a serving</span>
              )}
              <span className="coverage">
                {cost.priced} of {cost.total_lines} ingredient
                {cost.total_lines === 1 ? "" : "s"} priced · {cost.store.name}
              </span>
            </p>
          )}
          {nutrition && <NutritionStatus nutrition={nutrition} onExplain={explainNutrition} />}
        </div>
      </div>

      <div className="detail-cols">
        <Panel
          title="Ingredients"
          action={
            recipe.servings != null ? (
              <div className="servings-stepper">
                <button
                  aria-label="Fewer servings"
                  onClick={() =>
                    setScaledServings(
                      Math.max(1, (scaledServings ?? recipe.servings!) - 1),
                    )
                  }
                >
                  −
                </button>
                <span>
                  {scaledServings ?? recipe.servings} serving
                  {(scaledServings ?? recipe.servings) === 1 ? "" : "s"}
                </span>
                <button
                  aria-label="More servings"
                  onClick={() =>
                    setScaledServings((scaledServings ?? recipe.servings!) + 1)
                  }
                >
                  +
                </button>
              </div>
            ) : undefined
          }
        >
          <ul className="ingredient-list">
            {recipe.ingredients.map((ing) => {
              const factor =
                scaledServings != null && recipe.servings
                  ? scaledServings / recipe.servings
                  : 1;
              const quantity = ing.quantity != null ? ing.quantity * factor : null;
              const marked = highlighted.has(String(ing.id));
              const costLine = costLines.get(ing.id!);
              return (
                <li
                  key={ing.id}
                  className={marked ? "highlighted" : undefined}
                  // Only the first gets the ref: a grocery line can point at
                  // two rows of one recipe, and scrolling to each in turn would
                  // land on the last rather than the first.
                  ref={marked && ing.id === firstMarked ? firstHighlighted : undefined}
                  // Not in the tab order - nothing here is a control. It takes
                  // focus only because the app sent the cook to this row.
                  tabIndex={marked ? -1 : undefined}
                  aria-current={marked ? "true" : undefined}
                >
                  <span className="qty">{formatQuantity(quantity, ing.unit)}</span>
                  <span>
                    {ing.name}
                    {ing.issue && (
                      // The reason this row will shop wrongly, where the fix
                      // is: the Edit button is at the top of the page.
                      <span className="issue-tag">{ROW_ISSUES[ing.issue]}</span>
                    )}
                  </span>
                  {costLine && costLine.cost !== null && (
                    <button
                      type="button"
                      className="line-cost"
                      // A whole package rather than the share used, because
                      // the amount could not be related to the package. Said
                      // in the row rather than folded silently into the total.
                      title={
                        costLine.whole_package
                          ? "Priced as a whole package: the amount could not be related to it"
                          : undefined
                      }
                      aria-label={`${ing.name}: ${money(costLine.cost * factor)}${
                        costLine.product ? `, ${costLine.product.description}` : ""
                      }. Choose a different product`}
                      onClick={() => setPricingFor(costLine)}
                    >
                      {money(costLine.cost * factor)}
                      {costLine.whole_package && <span className="whole"> whole</span>}
                    </button>
                  )}
                  {costLine && costLine.cost === null && ing.quantity != null && !ing.issue && (
                    // Nothing priced it. Without this the row would say
                    // nothing at all, and offer nothing to fix it with.
                    <button
                      type="button"
                      className="line-cost unmatched"
                      aria-label={`${ing.name}: not priced. Choose a product`}
                      onClick={() => setPricingFor(costLine)}
                    >
                      {costLine.hand_picked ? "not priced" : costLine.product ? "no price" : "no match"}
                    </button>
                  )}
                </li>
              );
            })}
            {recipe.ingredients.length === 0 && (
              <li className="empty-note">No ingredients listed.</li>
            )}
          </ul>
        </Panel>
        <Panel title="Instructions">
          <ol className="steps">
            {steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          {steps.length === 0 && <p className="empty-note">No instructions yet.</p>}
        </Panel>
      </div>

      {nutrition && (
        <NutritionBreakdown
          nutrition={nutrition}
          recipeId={recipe.id}
          // Open by itself when there is something to fix: the header has
          // already said the figure is missing, and the reasons are the answer.
          open={explaining || (nutrition.per_serving === null && nutrition.total_lines > 0)}
          onToggle={setExplaining}
          onChoose={setChoosingFor}
          onForget={forgetFood}
          sectionRef={nutritionSection}
        />
      )}

      {pricingFor && (
        <ProductPickerModal
          line={pricingFor}
          onPick={pickProduct}
          onForget={forgetProduct}
          onClose={() => setPricingFor(null)}
        />
      )}

      {choosingFor && (
        <FoodPickerModal
          line={choosingFor}
          recipeId={recipe.id}
          onPick={chooseFood}
          onClose={() => setChoosingFor(null)}
        />
      )}
    </>
  );
}
