import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import {
  api,
  imageUrl,
  type Ingredient,
  type RecipeDraft,
  type RecipeInput,
} from "../api";
import { TagInput } from "../components/TagInput";
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
import { errorMessage, useLoad } from "../useLoad";

interface IngredientDraft {
  quantity: string;
  unit: string;
  name: string;
  /** The line as imported, carried through untouched so it is not lost on save. */
  source_line: string | null;
}

const EMPTY_ROW: IngredientDraft = { quantity: "", unit: "", name: "", source_line: null };

/** Ingredients as editable text, quantities shown as the fractions the rest of
 *  the app displays so editing a recipe doesn't turn "¾" into "0.75". */
function toRows(ingredients: Omit<Ingredient, "id">[]): IngredientDraft[] {
  if (ingredients.length === 0) return [{ ...EMPTY_ROW }];
  return ingredients.map((i) => ({
    quantity: i.quantity != null ? formatAmount(i.quantity) : "",
    unit: i.unit ?? "",
    name: i.name,
    source_line: i.source_line ?? null,
  }));
}

/**
 * Whether the recipe page could open this as a link back to the original.
 *
 * The field's own type="url" already stops anything that is not an address,
 * but an ftp: or javascript: address is one, and the server would refuse it
 * with a reply that says nothing useful. Said here, in the form's words.
 */
function isWebLink(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The draft is of a page already saved. Said with a way to the saved one, and
 * no more than said: a second copy to change is a reasonable thing to want, so
 * the form below stays exactly as usable as it was.
 */
function AlreadySaved({ recipeId }: { recipeId: number }) {
  return (
    <Banner tone="notice" role="status">
      <span>
        Already in your box. <Link to={`/recipes/${recipeId}`}>Open the saved recipe</Link>, or
        save a second copy below.
      </span>
    </Banner>
  );
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
  const [tags, setTags] = useState<string[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [existingImage, setExistingImage] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorBanner = useRef<HTMLDivElement>(null);
  // Counts saves, so a second refusal for the same reason is shown again.
  const [attempts, setAttempts] = useState(0);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // Photo URL captured by the importer; downloaded server-side on save.
  const [importedImageUrl, setImportedImageUrl] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  // The recipe already saved from the page the current draft came from.
  const [savedRecipeId, setSavedRecipeId] = useState<number | null>(null);
  // Every tag in the box, for the tag field to suggest. A failure only costs
  // the suggestions: tags can still be typed.
  const { data: tagsInBox } = useLoad(useCallback(() => api.listRecipeTags(), []));

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
        setTags(r.tags);
        setExistingImage(r.image_filename);
        setRows(toRows(r.ingredients));
        setSourceUrl(r.source_url ?? "");
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
    // Suggestions from the page, shown as chips like any other tag: they
    // are the person's to drop, and nothing is tagged until they save.
    setTags(draft.tags);
    setImportedImageUrl(draft.image_url);
    setImageFile(null);
    setRemoveImage(false);
    setSourceUrl(draft.source_url);
    setSavedRecipeId(draft.saved_recipe_id);
  }, []);

  useEffect(() => {
    if (pickedDraft) applyDraft(pickedDraft);
  }, [pickedDraft, applyDraft]);

  // The save button is at the foot of a long form and the reason it refused
  // is at the head, so without this a refusal looks like a button that does
  // nothing. Centred rather than at the top, where the sticky header sits.
  useEffect(() => {
    if (error) errorBanner.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [error, attempts]);

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
    setAttempts((n) => n + 1);

    const ingredients = rows
      .filter((r) => r.name.trim())
      .map((r) => ({
        name: r.name.trim(),
        quantity: parseQuantity(r.quantity),
        unit: r.unit.trim() === "" ? null : r.unit.trim(),
        // Only rows that came from an import have one; a typed row sends
        // nothing rather than a null the server would store as nothing.
        ...(r.source_line ? { source_line: r.source_line } : {}),
      }));
    if (ingredients.some((i) => i.quantity !== null && !Number.isFinite(i.quantity))) {
      setError("Ingredient quantities must be numbers or fractions like 1 1/2.");
      return;
    }

    const source = sourceUrl.trim();
    const payload: RecipeInput = {
      title: title.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      prep_minutes: prep.trim() === "" ? null : Number(prep),
      cook_minutes: cook.trim() === "" ? null : Number(cook),
      servings: servings.trim() === "" ? null : Number(servings),
      ingredients,
      tags,
      // Like an ingredient's source line, sent only when there is one. A save
      // replaces the recipe, so an emptied field takes a stored link off.
      ...(source ? { source_url: source } : {}),
    };
    if (!payload.title) {
      setError("Give your recipe a title.");
      return;
    }
    if (source && !isWebLink(source)) {
      setError("Source links must start with http:// or https://.");
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
          {savedRecipeId !== null && <AlreadySaved recipeId={savedRecipeId} />}
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
          {savedRecipeId !== null && <AlreadySaved recipeId={savedRecipeId} />}
        </div>
      )}

      <form className="form" onSubmit={handleSubmit}>
        {error && (
          <div ref={errorBanner}>
            <Banner tone="error" role="alert">
              {error}
            </Banner>
          </div>
        )}

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

        <Field label="Source link" htmlFor="source-url">
          <input
            id="source-url"
            type="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="Link to the original recipe (optional)"
          />
        </Field>

        <Field label="Photo">
          <div className="image-drop">
            {previewUrl && <img src={previewUrl} alt="Recipe preview" />}
            <div className="image-drop-actions">
              {/* The platform's file control draws a grey box and "No file
                  chosen" in its own type, so it is kept for its picker and
                  reached through a label drawn as one of the app's buttons.
                  Clipped rather than hidden, the input still takes focus and
                  carries the label's words as its name. */}
              <label className="btn small file-pick">
                <input
                  type="file"
                  className="visually-hidden"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => {
                    setImageFile(e.target.files?.[0] ?? null);
                    setRemoveImage(false);
                  }}
                />
                {previewUrl ? "Replace photo" : "Choose photo"}
              </label>
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
          hint="Enter or a comma adds one, e.g. quick, vegetarian, weeknight."
        >
          <TagInput
            id="tags"
            tags={tags}
            onChange={setTags}
            suggestions={tagsInBox?.map((t) => t.name) ?? []}
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
