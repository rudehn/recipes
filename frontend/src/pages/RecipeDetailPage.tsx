import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api } from "../api";
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
import { highlightedIngredients } from "../recipeLink";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

export default function RecipeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: recipe, error, reload } = useLoad(
    useCallback(() => api.getRecipe(Number(id)), [id]),
  );
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

  const steps = recipe.instructions
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // Undefined when the link named an ingredient this recipe no longer has,
  // which an edit between reading the grocery list and following it can do.
  // The recipe is still the right page, so it opens as it always would.
  const firstMarked = recipe.ingredients.find((ing) =>
    highlighted.has(String(ing.id)),
  )?.id;

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
                  <span>{ing.name}</span>
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
    </>
  );
}
