import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  api,
  type GroceryItem,
  type GroceryList,
  type GroceryPricing,
  type SaleItem,
} from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, PageHead } from "../components/ui";
import { addDays, fromISODate, startOfWeek, toISODate } from "../dates";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

/**
 * Checkmarks the server has not accepted, by item key.
 *
 * This page is used in a grocery aisle, which is where the signal is worst, so
 * a failed toggle is expected rather than exceptional. The mark stays on
 * screen: the shopper put the thing in the cart, and quietly taking the tick
 * back would be the more damaging lie. Holding the intended state here instead
 * of only in the loaded list also means a later reload cannot silently undo it.
 */
type Unsaved = ReadonlyMap<string, boolean>;

const itemCount = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

const money = (n: number) => `$${n.toFixed(2)}`;

function applyUnsaved(list: GroceryList | null, unsaved: Unsaved): GroceryList | null {
  if (!list || unsaved.size === 0) return list;
  const apply = (item: GroceryItem) =>
    unsaved.has(item.key) ? { ...item, checked: unsaved.get(item.key)! } : item;
  return {
    ...list,
    items: list.items.map(apply),
    in_pantry: list.in_pantry.map(apply),
    pantry_restock: list.pantry_restock.map(apply),
  };
}

export default function GroceryPage() {
  const [params, setParams] = useSearchParams();
  const start = params.get("start") ?? toISODate(startOfWeek(new Date()));
  const end = params.get("end") ?? toISODate(addDays(startOfWeek(new Date()), 6));

  const {
    data: loaded,
    setData: setList,
    error,
    reload,
  } = useLoad(useCallback(() => api.groceryList(start, end), [start, end]));

  // Asked separately rather than read off list.pricing, which is absent when
  // nothing could be matched - exactly the case where the alternatives are
  // most needed. What matters here is only whether a store is set to choose
  // products at.
  const { data: pricingStatus } = useLoad(useCallback(() => api.pricingStatus(), []));
  const canPrice = Boolean(pricingStatus?.enabled && pricingStatus.store);

  const [unsaved, setUnsaved] = useState<Unsaved>(new Map());
  const [saving, setSaving] = useState(false);
  const action = useAction();

  const list = useMemo(() => applyUnsaved(loaded, unsaved), [loaded, unsaved]);

  function setRange(nextStart: string, nextEnd: string) {
    if (nextStart && nextEnd) setParams({ start: nextStart, end: nextEnd });
  }

  function forget(key: string): (prev: Unsaved) => Unsaved {
    return (prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    };
  }

  async function toggle(item: GroceryItem) {
    const checked = !item.checked;
    // Optimistic flip so the list feels instant.
    setList((prev) => {
      if (!prev) return prev;
      const flip = (i: GroceryItem) => (i.key === item.key ? { ...i, checked } : i);
      return {
        ...prev,
        items: prev.items.map(flip),
        in_pantry: prev.in_pantry.map(flip),
        pantry_restock: prev.pantry_restock.map(flip),
      };
    });
    try {
      await api.toggleGroceryItem(item.key, checked);
      setUnsaved(forget(item.key));
      reload();
    } catch {
      setUnsaved((prev) => new Map(prev).set(item.key, checked));
    }
  }

  /** Send the marks again, for when the signal is back. */
  async function saveUnsaved() {
    setSaving(true);
    const stillUnsaved = new Map<string, boolean>();
    for (const [key, checked] of unsaved) {
      try {
        await api.toggleGroceryItem(key, checked);
      } catch {
        stillUnsaved.set(key, checked);
      }
    }
    setUnsaved(stillUnsaved);
    setSaving(false);
    if (stillUnsaved.size === 0) reload();
  }

  /**
   * Move a stocked staple onto the shopping list.
   *
   * Wanting more of something is the same fact as being low on it, which the
   * pantry already records - so this marks the item out of stock rather than
   * inventing a second flag. The row then appears under "to buy", and ticking
   * it off at the shop puts it back in stock the way any other staple does.
   */
  async function buyAnyway(item: GroceryItem) {
    const id = item.pantry_item_id;
    if (id === null) return;
    if (await action.run(() => api.updatePantryItem(id, { in_stock: false }))) reload();
  }

  async function clearChecks() {
    if (await action.run(() => api.clearGroceryChecks())) {
      setUnsaved(new Map());
      reload();
    }
  }

  const rangeDays =
    Math.round(
      (fromISODate(end).getTime() - fromISODate(start).getTime()) / 86_400_000,
    ) + 1;
  const empty =
    list &&
    list.items.length === 0 &&
    list.in_pantry.length === 0 &&
    list.pantry_restock.length === 0;

  return (
    <div className="grocery-layout">
      <PageHead
        title="Groceries"
        sub={rangeDays > 0 ? `${rangeDays} day${rangeDays === 1 ? "" : "s"} of meals` : ""}
      />

      <div className="grocery-range">
        <label>
          From{" "}
          <input
            type="date"
            value={start}
            onChange={(e) => setRange(e.target.value, end)}
          />
        </label>
        <label>
          to{" "}
          <input
            type="date"
            value={end}
            onChange={(e) => setRange(start, e.target.value)}
          />
        </label>
        <span className="spacer" />
        <Button size="small" onClick={clearChecks}>
          Clear checkmarks
        </Button>
      </div>

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      {unsaved.size > 0 && (
        <Banner tone="notice" spaced role="status">
          <span>
            {unsaved.size} checkmark{unsaved.size === 1 ? "" : "s"} not saved yet. They
            are on this list but not on your other devices.
          </span>
          <Button size="small" onClick={saveUnsaved} disabled={saving}>
            {saving ? "Saving…" : "Save now"}
          </Button>
        </Banner>
      )}

      {error && (
        <LoadFailure
          what="your grocery list"
          message={error}
          onRetry={reload}
          showing={list !== null}
        />
      )}

      {list?.pricing && <PricingSummary pricing={list.pricing} />}

      {canPrice && <Offers />}

      {!error && empty && (
        <EmptyState glyph="🧺" title="Nothing to buy">
          <p>
            Plan some meals for this date range, or mark pantry items out of stock,
            and they will show up here.
          </p>
        </EmptyState>
      )}

      {list && list.items.length > 0 && (
        <section className="grocery-section">
          <h2>
            To buy <span className="count">{itemCount(list.items.length)}</span>
          </h2>
          {list.items.map((item) => (
            <GroceryRow
              key={item.key}
              item={item}
              onToggle={toggle}
              canPrice={canPrice}
              onMatched={reload}
            />
          ))}
        </section>
      )}

      {list && list.in_pantry.length > 0 && (
        // Folded away, because the answer for these is usually "you have it".
        // Opened when there is nothing to buy, so the page is never just a
        // heading and a number. The count stays visible either way: the point
        // is that nothing is hidden without saying so.
        <details className="grocery-section stocked-section" open={list.items.length === 0}>
          <summary>
            Already in your pantry{" "}
            <span className="count">{itemCount(list.in_pantry.length)}</span>
          </summary>
          <p className="section-note">
            Off the list because the pantry has them. Check the amounts your meals
            need if you are not sure there is enough.
          </p>
          {list.in_pantry.map((item) => (
            <StockedRow key={item.key} item={item} onBuyAnyway={buyAnyway} />
          ))}
        </details>
      )}

      {list && list.pantry_restock.length > 0 && (
        <section className="grocery-section">
          <h2>
            Restock pantry{" "}
            <span className="count">{itemCount(list.pantry_restock.length)}</span>
          </h2>
          {list.pantry_restock.map((item) => (
            <GroceryRow
              key={item.key}
              item={item}
              onToggle={toggle}
              canPrice={canPrice}
              onMatched={reload}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * The estimated total, and how much of the list it covers.
 *
 * Coverage sits next to the number rather than in a footnote. A total that
 * silently leaves out the lines it could not match reads exactly like a
 * complete one, and the difference is only discovered at the till - so it is
 * "est. $12.40 · 9 of 11 priced", never "$12.40".
 */
function PricingSummary({ pricing }: { pricing: GroceryPricing }) {
  const missing = pricing.total_lines - pricing.priced;
  return (
    <div className="pricing-summary">
      <span className="total">est. {money(pricing.total)}</span>
      <span className="coverage">
        {pricing.priced} of {pricing.total_lines} priced
        {missing > 0 && ` · ${missing} not matched`}
      </span>
      {pricing.saved > 0 && (
        <span className="saved">{money(pricing.saved)} off with offers</span>
      )}
      <span className="store">{pricing.store.name}</span>
    </div>
  );
}

/**
 * Ingredients you cook with that are discounted this week.
 *
 * Folded away, because the answer is usually "nothing much" and it must not
 * push the list itself down the page. Built from products already chosen, so
 * it costs one batched lookup and never a search.
 */
function Offers() {
  const { data } = useLoad(useCallback(() => api.sales(), []));
  if (!data || data.length === 0) return null;
  return (
    <details className="grocery-section offers-section">
      <summary>
        On sale <span className="count">{itemCount(data.length)}</span>
      </summary>
      {data.map((sale: SaleItem) => (
        <div key={sale.key} className="offer">
          <span className="name">{sale.name}</span>
          <span className="item-price on-sale">
            <span className="amount">
              <s>{money(sale.price.regular)}</s> {money(sale.price.promo ?? sale.price.regular)}
            </span>
            <span className="product">
              {sale.price.description}
              {sale.price.size && ` · ${sale.price.size}`}
            </span>
          </span>
        </div>
      ))}
    </details>
  );
}

/** A line's price. Kroger's own description and size, shown as returned. */
function ItemPriceTag({ item }: { item: GroceryItem }) {
  if (!item.price) return null;
  const { regular, promo, description, size, estimated } = item.price;
  const onSale = promo !== null;
  const shelf = onSale ? promo : regular;
  const cost = estimated ?? shelf;
  // A line costing more than one package is the interesting case: three
  // pounds of chicken at $4.49 a pound is $13.47, and showing the shelf
  // figure there understates it. Kroger's own price moves down beside the
  // size rather than being replaced, because altering it is not allowed.
  const scaled = Math.abs(cost - shelf) >= 0.005;
  return (
    <span className={`item-price${onSale ? " on-sale" : ""}`}>
      <span className="amount">
        {onSale && !scaled && <s>{money(regular)}</s>} {money(cost)}
      </span>
      <span className="product" title={description}>
        {description}
        {scaled ? ` · ${money(shelf)}${size ? ` / ${size}` : ""}` : size ? ` · ${size}` : ""}
      </span>
    </span>
  );
}

/** Name, totals, and the recipes asking for it - the same in every section. */
function ItemText({ item }: { item: GroceryItem }) {
  const recipeTitles = [...new Set(item.uses.map((u) => u.recipe_title))];
  return (
    <span className="item-text">
      <span className="name">{item.name}</span>
      {item.amounts.length > 0 && (
        <>
          {" "}
          <span className="amounts">· {item.amounts.join(" + ")}</span>
        </>
      )}
      {recipeTitles.length > 0 && <div className="uses">for {recipeTitles.join(", ")}</div>}
    </span>
  );
}

/**
 * The alternatives for one ingredient, fetched only when asked for.
 *
 * Nothing here is filtered the way the automatic pick is: whoever opened this
 * has already seen that pick and disagreed, so the product they want is quite
 * likely one the matcher ruled out.
 */
function Alternatives({
  item,
  onPick,
}: {
  item: GroceryItem;
  onPick: (productId: string | null) => void;
}) {
  const { data, error, loading } = useLoad(
    useCallback(() => api.matchAlternatives(item.key), [item.key]),
  );

  /**
   * The product in force is always listed, even when this search did not turn
   * it up.
   *
   * Kroger's search is fuzzy and returns a different set for a different
   * limit, so the automatic pick genuinely can be missing from the list of
   * alternatives to itself - black pepper matched whole peppercorns, which a
   * narrower search for the same term does not return. Leaving it out would
   * show a panel where nothing is marked as chosen. It is prepended from what
   * the row already carries rather than fetched again.
   */
  const options = useMemo(() => {
    if (!data || !item.price) return data ?? [];
    const current = item.price;
    return data.some((o) => o.product_id === current.product_id)
      ? data
      : [current, ...data];
  }, [data, item.price]);

  if (loading) return <p className="alternatives-status">Looking…</p>;
  if (error) return <p className="alternatives-status">{error}</p>;

  return (
    <div className="alternatives" role="group" aria-label={`Products for ${item.name}`}>
      {options.length === 0 && (
        <p className="alternatives-status">Nothing at this store matches that.</p>
      )}
      {options.map((option) => {
        const chosen = option.product_id === item.price?.product_id;
        return (
          <button
            key={option.product_id}
            type="button"
            className={`alternative${chosen ? " chosen" : ""}`}
            aria-pressed={chosen}
            onClick={() => onPick(option.product_id)}
          >
            <span className="product">
              {option.description}
              {option.size && ` · ${option.size}`}
            </span>
            <span className="amount">
              {option.promo !== null && <s>{money(option.regular)}</s>}{" "}
              {money(option.promo ?? option.regular)}
            </span>
          </button>
        );
      })}
      <button type="button" className="alternative skip" onClick={() => onPick(null)}>
        Don&rsquo;t price this
      </button>
    </div>
  );
}

function GroceryRow({
  item,
  onToggle,
  canPrice,
  onMatched,
}: {
  item: GroceryItem;
  onToggle: (item: GroceryItem) => void;
  /** Whether a store is set, so there is anything to choose between. */
  canPrice: boolean;
  onMatched: () => void;
}) {
  const [open, setOpen] = useState(false);

  async function pick(productId: string | null) {
    await api.setMatch(item.key, productId);
    setOpen(false);
    onMatched();
  }

  return (
    <div className="grocery-entry">
      <div className={`grocery-item${item.checked ? " checked" : ""}`}>
        {/* The label wraps only the checkbox and the name. It used to wrap the
            whole row, which would make a click on the price toggle tick the
            item off as well. */}
        <label className="grocery-check">
          <input
            type="checkbox"
            checked={item.checked}
            onChange={() => onToggle(item)}
          />
          <ItemText item={item} />
        </label>
        {item.from_pantry && <span className="pantry-tag">pantry</span>}
        {canPrice && (
          <button
            type="button"
            className="price-toggle"
            aria-expanded={open}
            aria-label={
              item.price
                ? `${item.name}: ${item.price.description}. Choose a different product`
                : `${item.name}: not priced. Choose a product`
            }
            onClick={() => setOpen((wasOpen) => !wasOpen)}
          >
            {item.price ? (
              <ItemPriceTag item={item} />
            ) : (
              <span className="unmatched">no match</span>
            )}
          </button>
        )}
      </div>
      {open && <Alternatives item={item} onPick={pick} />}
    </div>
  );
}

/**
 * A stocked staple. No checkbox: there is nothing to tick off a trip you are
 * not making, and a checkbox here would read as "buy this" - the opposite of
 * what the row says. The button is the only action, and it says what it does.
 */
function StockedRow({
  item,
  onBuyAnyway,
}: {
  item: GroceryItem;
  onBuyAnyway: (item: GroceryItem) => void;
}) {
  return (
    <div className="grocery-item stocked">
      <ItemText item={item} />
      <Button size="small" onClick={() => onBuyAnyway(item)}>
        Buy anyway
      </Button>
    </div>
  );
}
