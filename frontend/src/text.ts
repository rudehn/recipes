/**
 * A name as the start of a sentence or a button: its first letter in capitals
 * and the rest as written. Names are kept lower case where they are stored -
 * an ingredient, a meal - and capitalised only where they are shown first.
 */
export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
