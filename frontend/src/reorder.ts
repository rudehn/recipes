/** `items` with the one at `from` taken out and put back in at `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const moved = [...items];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  return moved;
}

/**
 * Where a row dragged from `from` would land, given the middle of every row
 * as laid out before the drag and the middle of the dragged row now.
 *
 * It lands after every other row whose middle it has passed, so a row moves
 * into a neighbour's place as soon as it is more than half way over it.
 */
export function dropIndex(middles: readonly number[], from: number, middle: number): number {
  return middles.filter((m, i) => i !== from && m < middle).length;
}
