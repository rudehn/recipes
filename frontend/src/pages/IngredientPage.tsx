import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { ApiError, api, type IngredientDetail, type IngredientLine } from "../api";
import { LoadFailure } from "../components/LoadError";
import { MergeDialog, type Merged } from "../components/MergeDialog";
import { FoodPickerModal } from "../components/Nutrition";
import { ProductPickerModal } from "../components/ProductPicker";
import { SuggestionRow } from "../components/SuggestionRow";
import { Banner, Button, EmptyState, LinkButton, Modal, PageHead, Panel, Switch } from "../components/ui";
import { formatQuantity } from "../quantity";
import { recipeIngredientPath } from "../recipeLink";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

const money = (n: number) => `$${n.toFixed(2)}`;

/** A recipe line as the cook reads it: "2 tsp ground cumin". */
function lineText(line: IngredientLine): string {
  const amount = formatQuantity(line.quantity, line.unit);
  return amount ? `${amount} ${line.name}` : line.name;
}

/**
 * One ingredient's own page: everything decided about it, in one place.
 *
 * The staple, the product and the food are each changed through the
 * endpoint that already changes them, so a choice made here is the same
 * choice the grocery list and the recipe pages see. A 404 is its own state,
 * not a failure: the ingredient's last recipe may simply have been deleted.
 */
export default function IngredientPage() {
  const { key = "" } = useParams();
  const navigate = useNavigate();
  const [missing, setMissing] = useState(false);
  const { data, error, reload } = useLoad<IngredientDetail | null>(
    useCallback(async () => {
      setMissing(false);
      try {
        return await api.ingredient(key);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404) {
          setMissing(true);
          return null;
        }
        throw cause;
      }
    }, [key]),
  );
  const action = useAction();
  const [choosing, setChoosing] = useState<"product" | "food" | null>(null);

  const location = useLocation();
  const [merging, setMerging] = useState<readonly [string, string] | "pick" | null>(null);
  const [unmerging, setUnmerging] = useState<{ key: string; name: string } | null>(null);
  // Set by the merge that brought the owner here, so the banner can offer
  // to take it back.
  const merged = (location.state as { merged?: Merged } | null)?.merged ?? null;

  // Opened under a merged-away name: show the target's address, so a link
  // copied from here is the one that keeps working.
  useEffect(() => {
    if (data?.redirected_from) navigate(`/ingredients/${data.key}`, { replace: true });
  }, [data, navigate]);

  // A link may ask for a merge (from Needs a look): open its preview once
  // the page has loaded, then drop the parameter so a reload does not reopen it.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const target = params.get("merge");
    if (data && target && !data.redirected_from) {
      setMerging([data.key, target]);
      setParams({}, { replace: true });
    }
  }, [data, params, setParams]);

  async function change(write: () => Promise<unknown>) {
    setChoosing(null);
    if (await action.run(write)) reload();
  }

  if (missing) {
    return (
      <EmptyState glyph="🥕" title="No ingredient called that">
        <p>No recipe or staple uses it any more.</p>
        <LinkButton to="/ingredients?view=all">All ingredients</LinkButton>
      </EmptyState>
    );
  }
  if (error && !data) {
    return <LoadFailure what="this ingredient" message={error} onRetry={reload} showing={false} />;
  }
  if (!data) return null;

  const staple = data.staple;
  const standing = data.product;
  const food = data.food;

  return (
    <div className="ingredient-layout">
      <PageHead title={data.name} sub={`${data.recipe_count} recipe${data.recipe_count === 1 ? "" : "s"}`} />

      {data.merged.length > 0 && (
        <div className="also-called">
          Also called{" "}
          {data.merged.map((m) => (
            <span key={m.key} className="merged-name">
              {m.name}
              <Button size="small" aria-label={`Unmerge ${m.name}`} onClick={() => setUnmerging(m)}>
                Unmerge
              </Button>
            </span>
          ))}
        </div>
      )}

      {merged && merged.toKey === data.key && (
        <Banner tone="notice" spaced>
          Merged {merged.fromName} into {merged.toName}.{" "}
          <Button
            size="small"
            onClick={() =>
              change(async () => {
                await api.unmerge(merged.fromKey);
                navigate(location.pathname, { replace: true, state: null });
              })
            }
          >
            Unmerge
          </Button>
        </Banner>
      )}

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      <section aria-label="Pantry">
        <Panel title="Pantry">
          <div className="ingredient-facts">
            {!staple && (
              <Button size="small" onClick={() => change(() => api.addPantryItem(data.name, true))}>
                Keep stocked
              </Button>
            )}
            {staple && (
              <Switch
                on={staple.in_stock}
                onToggle={() => change(() => api.updatePantryItem(staple.id, { in_stock: !staple.in_stock }))}
              >
                {staple.in_stock ? "In stock" : "Out of stock"}
              </Switch>
            )}
            {staple && (
              <Button size="small" variant="danger" onClick={() => change(() => api.deletePantryItem(staple.id))}>
                Stop keeping stocked
              </Button>
            )}
          </div>
        </Panel>
      </section>

      {standing && (
        <section aria-label="At your store">
          <Panel title="At your store">
            <div className="ingredient-facts">
              {standing.product ? (
                <p className="fact">
                  <span className="what">{standing.product.description}</span>
                  <span className="detail">
                    {standing.product.size} · {money(standing.product.promo ?? standing.product.regular)}
                    {standing.status === "picked" && <span className="chosen-by"> · your pick</span>}
                  </span>
                </p>
              ) : (
                <p className="fact muted">
                  {standing.status === "not_priced"
                    ? "Not priced, by your choice"
                    : standing.status === "no_match"
                      ? "Nothing at your store matched"
                      : standing.status === "unseen"
                        ? "Not priced yet: it is matched the first time a list needs it"
                        : "Product picked; its price could not be fetched"}
                </p>
              )}
              <div className="fact-actions">
                <Button size="small" onClick={() => setChoosing("product")}>
                  Change product
                </Button>
                {standing.status !== "not_priced" && (
                  <Button size="small" onClick={() => change(() => api.setMatch(data.key, null))}>
                    Don&rsquo;t price this
                  </Button>
                )}
                {(standing.status === "picked" || standing.status === "not_priced") && (
                  <Button size="small" onClick={() => change(() => api.forgetMatch(data.key))}>
                    Back to automatic
                  </Button>
                )}
              </div>
            </div>
          </Panel>
        </section>
      )}

      <section aria-label="Nutrition">
        <Panel title="Nutrition">
          <div className="ingredient-facts">
            <p className={`fact${food.food ? "" : " muted"}`}>
              <span className="what">
                {food.status === "skipped" ? "Doesn't count" : food.food ? food.food.description : "No food chosen"}
              </span>
              {food.status === "picked" && <span className="chosen-by">your choice</span>}
            </p>
            <div className="fact-actions">
              <Button size="small" onClick={() => setChoosing("food")}>
                {food.food ? "Change food" : "Choose food"}
              </Button>
              {food.status !== "skipped" && (
                <Button size="small" onClick={() => change(() => api.chooseFood(data.key, null))}>
                  It doesn&rsquo;t count
                </Button>
              )}
              {(food.status === "picked" || food.status === "skipped") && (
                <Button size="small" onClick={() => change(() => api.forgetFood(data.key))}>
                  Back to default
                </Button>
              )}
            </div>
          </div>
        </Panel>
      </section>

      <section aria-label="Used in">
        <Panel title="Used in">
          {data.lines.length === 0 ? (
            <p className="muted">No recipe uses it; it is here as a staple.</p>
          ) : (
            <ul className="ingredient-lines">
              {data.lines.map((line) => (
                <li key={line.ingredient_id}>
                  <span className="recipe">{line.recipe_title}</span>
                  <Link to={recipeIngredientPath(line.recipe_id, [line.ingredient_id])}>{lineText(line)}</Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      {data.suggestions.length > 0 && (
        <section aria-label="Might be the same as">
          <Panel title="Might be the same as">
            {data.suggestions.map((s) => (
              <SuggestionRow
                key={`${s.from_key}|${s.to_key}`}
                suggestion={s}
                merge={
                  <Button size="small" onClick={() => setMerging([s.from_key, s.to_key])}>
                    Merge
                  </Button>
                }
                onDismiss={() => change(() => api.dismissSuggestion(s.from_key, s.to_key))}
              />
            ))}
          </Panel>
        </section>
      )}

      <div className="ingredient-merge">
        <Button onClick={() => setMerging("pick")}>Same as another ingredient…</Button>
      </div>

      {choosing === "product" && standing && (
        <ProductPickerModal
          line={{
            key: data.key,
            name: data.name,
            product: standing.product,
            hand_picked: standing.status === "picked" || standing.status === "not_priced",
          }}
          onPick={(productId) => change(() => api.setMatch(data.key, productId))}
          onForget={() => change(() => api.forgetMatch(data.key))}
          onClose={() => setChoosing(null)}
        />
      )}
      {choosing === "food" && (
        <FoodPickerModal
          line={{ key: data.key, name: data.name, food: food.food }}
          onPick={(chosen) => change(() => api.chooseFood(data.key, chosen?.fdc_id ?? null))}
          onClose={() => setChoosing(null)}
        />
      )}
      {merging && (
        <MergeDialog
          ingredient={data}
          pair={merging === "pick" ? undefined : merging}
          onClose={() => setMerging(null)}
          onMerged={(done) => {
            setMerging(null);
            // From the target's own page this navigates to where we already
            // are, which does not re-run the load, so reload explicitly.
            navigate(`/ingredients/${done.toKey}`, { state: { merged: done } });
            reload();
          }}
        />
      )}
      {unmerging && (
        <Modal title={`Unmerge ${unmerging.name}?`} onClose={() => setUnmerging(null)}>
          <p>
            “{unmerging.name}” goes back to being its own ingredient, with its own grocery line. It
            starts fresh: an automatic product, and its default food if it has one. What moved to{" "}
            {data.name} stays with it.
          </p>
          <div className="modal-actions">
            <Button
              variant="primary"
              onClick={() => {
                const going = unmerging;
                setUnmerging(null);
                // The banner offers to undo a merge; once any name is unmerged it
                // may be stale, so drop it.
                void change(async () => {
                  await api.unmerge(going.key);
                  navigate(location.pathname, { replace: true, state: null });
                });
              }}
            >
              Unmerge
            </Button>
            <Button onClick={() => setUnmerging(null)}>Cancel</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
