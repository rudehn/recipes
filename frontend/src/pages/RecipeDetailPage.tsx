import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

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
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

export default function RecipeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: recipe, error, reload } = useLoad(
    useCallback(() => api.getRecipe(Number(id)), [id]),
  );
  const action = useAction();
  // Cook-time scaling of the displayed ingredient amounts.
  const [scaledServings, setScaledServings] = useState<number | null>(null);

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
              return (
                <li key={ing.id}>
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
