import { useId, useState } from "react";

import {
  api,
  type CartResult,
  type Modality,
  type PastedLine,
  type PastePlan,
} from "../api";
import { PASTE_PROBLEM_LABELS, unsizedLabel } from "../issues";
import { errorMessage } from "../useLoad";
import { CartStepper } from "./CartStepper";
import { ProductPickerModal } from "./ProductPicker";
import { Banner, Button, IconButton } from "./ui";

const money = (n: number) => `$${n.toFixed(2)}`;

const itemCount = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

/**
 * The text being pasted, kept on this device until it is sent. A per-device
 * convenience - closing the panel by accident should not lose a list typed
 * out by hand - so every read and write is guarded: storage can be absent,
 * and in some contexts it throws.
 */
const DRAFT_KEY = "paste-list-draft";

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(text: string) {
  try {
    if (text.trim()) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Only a convenience; the list on screen is unaffected.
  }
}

const PLACEHOLDER = "milk\neggs x2\n2 lb ground beef\npaper towels";

/**
 * A shopping list pasted from anywhere, sent straight to the Kroger cart.
 *
 * Nothing here touches the grocery list, the planner or the pantry: the text
 * is read, matched, reviewed and sent. The review is still not optional. The
 * cart is write-only (ADR 4), so every product and every count is on screen
 * before anything goes, and the send is planned again on the server from
 * the same text rather than trusting what the page shows.
 *
 * Unlike the grocery list's review, a line that cannot be ordered stays in
 * its place, with the reason and a way to choose the product. There is
 * nowhere else to put a pasted line right, and a line that moved out from
 * under the reader could not be checked against the list they pasted.
 */
export function PasteToCart({ onSent }: { onSent: (result: CartResult) => void }) {
  const fieldId = useId();
  const [text, setText] = useState(readDraft);
  const [plan, setPlan] = useState<PastePlan | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts the shopper set by hand, by key. A count back at the worked-out
  // one is dropped, so an untouched line sends exactly what the server plans.
  const [quantities, setQuantities] = useState<ReadonlyMap<string, number>>(new Map());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [modality, setModality] = useState<Modality>("PICKUP");
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState<PastedLine | null>(null);

  function edit(next: string) {
    setText(next);
    saveDraft(next);
  }

  /**
   * Look the list up. `keep` holds on to the counts and removals already
   * made, for a lookup that follows a product being chosen rather than the
   * text being changed.
   */
  async function find(keep = false) {
    setFinding(true);
    setError(null);
    try {
      const next = await api.pastePreview(text);
      setPlan(next);
      if (!keep) {
        setQuantities(new Map());
        setRemoved(new Set());
      }
    } catch (cause) {
      setError(errorMessage(cause, "Could not look this list up at Kroger."));
    } finally {
      setFinding(false);
    }
  }

  async function choose(line: PastedLine, change: () => Promise<void>) {
    setPicking(null);
    setError(null);
    try {
      await change();
    } catch (cause) {
      setError(errorMessage(cause, `Could not change the product for ${line.name}.`));
      return;
    }
    await find(true);
  }

  function quantityOf(line: PastedLine): number {
    return quantities.get(line.key) ?? line.quantity;
  }

  function setQuantity(line: PastedLine, next: number) {
    setQuantities((prev) => {
      const changed = new Map(prev);
      if (next === line.quantity) changed.delete(line.key);
      else changed.set(line.key, next);
      return changed;
    });
  }

  function toggleRemoved(line: PastedLine) {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(line.key)) next.delete(line.key);
      else next.add(line.key);
      return next;
    });
  }

  /**
   * Not routed through `useAction`: what came back matters. The server plans
   * again as it sends, so how many actually reached the cart is its answer
   * rather than the count on screen.
   */
  async function send() {
    setSending(true);
    setError(null);
    try {
      const result = await api.pasteToCart(
        text,
        modality,
        Object.fromEntries(quantities),
        [...removed],
      );
      saveDraft("");
      onSent(result);
    } catch (cause) {
      setError(errorMessage(cause, "Nothing was sent to your Kroger cart."));
      setSending(false);
    }
  }

  if (plan === null) {
    return (
      <div className="cart-review paste-list">
        {error && <Banner tone="error">{error}</Banner>}
        <label className="paste-label" htmlFor={fieldId}>
          Your shopping list
        </label>
        <textarea
          id={fieldId}
          autoFocus
          // Grows with the list, so a week's shopping is seen whole rather
          // than scrolled inside a box; past that the box scrolls.
          rows={Math.min(16, Math.max(6, text.split("\n").length + 1))}
          value={text}
          placeholder={PLACEHOLDER}
          onChange={(e) => edit(e.target.value)}
        />
        <p className="section-note">
          One item per line, or commas on a single line. &ldquo;eggs x2&rdquo; orders two;
          &ldquo;2 lb ground beef&rdquo; orders enough to cover it. Lines already ticked off
          are left out.
        </p>
        <div className="cart-send">
          <Button
            variant="primary"
            onClick={() => find()}
            disabled={finding || text.trim() === ""}
          >
            {finding ? "Looking…" : "Find at Kroger"}
          </Button>
        </div>
      </div>
    );
  }

  const sendable = plan.lines.filter((line) => !line.problem && !removed.has(line.key));
  // What the shelf prices add up to for the counts on screen. "About",
  // because a weight-sold item is charged for what is actually weighed.
  const total = sendable.reduce(
    (sum, line) =>
      sum + quantityOf(line) * (line.product ? (line.product.promo ?? line.product.regular) : 0),
    0,
  );

  return (
    <div className="cart-review paste-list">
      {error && <Banner tone="error">{error}</Banner>}

      <div className="paste-summary">
        <span>
          {itemCount(sendable.length)} to send
          {total > 0 && <> · about {money(total)}</>}
        </span>
        <Button size="small" onClick={() => setPlan(null)} disabled={sending}>
          Edit list
        </Button>
      </div>

      {plan.lines.length === 0 ? (
        <p className="list-status">Nothing in that text reads as something to buy.</p>
      ) : (
        <ul className="cart-lines paste-lines" aria-busy={finding}>
          {plan.lines.map((line) => (
            <PasteRow
              key={line.key}
              line={line}
              quantity={quantityOf(line)}
              removed={removed.has(line.key)}
              onQuantity={(next) => setQuantity(line, next)}
              onToggleRemoved={() => toggleRemoved(line)}
              onChoose={() => setPicking(line)}
            />
          ))}
        </ul>
      )}

      {plan.ticked.length > 0 && (
        <p className="section-note">
          Left out because they were ticked off: {plan.ticked.join(", ")}.
        </p>
      )}

      <div className="cart-send">
        <label>
          Collect by{" "}
          <select value={modality} onChange={(e) => setModality(e.target.value as Modality)}>
            <option value="PICKUP">Pickup</option>
            <option value="DELIVERY">Delivery</option>
          </select>
        </label>
        <Button
          variant="primary"
          onClick={send}
          disabled={sending || finding || sendable.length === 0}
        >
          {sending
            ? "Sending…"
            : sendable.length === 0
              ? "Nothing to send"
              : `Send ${itemCount(sendable.length)} to Kroger`}
        </Button>
      </div>

      {picking && (
        <ProductPickerModal
          line={picking}
          offerNone={false}
          onPick={(productId) => {
            const line = picking;
            if (productId) void choose(line, () => api.setMatch(line.key, productId));
          }}
          onForget={() => {
            const line = picking;
            void choose(line, () => api.forgetMatch(line.key));
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

/**
 * One pasted line: how many, the shopper's word for it, Kroger's, and the
 * way to change or drop it.
 *
 * A line taken off stays where it was, struck through, with a way to put it
 * back - the same reasoning as a grocery mark: a row that vanishes when
 * tapped cannot be un-tapped.
 */
function PasteRow({
  line,
  quantity,
  removed,
  onQuantity,
  onToggleRemoved,
  onChoose,
}: {
  line: PastedLine;
  quantity: number;
  removed: boolean;
  onQuantity: (next: number) => void;
  onToggleRemoved: () => void;
  onChoose: () => void;
}) {
  const orderable = !line.problem && !removed;
  const { product } = line;
  const classes = [removed && "removed", line.problem && "problem"].filter(Boolean).join(" ");

  return (
    <li className={classes || undefined}>
      {orderable ? (
        <CartStepper name={line.name} quantity={quantity} onChange={onQuantity} />
      ) : (
        // Held open at the stepper's width, so the names stay in one column
        // whether or not the line can be counted.
        <span className="stepper-slot" aria-hidden="true">
          <CartStepper name={line.name} quantity={quantity} onChange={() => {}} />
        </span>
      )}

      <span className="item-name">
        <span className="name">{line.name}</span>
        {line.amount && <span className="covers">for {line.amount}</span>}
      </span>

      <span className="product" title={product?.description}>
        {removed ? (
          <>
            Taken off this order{" "}
            <button
              type="button"
              className="change"
              aria-label={`Put ${line.name} back`}
              onClick={onToggleRemoved}
            >
              Put back
            </button>
          </>
        ) : (
          <>
            {product && (
              <>
                {product.description}
                {product.size && ` · ${product.size}`}
                {" · "}
                <span className="price">{money(product.promo ?? product.regular)}</span>
              </>
            )}
            {line.problem && (
              <span className="why">
                {product ? " · " : ""}
                {PASTE_PROBLEM_LABELS[line.problem]}
              </span>
            )}
            {line.issue === "unsized" && line.amount && (
              <span className="why"> · {unsizedLabel(line.amount, product?.size)}</span>
            )}{" "}
            <button
              type="button"
              className="change"
              // The visible words, then which line: "Change" alone says
              // nothing to someone who cannot see where it sits.
              aria-label={`${product ? "Change the product" : "Choose a product"} for ${line.name}`}
              onClick={onChoose}
            >
              {product ? "Change" : "Choose a product"}
            </button>
          </>
        )}
      </span>

      {removed ? (
        <span className="remove-slot" aria-hidden="true">
          <IconButton label="" tabIndex={-1}>
            ✕
          </IconButton>
        </span>
      ) : (
        <IconButton label={`Take ${line.name} off this order`} onClick={onToggleRemoved}>
          ✕
        </IconButton>
      )}
    </li>
  );
}
