/** The most of one product a single send will order; the server's cap too. */
export const MAX_QUANTITY = 99;

/**
 * How many of a product go to the Kroger cart, with a button either side.
 *
 * Shared by the grocery list's review and a pasted list's, because it is the
 * same control doing the same job: the count is the one number on the line
 * that becomes a real order, so it is always shown and always the shopper's
 * to change.
 */
export function CartStepper({
  name,
  quantity,
  onChange,
}: {
  name: string;
  quantity: number;
  onChange: (next: number) => void;
}) {
  const set = (next: number) => onChange(Math.min(MAX_QUANTITY, Math.max(1, next)));
  return (
    <span className="stepper" role="group" aria-label={`How many ${name}`}>
      <button
        type="button"
        aria-label={`Fewer ${name}`}
        disabled={quantity <= 1}
        onClick={() => set(quantity - 1)}
      >
        −
      </button>
      <span className="quantity">{quantity}×</span>
      <button
        type="button"
        aria-label={`More ${name}`}
        disabled={quantity >= MAX_QUANTITY}
        onClick={() => set(quantity + 1)}
      >
        +
      </button>
    </span>
  );
}
