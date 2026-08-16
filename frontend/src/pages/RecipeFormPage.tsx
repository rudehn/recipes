import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import {
  api,
  imageUrl,
  type Ingredient,
  type RecipeDraft,
  type RecipeInput,
} from "../api";
import {
  Banner,
  Button,
  Field,
  FieldRow,
  IconButton,
  LinkButton,
  PageHead,
} from "../components/ui";
import { formatAmount, parseQuantity } from "../quantity";
import { errorMessage } from "../useLoad";

interface IngredientDraft {
  quantity: string;
  unit: string;
  name: string;
}

const EMPTY_ROW: IngredientDraft = { quantity: "", unit: "", name: "" };

/** Ingredients as editable text, quantities shown as the fractions the rest of
 *  the app displays so editing a recipe doesn't turn "¾" into "0.75". */
function toRows(ingredients: Omit<Ingredient, "id">[]): IngredientDraft[] {
  if (ingredients.length === 0) return [{ ...EMPTY_ROW }];
  return ingredients.map((i) => ({
    quantity: i.quantity != null ? formatAmount(i.quantity) : "",
    unit: i.unit ?? "",
    name: i.name,
  }));
}

export default function RecipeFormPage() {
  const { id } = useParams();
  const isEdit = id !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  // Set when arriving from the recipe search having picked a result.
  const pickedDraft = (location.state as { draft?: RecipeDraft } | null)?.draft;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [prep, setPrep] = useState("");
  const [cook, setCook] = useState("");
  const [servings, setServings] = useState("");
  const [rows, setRows] = useState<IngredientDraft[]>([{ ...EMPTY_ROW }]);
  const [tags, setTags] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [existingImage, setExistingImage] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // Photo URL captured by the importer; downloaded server-side on save.
  const [importedImageUrl, setImportedImageUrl] = useState<string | null>(null);

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
        setTags(r.tags.join(", "));
        setExistingImage(r.image_filename);
        setRows(toRows(r.ingredients));
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [id, isEdit]);

  const applyDraft = useCallback((draft: RecipeDraft) => {
    setTitle(draft.title);
    setDescription(draft.description);
    setInstructions(draft.instructions);
    setPrep(draft.prep_minutes?.toString() ?? "");
    setCook(draft.cook_minutes?.toString() ?? "");
    setServings(draft.servings?.toString() ?? "");
    setRows(toRows(draft.ingredients));
    setImportedImageUrl(draft.image_url);
    setImageFile(null);
    setRemoveImage(false);
  }, []);

  useEffect(() => {
    if (pickedDraft) applyDraft(pickedDraft);
  }, [pickedDraft, applyDraft]);

  function updateRow(index: number, patch: Partial<IngredientDraft>) {
    setRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    setRows((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== index) : rows));
  }

  async function handleImport() {
    if (!importUrl.trim()) return;
    setImporting(true);
    setImportError(null);
    try {
      applyDraft(await api.importRecipe(importUrl.trim()));
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const ingredients = rows
      .filter((r) => r.name.trim())
      .map((r) => ({
        name: r.name.trim(),
        quantity: parseQuantity(r.quantity),
        unit: r.unit.trim() === "" ? null : r.unit.trim(),
      }));
    if (ingredients.some((i) => i.quantity !== null && !Number.isFinite(i.quantity))) {
      setError("Ingredient quantities must be numbers or fractions like 1 1/2.");
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
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
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
      } else if (importedImageUrl && !removeImage) {
        // Best effort: a recipe without its photo is still worth saving.
        await api.imageFromUrl(recipe.id, importedImageUrl).catch(() => undefined);
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
      ? (importedImageUrl ?? imageUrl(existingImage))
      : null;

  return (
    <>
      <PageHead title={isEdit ? "Edit recipe" : "New recipe"} />

      {!isEdit && pickedDraft && (
        <div className="import-box">
          <span className="hint">
            Prefilled from{" "}
            <a href={pickedDraft.source_url} target="_blank" rel="noreferrer noopener">
              {pickedDraft.source_label}
            </a>
            . Edit anything you like, then save it to your recipe box.
          </span>
        </div>
      )}

      {!isEdit && !pickedDraft && (
        <div className="import-box">
          <div className="import-row">
            <input
              type="url"
              placeholder="Paste a recipe URL to import, e.g. https://www.budgetbytes.com/…"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleImport();
                }
              }}
            />
            <Button
              variant="primary"
              onClick={handleImport}
              disabled={importing || !importUrl.trim()}
            >
              {importing ? "Importing…" : "Import"}
            </Button>
          </div>
          <span className="hint">
            Reads the recipe data most cooking sites embed and fills in the form
            below for you to review.
          </span>
          {importError && <Banner tone="error">{importError}</Banner>}
        </div>
      )}

      <form className="form" onSubmit={handleSubmit}>
        {error && <Banner tone="error">{error}</Banner>}

        <Field label="Title" htmlFor="title">
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Weeknight chicken curry"
            autoFocus={!isEdit}
          />
        </Field>

        <Field label="Description" htmlFor="description">
          <input
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A short note about this dish (optional)"
          />
        </Field>

        <Field label="Photo">
          <div className="image-drop">
            {previewUrl && <img src={previewUrl} alt="Recipe preview" />}
            <div className="image-drop-actions">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  setImageFile(e.target.files?.[0] ?? null);
                  setRemoveImage(false);
                }}
              />
              {(imageFile || importedImageUrl || (existingImage && !removeImage)) && (
                <Button
                  variant="danger"
                  size="small"
                  onClick={() => {
                    setImageFile(null);
                    setImportedImageUrl(null);
                    setRemoveImage(true);
                  }}
                >
                  Remove photo
                </Button>
              )}
            </div>
          </div>
        </Field>

        <FieldRow>
          <Field label="Prep (min)" htmlFor="prep">
            <input
              id="prep"
              type="number"
              min="0"
              value={prep}
              onChange={(e) => setPrep(e.target.value)}
            />
          </Field>
          <Field label="Cook (min)" htmlFor="cook">
            <input
              id="cook"
              type="number"
              min="0"
              value={cook}
              onChange={(e) => setCook(e.target.value)}
            />
          </Field>
          <Field label="Servings" htmlFor="servings">
            <input
              id="servings"
              type="number"
              min="1"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
            />
          </Field>
        </FieldRow>

        <Field
          label="Ingredients"
          hint={
            <>
              Quantity and unit are optional; leave them blank for “to taste”.
              Fractions like “1 1/2” and “3/4” work.
            </>
          }
        >
          {rows.map((row, i) => (
            <div className="ingredient-row" key={i}>
              <input
                aria-label="Quantity"
                placeholder="Qty"
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
              <IconButton label="Remove ingredient" onClick={() => removeRow(i)}>
                ✕
              </IconButton>
            </div>
          ))}
          <Button
            size="small"
            onClick={() => setRows((rows) => [...rows, { ...EMPTY_ROW }])}
          >
            + Add ingredient
          </Button>
        </Field>

        <Field
          label="Tags"
          htmlFor="tags"
          hint="Comma separated, e.g. quick, vegetarian, weeknight."
        >
          <input
            id="tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="quick, vegetarian"
          />
        </Field>

        <Field
          label="Instructions"
          htmlFor="instructions"
          hint="One step per line; they will be numbered automatically."
        >
          <textarea
            id="instructions"
            rows={8}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={"Preheat the oven to 400°F\nSeason the chicken\n…"}
          />
        </Field>

        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create recipe"}
          </Button>
          <LinkButton to={isEdit ? `/recipes/${id}` : "/recipes"}>Cancel</LinkButton>
        </div>
      </form>
    </>
  );
}
