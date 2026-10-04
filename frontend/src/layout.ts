/**
 * The two widths the app changes shape at.
 *
 * A media query cannot read a custom property, so these numbers are written
 * out in styles.css as well - the one duplication the token layer cannot
 * remove. layout.test.ts reads both files and fails if they drift, which is
 * the same trade the stylesheet already makes for the theme colour: state it
 * twice, then make disagreement loud.
 *
 * Two rather than one, because they answer different questions. PHONE is
 * "does this have a thumb and no room" - it moves navigation to the bottom of
 * the screen and stops iOS zooming the page on a focused field. WEEK_GRID is
 * the width the planner's seven-day grid needs before it starts scrolling
 * sideways: 96px of label column plus seven 128px days plus their gaps and the
 * page's own padding. A day is that wide so a meal's title has room for its
 * words beside the remove button - see .week-grid in styles.css. Below it the
 * planner is a day-by-day agenda instead, which a tablet wants as much as a
 * phone does.
 */

/** Below this the app is laid out for a thumb. */
export const PHONE = 720;

/** Below this the planner's week grid no longer fits without scrolling. */
export const WEEK_GRID = 1100;

/** As a media query string, for useMediaQuery. */
export const below = (width: number) => `(max-width: ${width}px)`;
