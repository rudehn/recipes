import { money, type Costed } from "./plan";

/**
 * What a day or a meal costs to cook, as far as it is known.
 *
 * Shown plain when every ingredient is priced, and as "$6.20+" when only some
 * are: the figure is then a floor, and a bare number would read as the whole.
 * The plus is shorthand a screen reader cannot speak, so the words travel in
 * the title and the accessible name. The role is what lets that name be read
 * at all; a label on a plain span is one assistive tech may skip.
 */
export function PlanFigure({ cost }: { cost: Costed }) {
  const floor = cost.priced < cost.total_lines;
  const label =
    `${floor ? "at least " : ""}${money(cost.total)}, ` +
    `${cost.priced} of ${cost.total_lines} ingredient${cost.total_lines === 1 ? "" : "s"} priced`;
  return (
    <span className="plan-cost" role="img" aria-label={label} title={label}>
      {money(cost.total)}
      {floor && "+"}
    </span>
  );
}
