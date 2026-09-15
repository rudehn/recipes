import { useCallback, useMemo, useState } from "react";

import { api, type CostLine } from "../api";
import { useDebounced } from "../useDebounced";
import { useLoad } from "../useLoad";
import { Modal } from "./ui";

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Choose which product an ingredient means, from the recipe page.
 *
 * The grocery list's correction for a recipe row: the same alternatives, the
 * same "don't price this" and the same way back, pinned under the same key,
 * so a choice made here is the one the list uses too. It opens searched for
 * the ingredient's own name and takes words of the cook's own, which is the
 * way out when that name is one the shop would never use - a misspelling
 * finds nothing however many times it is searched for.
 */
export function ProductPickerModal({
  line,
  onPick,
  onForget,
  onClose,
}: {
  line: CostLine;
  /** Null: the ingredient is not to be priced. */
  onPick: (productId: string | null) => void;
  onForget: () => void;
  onClose: () => void;
}) {
  const own = line.key.split("-").join(" ");
  const [query, setQuery] = useState(own);
  const search = useDebounced(query.trim());
  const { data, error, loading } = useLoad(
    useCallback(
      () => api.matchAlternatives(line.key, search && search !== own ? search : undefined),
      [line.key, search, own],
    ),
  );

  // The product in force is listed even when this search did not turn it up,
  // so something is always marked as chosen. See the grocery list's panel.
  const options = useMemo(() => {
    const found = data ?? [];
    const current = line.product;
    if (!current || found.some((o) => o.product_id === current.product_id)) return found;
    return [current, ...found];
  }, [data, line.product]);

  return (
    <Modal title={`Product for “${line.name}”`} onClose={onClose}>
      <div className="modal-search">
        <input
          autoFocus
          aria-label="Search products"
          placeholder="Search this store…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="modal-list">
        {options.map((option) => {
          const chosen = option.product_id === line.product?.product_id;
          return (
            <button
              key={option.product_id}
              type="button"
              className={`modal-food${chosen ? " chosen" : ""}`}
              aria-pressed={chosen}
              onClick={() => onPick(option.product_id)}
            >
              <span className="description">
                {option.description}
                {option.size && ` · ${option.size}`}
              </span>
              <span className="per">{money(option.promo ?? option.regular)}</span>
            </button>
          );
        })}
        {options.length === 0 && (
          <p className="modal-note">
            {error ?? (loading ? "Looking…" : "Nothing at this store matches that.")}
          </p>
        )}
        <button type="button" className="modal-food skip" onClick={() => onPick(null)}>
          Don&rsquo;t price this
        </button>
        {line.hand_picked && (
          <button type="button" className="modal-food skip" onClick={onForget}>
            Back to the automatic pick
          </button>
        )}
      </div>
    </Modal>
  );
}
