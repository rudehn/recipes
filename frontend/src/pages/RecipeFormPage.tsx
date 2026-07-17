import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, imageUrl, type RecipeInput } from "../api";

interface IngredientDraft {
  quantity: string;
  unit: string;
  name: string;
}

const EMPTY_ROW: IngredientDraft = { quantity: "", unit: "", name: "" };

export default function RecipeFormPage() {
  const { id } = useParams();
  const isEdit = id !== undefined;
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [prep, setPrep] = useState("");
  const [cook, setCook] = useState("");
  const [servings, setServings] = useState("");
  const [rows, setRows] = useState<IngredientDraft[]>([{ ...EMPTY_ROW }]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [existingImage, setExistingImage] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isEdit) return;
    api
      .getRecipe(Number(id))
      .then((r) => {
        setTitle(r.title);
        setDescription(r.description);
        setInstructions(r.instructions);
        setPrep(r.prep_minutes?.toString() ?? "");
        setCook(r.cook_minutes?.toString() ?? "");
        setServings(r.servings?.toString() ?? "");
        setExistingImage(r.image_filename);
        setRows(
          r.ingredients.length > 0
            ? r.ingredients.map((i) => ({
                quantity: i.quantity?.toString() ?? "",
                unit: i.unit ?? "",
                name: i.name,
              }))
            : [{ ...EMPTY_ROW }],
        );
      })
      .catch((e) => setError(e.message));
  }, [id, isEdit]);

  function updateRow(index: number, patch: Partial<IngredientDraft>) {
    setRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    setRows((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== index) : rows));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const ingredients = rows
      .filter((r) => r.name.trim())
      .map((r) => ({
        name: r.name.trim(),
        quantity: r.quantity.trim() === "" ? null : Number(r.quantity),
        unit: r.unit.trim() === "" ? null : r.unit.trim(),
      }));
    if (ingredients.some((i) => i.quantity !== null && !Number.isFinite(i.quantity))) {
      setError("Ingredient quantities must be numbers.");
      return;
    }

    const payload: RecipeInput = {
      title: title.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      prep_minutes: prep.trim() === "" ? null : Number(prep),
      cook_minutes: cook.trim() === "" ? null : Number(cook),
      servings: servings.trim() === "" ? null : Number(servings),
      ingredients,
    };
    if (!payload.title) {
      setError("Give your recipe a title.");
      return;
    }

    setSaving(true);
    try {
      const recipe = isEdit
        ? await api.updateRecipe(Number(id), payload)
        : await api.createRecipe(payload);
      if (imageFile) {
        await api.uploadImage(recipe.id, imageFile);
      } else if (removeImage && existingImage) {
        await api.deleteImage(recipe.id);
      }
      navigate(`/recipes/${recipe.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setSaving(false);
    }
  }

  const previewUrl = imageFile
    ? URL.createObjectURL(imageFile)
    : !removeImage
      ? imageUrl(existingImage)
      : null;

  return (
    <>
      <div className="page-head">
        <h1>{isEdit ? "Edit recipe" : "New recipe"}</h1>
      </div>

      <form className="form" onSubmit={handleSubmit}>
        {error && <div className="error-banner">{error}</div>}

        <div className="field">
          <label htmlFor="title">Title</label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Weeknight chicken curry"
            autoFocus={!isEdit}
          />
        </div>

        <div className="field">
          <label htmlFor="description">Description</label>
          <input
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A short note about this dish (optional)"
          />
        </div>

        <div className="field">
          <label>Photo</label>
          <div className="image-drop">
            {previewUrl && <img src={previewUrl} alt="Recipe preview" />}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  setImageFile(e.target.files?.[0] ?? null);
                  setRemoveImage(false);
                }}
              />
              {(imageFile || (existingImage && !removeImage)) && (
                <button
                  type="button"
                  className="btn small danger"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => {
                    setImageFile(null);
                    setRemoveImage(true);
                  }}
                >
                  Remove photo
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="prep">Prep (min)</label>
            <input
              id="prep"
              type="number"
              min="0"
              value={prep}
              onChange={(e) => setPrep(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cook">Cook (min)</label>
            <input
              id="cook"
              type="number"
              min="0"
              value={cook}
              onChange={(e) => setCook(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="servings">Servings</label>
            <input
              id="servings"
              type="number"
              min="1"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label>Ingredients</label>
          <span className="hint">Quantity and unit are optional; leave them blank for “to taste”.</span>
          {rows.map((row, i) => (
            <div className="ingredient-row" key={i}>
              <input
                aria-label="Quantity"
                placeholder="Qty"
                inputMode="decimal"
                value={row.quantity}
                onChange={(e) => updateRow(i, { quantity: e.target.value })}
              />
              <input
                aria-label="Unit"
                placeholder="Unit"
                value={row.unit}
                onChange={(e) => updateRow(i, { unit: e.target.value })}
              />
              <input
                aria-label="Ingredient name"
                placeholder="Ingredient"
                value={row.name}
                onChange={(e) => updateRow(i, { name: e.target.value })}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove ingredient"
                onClick={() => removeRow(i)}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn small"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setRows((rows) => [...rows, { ...EMPTY_ROW }])}
          >
            + Add ingredient
          </button>
        </div>

        <div className="field">
          <label htmlFor="instructions">Instructions</label>
          <span className="hint">One step per line; they will be numbered automatically.</span>
          <textarea
            id="instructions"
            rows={8}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={"Preheat the oven to 400°F\nSeason the chicken\n…"}
          />
        </div>

        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create recipe"}
          </button>
          <Link to={isEdit ? `/recipes/${id}` : "/recipes"} className="btn">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
