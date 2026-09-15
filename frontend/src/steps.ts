/**
 * A recipe's instructions as its steps: one per line, blank lines and stray
 * indentation dropped. The recipe page and cook mode both number these, so
 * they have to agree on what a step is.
 */
export function recipeSteps(instructions: string): string[] {
  return instructions
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
