import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, type Recipe } from "../api";
import { RecipePhoto, formatQuantity } from "../components/RecipeBits";

export default function RecipeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cook-time scaling of the displayed ingredient amounts.
  const [scaledServings, setScaledServings] = useState<number | null>(null);

  useEffect(() => {
    api
      .getRecipe(Number(id))
      .then(setRecipe)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="empty-state">
        <div className="glyph">🤷</div>
        <h2>{error}</h2>
        <p>
          <Link to="/recipes" className="btn">
            Back to recipes
          </Link>
        </p>
      </div>
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
    await api.deleteRecipe(recipe!.id);
    navigate("/recipes");
  }

  return (
    <>
      <div className="page-head">
        <h1>{recipe.title}</h1>
        <span className="spacer" />
        <div className="toolbar">
          <Link to={`/recipes/${recipe.id}/edit`} className="btn">
            Edit
          </Link>
          <button className="btn danger" onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className="detail-hero">
        <RecipePhoto recipe={recipe} />
        <div>
          {recipe.description && <p>{recipe.description}</p>}
          <div className="chips">
            {recipe.prep_minutes != null && (
              <span className="chip accent">Prep {recipe.prep_minutes} min</span>
            )}
            {recipe.cook_minutes != null && (
              <span className="chip accent">Cook {recipe.cook_minutes} min</span>
            )}
            {recipe.servings != null && (
              <span className="chip">Serves {recipe.servings}</span>
            )}
            {recipe.tags.map((tag) => (
              <span key={tag} className="chip green">
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="detail-cols">
        <div className="panel">
          <div className="panel-head">
            <h2>Ingredients</h2>
            {recipe.servings != null && (
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
            )}
          </div>
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
              <li style={{ color: "var(--muted)" }}>No ingredients listed.</li>
            )}
          </ul>
        </div>
        <div className="panel">
          <h2>Instructions</h2>
          <ol className="steps">
            {steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          {steps.length === 0 && (
            <p style={{ color: "var(--muted)", margin: 0 }}>No instructions yet.</p>
          )}
        </div>
      </div>
    </>
  );
}
