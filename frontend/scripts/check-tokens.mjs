/**
 * Guards the one invariant the token layer depends on: rules reference tokens,
 * they do not restate them.
 *
 * A literal colour in a rule is a decision made twice, and the second one
 * drifts - which is exactly how this stylesheet ended up with the same border
 * written five times at two different alphas, and the app's background written
 * into three files that had no way of disagreeing loudly.
 *
 * This is a script rather than stylelint because it is one rule, and stylelint
 * cannot express "except inside :root" without disable comments wrapped around
 * the token block. If CSS linting grows beyond this, stylelint with a custom
 * plugin is the upgrade path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../src/styles.css", import.meta.url));

/** Properties whose every value should come from the space scale. */
const SPACING = /^(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?$/;

const source = readFileSync(FILE, "utf8");

// Blank out comments and every :root block so their offsets still line up with
// the original, and a reported line number still points at the right place.
//
// Every one of them, not just the first: a theme is a second :root inside a
// media query, and its literals are token definitions exactly like the ones
// above it. The rule is about where a colour is declared, not how deeply it
// happens to be nested.
const blank = (text) => text.replace(/[^\n]/g, " ");
let scannable = source.replace(/\/\*[\s\S]*?\*\//g, blank);

const ROOT_BLOCK = /:root\s*\{[\s\S]*?\n\s*\}/g;
const roots = [...scannable.matchAll(ROOT_BLOCK)];
if (roots.length === 0) {
  console.error("check-tokens: no :root block found in styles.css");
  process.exit(1);
}
for (const root of roots) {
  scannable =
    scannable.slice(0, root.index) +
    blank(root[0]) +
    scannable.slice(root.index + root[0].length);
}

const lineOf = (index) => source.slice(0, index).split("\n").length;

const problems = [];

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/g;
for (const match of scannable.matchAll(COLOUR)) {
  problems.push({
    line: lineOf(match.index),
    found: match[0],
    why: "raw colour - add a token to :root and reference it",
  });
}

// Only flag px inside spacing properties. Component geometry (a 34px brand
// mark, a 19px checkbox, grid track minimums) is deliberately not tokenized:
// those are one thing's dimensions, not a shared decision.
const DECL = /(^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g;
for (const match of scannable.matchAll(DECL)) {
  const [, , prop, value] = match;
  if (!SPACING.test(prop)) continue;
  for (const px of value.matchAll(/(?<![\w-])(\d*\.?\d+)px/g)) {
    // A single pixel is an optical nudge, never a rhythm choice - the same
    // reason a 1px border is not a spacing decision. Anything larger is.
    if (px[1] === "1") continue;
    problems.push({
      line: lineOf(match.index + match[0].indexOf(value) + px.index),
      found: `${prop}: ${px[0]}`,
      why: "raw spacing - use a --space-* token",
    });
  }
}

// A token nothing reaches for is a decision nobody asked for. They arrive by
// padding a scale out to look regular, and they read later as though the app
// uses a rung it has never once stood on. Single use is fine and common -
// there is only one modal scrim - so only zero is a defect.
const referenced = new Set(
  [...source.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]),
);
// A theme redeclares names the base block already introduced, so a token
// counts as used if anything references it anywhere.
const seen = new Set();
for (const root of roots) {
  for (const token of root[0].matchAll(/^\s*(--[\w-]+):/gm)) {
    const name = token[1];
    if (referenced.has(name) || seen.has(name)) continue;
    seen.add(name);
    problems.push({
      line: lineOf(root.index + token.index),
      found: name,
      why: "unused token - delete it, or use it",
    });
  }
}

if (problems.length === 0) {
  console.log("check-tokens: ok");
  process.exit(0);
}

console.error(`check-tokens: ${problems.length} problem(s) in src/styles.css\n`);
for (const p of problems.sort((a, b) => a.line - b.line)) {
  console.error(`  styles.css:${p.line}  ${p.found}\n      ${p.why}`);
}
process.exit(1);
