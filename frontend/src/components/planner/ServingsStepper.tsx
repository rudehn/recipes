/**
 * A planned meal's servings with a − and a + either side of the count. The
 * count is marked when the meal has one of its own rather than its recipe's.
 */
export function ServingsStepper({
  count,
  overridden,
  onStep,
}: {
  count: number;
  /** Whether the count is the meal's own, not its recipe's. */
  overridden: boolean;
  /** Steps the count by one, down (-1) or up (1). */
  onStep: (delta: number) => void;
}) {
  return (
    <div className="serv">
      <button type="button" aria-label="Fewer servings" onClick={() => onStep(-1)}>
        −
      </button>
      <span
        className={overridden ? "overridden" : ""}
        title={`${count} serving${count === 1 ? "" : "s"}`}
      >
        ×{count}
      </span>
      <button type="button" aria-label="More servings" onClick={() => onStep(1)}>
        +
      </button>
    </div>
  );
}
