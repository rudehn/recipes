/**
 * How many of a card's tag chips fit on its one line, beside a "+N" chip
 * counting the rest.
 *
 * A card shows its first few tags by name and counts the others. Wrapped onto
 * a second line, that row strands a lone "+1" or a lone tag under the others
 * and makes the card a line taller than its neighbours; so a chip that would
 * wrap is given up to the count instead. The first chip is always kept, to
 * be cut short with an ellipsis if even it is too wide, rather than a card
 * showing a count of tags and none of their names.
 *
 * `widths` are the candidate chips' natural widths in order, `total` how many
 * tags the recipe has in all, `plus` the count chip's width, and `room` the
 * width of the line. Where nothing has been laid out - every width zero -
 * every candidate is kept, which is the answer the markup alone would give.
 */
export function chipsThatFit({
  widths,
  total,
  plus,
  gap,
  room,
}: {
  widths: readonly number[];
  total: number;
  plus: number;
  gap: number;
  room: number;
}): number {
  for (let kept = widths.length; kept > 1; kept--) {
    const chips = widths.slice(0, kept).reduce((sum, w) => sum + w, 0) + (kept - 1) * gap;
    const count = kept < total ? gap + plus : 0;
    if (chips + count <= room) return kept;
  }
  return Math.min(widths.length, 1);
}
