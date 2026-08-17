import { Fragment, useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  api,
  type CartResult,
  type GroceryItem,
  type GroceryList,
  type GroceryPricing,
  type GroceryRecipeUse,
  type Modality,
  type SaleItem,
} from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, PageHead } from "../components/ui";
import { addDays, formatWhen, fromISODate, startOfWeek, toISODate } from "../dates";
import { recipeIngredientPath } from "../recipeLink";
import { useAction } from "../useAction";
import { errorMessage, useLoad } from "../useLoad";

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

      {list && !empty && <SendToCart start={start} end={end} list={list} />}

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

const KROGER_CART_URL = "https://www.kroger.com/cart";

/**
 * Which lines the shopping still covers, as a value that changes when they do.
 *
 * The review below is built by the server from the same checkmarks, so ticking
 * something off while the review is open would leave it describing a trip that
 * is no longer the one about to be ordered. This is what tells it to look
 * again, and it is the checked keys rather than the whole list because they
 * are the only thing the answer depends on.
 */
function checkedSignature(list: GroceryList): string {
  return [...list.items, ...list.pantry_restock]
    .filter((item) => item.checked)
    .map((item) => item.key)
    .sort()
    .join(",");
}

/**
 * Ordering the list from Kroger.
 *
 * Everything here is shaped by one property of Kroger's cart: it can be
 * written and never read. Nothing can be checked afterwards and nothing can be
 * taken back out, so the app cannot offer a "sent" state it has verified, and
 * a mis-send is permanent. What it can do is show exactly what is about to go
 * - products and quantities both - and never send anything without that being
 * on screen first. Hence a review step rather than a button that fires.
 *
 * Absent entirely when the server is not set up for it, rather than present
 * and disabled: a control that can never work is not information, and the
 * settings page is where the setup is explained.
 */
function SendToCart({
  start,
  end,
  list,
}: {
  start: string;
  end: string;
  list: GroceryList;
}) {
  const { data: status, reload: reloadStatus } = useLoad(
    useCallback(() => api.cartStatus(), []),
  );
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<CartResult | null>(null);

  const signature = checkedSignature(list);

  if (!status?.configured) return null;

  if (!status.connected) {
    return (
      <div className="cart-invite">
        <span>Order this list from Kroger.</span>
        <Link to="/settings">Connect your account</Link>
      </div>
    );
  }

  if (sent) {
    const dismiss = (
      <Button
        size="small"
        onClick={() => {
          setSent(null);
          reloadStatus();
        }}
      >
        Done
      </Button>
    );

    // The server re-plans as it sends, so a line that has gone since the
    // review can leave this at nothing. Saying "0 items added" would read as a
    // success and leave the shopper waiting at a collection point for an empty
    // order.
    if (sent.added === 0) {
      return (
        <Banner tone="error" spaced role="status">
          <span>
            Nothing was added to your Kroger cart - none of these lines could be
            matched to a product at your store. Buy them the usual way.
          </span>
          {dismiss}
        </Banner>
      );
    }

    return (
      <Banner tone="notice" spaced role="status">
        <span>
          {itemCount(sent.added)} added to your Kroger cart
          {sent.skipped.length > 0 && `, ${sent.skipped.length} left off`}.
          {/* The app cannot read the cart back, so it does not claim to know
              what is in there - it points at the place that does. */}{" "}
          <a href={KROGER_CART_URL} target="_blank" rel="noreferrer">
            Open your cart
          </a>{" "}
          to check it over and pick a time.
        </span>
        {dismiss}
      </Banner>
    );
  }

  return (
    <section className="cart-section">
      <div className="cart-head">
        <div className="cart-lede">
          <h2>Kroger cart</h2>
          {status.last_sent_at && (
            <p className="section-note">
              A list was last sent {formatWhen(new Date(status.last_sent_at))}. Sending
              again adds to that cart rather than replacing it.
            </p>
          )}
        </div>
        <Button onClick={() => setOpen((wasOpen) => !wasOpen)} aria-expanded={open}>
          {open ? "Cancel" : "Send to cart"}
        </Button>
      </div>

      {open && (
        // Keyed on the checkmarks, so ticking something off while the review
        // is open starts it again rather than leaving it describing a trip
        // that is no longer the one about to be ordered.
        <CartReview
          key={signature}
          start={start}
          end={end}
          onSent={(result) => {
            setOpen(false);
            setSent(result);
          }}
        />
      )}
    </section>
  );
}

/**
 * What is about to be ordered, and the button that orders it.
 *
 * The quantities are the reason this is a list rather than a count. They come
 * from what the week's meals add up to and are not always one - three bags of
 * flour for a week of bread is right, and is also the kind of thing worth
 * seeing before it is bought rather than after.
 */
function CartReview({
  start,
  end,
  onSent,
}: {
  start: string;
  end: string;
  onSent: (result: CartResult) => void;
}) {
  const {
    data: plan,
    error,
    loading,
    reload,
  } = useLoad(useCallback(() => api.cartPreview(start, end), [start, end]));
  const [modality, setModality] = useState<Modality>("PICKUP");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  /**
   * Not routed through `useAction`, which reports a failed write and answers
   * only whether it went through. What came back matters here: the server
   * re-plans as it sends, so how many actually reached the cart is its answer
   * rather than the count on screen.
   */
  async function send() {
    setSending(true);
    setSendError(null);
    try {
      onSent(await api.addToCart(start, end, modality));
    } catch (cause) {
      setSendError(errorMessage(cause, "Nothing was sent to your Kroger cart."));
      setSending(false);
    }
  }

  if (loading) return <p className="list-status">Working out what to order…</p>;
  if (error) {
    return (
      <LoadFailure what="what to order" message={error} onRetry={reload} showing={false} />
    );
  }
  if (!plan) return null;

  return (
    <div className="cart-review">
      {sendError && <Banner tone="error">{sendError}</Banner>}

      {plan.lines.length === 0 ? (
        <p className="list-status">
          Nothing here can be ordered from Kroger yet. Pick a product for these lines
          from the price beside them, and they will be ready to send.
        </p>
      ) : (
        <>
          <ul className="cart-lines">
            {plan.lines.map((line) => (
              <li key={line.key}>
                <span className="quantity" aria-label={`${line.quantity} of`}>
                  {line.quantity}×
                </span>
                <span className="item-name">
                  <span className="name">{line.name}</span>
                </span>
                <span className="product" title={line.description}>
                  {line.description}
                  {line.size && ` · ${line.size}`}
                </span>
              </li>
            ))}
          </ul>

          {plan.skipped.length > 0 && (
            <p className="section-note">
              Not sent, because nothing at your store is matched to them:{" "}
              {plan.skipped.join(", ")}. Buy these the usual way.
            </p>
          )}

          <div className="cart-send">
            <label>
              Collect by{" "}
              <select
                value={modality}
                onChange={(e) => setModality(e.target.value as Modality)}
              >
                <option value="PICKUP">Pickup</option>
                <option value="DELIVERY">Delivery</option>
              </select>
            </label>
            <Button variant="primary" onClick={send} disabled={sending}>
              {sending ? "Sending…" : `Send ${itemCount(plan.lines.length)} to Kroger`}
            </Button>
          </div>
        </>
      )}
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

/** What the line is: its name and the totals the week's meals add up to. */
function ItemName({ item }: { item: GroceryItem }) {
  return (
    <span className="item-name">
      <span className="name">{item.name}</span>
      {item.amounts.length > 0 && (
        <>
          {" "}
          <span className="amounts">· {item.amounts.join(" + ")}</span>
        </>
      )}
    </span>
  );
}

/**
 * The recipes asking for a line, one entry each.
 *
 * Grouped by recipe id rather than by title: two recipes can share a name, and
 * merging them would send both links to whichever one came first. The ids of
 * every ingredient row this recipe contributed travel with the link, because a
 * recipe can call for the same canonical ingredient more than once - "kosher
 * salt" and "salt" are one grocery line - and the cook wants to see both.
 */
function usedBy(uses: readonly GroceryRecipeUse[]) {
  const byRecipe = new Map<number, { title: string; ingredientIds: number[] }>();
  for (const use of uses) {
    const recipe = byRecipe.get(use.recipe_id);
    if (recipe) recipe.ingredientIds.push(use.ingredient_id);
    else
      byRecipe.set(use.recipe_id, {
        title: use.recipe_title,
        ingredientIds: [use.ingredient_id],
      });
  }
  return [...byRecipe].map(([id, recipe]) => ({ id, ...recipe }));
}

/**
 * "for Curry, Tacos" - each recipe a link to itself, opened on this ingredient.
 *
 * Deliberately not inside the row's label. A label hands clicks on its text to
 * its checkbox, and following one of these is not ticking the item off.
 */
function ItemUses({ item }: { item: GroceryItem }) {
  const recipes = usedBy(item.uses);
  if (recipes.length === 0) return null;
  return (
    <div className="uses">
      for{" "}
      {recipes.map((recipe, i) => (
        <Fragment key={recipe.id}>
          {i > 0 && ", "}
          <Link
            className="use-link"
            to={recipeIngredientPath(recipe.id, recipe.ingredientIds)}
            // The title alone is ambiguous read out of the row: a list of a
            // dozen "Curry" links, each opening the recipe somewhere else. It
            // stays the start of the name so saying "Curry" still picks it.
            aria-label={`${recipe.title}, at ${item.name}`}
          >
            {recipe.title}
          </Link>
        </Fragment>
      ))}
    </div>
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
        <div className="item-text">
          {/* The label wraps only the checkbox and the name. It used to wrap
              the whole row, which would make a click on the price toggle tick
              the item off as well - and the recipe links below would be the
              same trap. */}
          <label className="grocery-check">
            <input
              type="checkbox"
              checked={item.checked}
              onChange={() => onToggle(item)}
            />
            <ItemName item={item} />
          </label>
          <ItemUses item={item} />
        </div>
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
      <div className="item-text">
        <ItemName item={item} />
        <ItemUses item={item} />
      </div>
      <Button size="small" onClick={() => onBuyAnyway(item)}>
        Buy anyway
      </Button>
    </div>
  );
}
