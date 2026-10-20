import { useId } from "react";
import { Link } from "react-router-dom";

import type { Affects, RecipeAttention } from "../api";
import { ISSUE_LABELS, NO_SERVINGS_LABEL } from "../issues";
import { recipeIngredientPath, recipeNutritionPath } from "../recipeLink";

/** What a line of "Needs a look" holds up, which decides the list it is in. */
type Holds = "both" | "nutrition" | "price";

/**
 * The lists, in order. A row the recipe has wrong comes first, since one edit
 * to it settles the price and the nutrition together.
 */
const HOLDS: [Holds, string][] = [
  ["both", "Price and nutrition"],
  ["nutrition", "Nutrition"],
  ["price", "Price"],
];

function holds(affects: Affects[]): Holds {
  const price = affects.includes("price");
  const nutrition = affects.includes("nutrition");
  return price && nutrition ? "both" : price ? "price" : "nutrition";
}

interface AttentionLine {
  key: string;
  /** Where the fix is. */
  to: string;
  name: string;
  why: string;
}

/**
 * A recipe's lines sorted by what they hold up, each linked to its fix. A
 * price, or a row the recipe has wrong, is fixed on the row; a food is chosen
 * in the nutrition breakdown; the servings are in the edit form. A row held up
 * for a reason on each side - nothing matched, and no food chosen - is in both
 * lists, since each has its own fix.
 */
function attentionLines(entry: RecipeAttention): Map<Holds, AttentionLine[]> {
  const id = entry.recipe.id;
  const lines = new Map<Holds, AttentionLine[]>(HOLDS.map(([h]) => [h, []]));
  if (entry.no_servings) {
    lines.get("nutrition")!.push({
      key: "servings",
      to: `/recipes/${id}/edit`,
      name: "Whole recipe",
      why: NO_SERVINGS_LABEL,
    });
  }
  for (const row of entry.issues) {
    const held = holds(row.affects);
    lines.get(held)!.push({
      key: String(row.ingredient_id),
      to:
        held === "nutrition"
          ? recipeNutritionPath(id, row.ingredient_id)
          : recipeIngredientPath(id, [row.ingredient_id]),
      name: row.name,
      why: ISSUE_LABELS[row.issue],
    });
  }
  return lines;
}

/**
 * How much of a recipe's price and nutrition is held up: "2 for nutrition ·
 * 1 for price". A row the recipe has wrong is counted in both, since fixing
 * it settles both.
 */
function heldUp(lines: Map<Holds, AttentionLine[]>): string {
  const both = lines.get("both")!.length;
  const counts: [string, number][] = [
    ["nutrition", both + lines.get("nutrition")!.length],
    ["price", both + lines.get("price")!.length],
  ];
  return counts
    .filter(([, n]) => n > 0)
    .map(([what, n]) => `${n} for ${what}`)
    .join(" · ");
}

/** One list of a recipe's lines, under what they hold up. */
function AttentionGroup({ heading, lines }: { heading: string; lines: AttentionLine[] }) {
  const headingId = useId();
  return (
    <div className="attention-group">
      <p className="attention-heading" id={headingId}>
        {heading}
      </p>
      <ul className="attention-items" aria-labelledby={headingId}>
        {lines.map((line) => (
          <li key={line.key}>
            <Link to={line.to}>{line.name}</Link>
            <span className="issue-tag">{line.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Recipes with rows that will price, shop or count wrongly, a card each.
 *
 * Within a recipe the lines are listed under what they hold up - the price,
 * the nutrition, or both - since the fixes differ, and each links to where its
 * fix is. Shared by the Recipes page's fold and the Ingredients page's
 * "By recipe" view, so the two cannot drift apart.
 */
export function RecipeAttentionList({ entries }: { entries: RecipeAttention[] }) {
  return (
    <>
      {entries.map((entry) => {
        const lines = attentionLines(entry);
        return (
          <div key={entry.recipe.id} className="attention-recipe">
            <div className="attention-title">
              <Link to={`/recipes/${entry.recipe.id}`}>{entry.recipe.title}</Link>
              <span className="attention-coverage">{heldUp(lines)}</span>
            </div>
            <div className="attention-groups">
              {HOLDS.filter(([held]) => lines.get(held)!.length > 0).map(([held, heading]) => (
                <AttentionGroup key={held} heading={heading} lines={lines.get(held)!} />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
