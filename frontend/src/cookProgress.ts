/**
 * Where a cook is in a recipe: the step on screen, the ingredients ticked off,
 * and the timers running.
 *
 * Kept in localStorage rather than component state, because iOS discards a
 * backgrounded home-screen app without warning. Switching to a messages app
 * mid-recipe should not send the cook back to step one with every tick gone
 * and the pasta timer forgotten. Not sessionStorage for the same reason: a
 * discarded standalone app comes back as a new session.
 *
 * Timers are stored as the moment they end, never as time remaining, so a page
 * that was frozen in the background - or reloaded from scratch - still knows
 * exactly how long is left.
 *
 * Progress older than STALE_AFTER_MS is dropped on read: coming back to a
 * recipe tomorrow is cooking it again, not resuming it.
 */

export interface CookTimer {
  id: string;
  /** Zero-based index of the step it was started from. */
  step: number;
  /** Where in that step its words start, telling apart two "5 minutes" in one step. */
  at: number;
  /** The words it was started from, "12 minutes". */
  text: string;
  /** Epoch milliseconds when it finishes. */
  endsAt: number;
}

export interface CookProgress {
  step: number;
  /** Ids of the ingredients ticked off. */
  checked: number[];
  timers: CookTimer[];
}

interface Stored extends CookProgress {
  savedAt: number;
}

export const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

const key = (recipeId: number) => `mise:cook:${recipeId}`;

export const freshProgress = (): CookProgress => ({ step: 0, checked: [], timers: [] });

/** Whether there is anything to resume, as opposed to a cook just starting. */
export function hasProgress(progress: CookProgress): boolean {
  return progress.step > 0 || progress.checked.length > 0 || progress.timers.length > 0;
}

export function loadProgress(recipeId: number, now = Date.now()): CookProgress {
  try {
    const raw = localStorage.getItem(key(recipeId));
    if (!raw) return freshProgress();
    const stored = JSON.parse(raw) as Partial<Stored>;
    if (typeof stored.savedAt !== "number" || now - stored.savedAt > STALE_AFTER_MS) {
      localStorage.removeItem(key(recipeId));
      return freshProgress();
    }
    return {
      step: Number.isInteger(stored.step) && stored.step! >= 0 ? stored.step! : 0,
      checked: Array.isArray(stored.checked) ? stored.checked.filter(Number.isInteger) : [],
      timers: Array.isArray(stored.timers) ? stored.timers : [],
    };
  } catch {
    // Private browsing, a full quota, or something unreadable left by an older
    // build: none of them are worth failing to cook over.
    return freshProgress();
  }
}

export function saveProgress(recipeId: number, progress: CookProgress, now = Date.now()): void {
  try {
    if (!hasProgress(progress)) {
      localStorage.removeItem(key(recipeId));
      return;
    }
    const stored: Stored = { ...progress, savedAt: now };
    localStorage.setItem(key(recipeId), JSON.stringify(stored));
  } catch {
    // As above: progress that cannot be kept is a smaller loss than an error.
  }
}

export function clearProgress(recipeId: number): void {
  try {
    localStorage.removeItem(key(recipeId));
  } catch {
    // Nothing to do.
  }
}
