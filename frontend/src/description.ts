/**
 * A recipe's description as its paragraphs.
 *
 * Typed into the form or read from pasted text, a description can run to
 * several paragraphs - the dish, then its notes and tips - with a blank line
 * between each. The recipe page shows each as a paragraph; a card, with room
 * for a line or two, shows the first. A single line break is part of its
 * paragraph, kept as it was written.
 */
export function descriptionParagraphs(description: string): string[] {
  return description
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/** The opening paragraph, for where only a line or two will fit. */
export function firstParagraph(description: string): string {
  return descriptionParagraphs(description)[0] ?? "";
}
