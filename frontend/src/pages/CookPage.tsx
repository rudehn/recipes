import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { primeAlarm, ringAlarm } from "../alarm";
import { api, type Recipe } from "../api";
import { Button, EmptyState, IconButton, LinkButton, Toolbar } from "../components/ui";
import {
  clearProgress,
  freshProgress,
  hasProgress,
  loadProgress,
  saveProgress,
  type CookProgress,
  type CookTimer,
} from "../cookProgress";
import { formatClock, splitStep, type Duration } from "../durations";
import { PHONE, below } from "../layout";
import { formatQuantity } from "../quantity";
import { recipeSteps } from "../steps";
import { useLoad } from "../useLoad";
import { useMediaQuery } from "../useMediaQuery";
import { useWakeLock } from "../useWakeLock";

/** How often a running countdown is redrawn. Under a second, so it never skips one. */
const TICK_MS = 250;
/** A finished timer rings this often... */
const RING_EVERY_MS = 2500;
/** ...for this long, then stays on screen quietly until it is dismissed. */
const RING_FOR_MS = 60_000;

const LEAVE_WITH_TIMERS =
  "Leave cook mode? Your timers keep counting, but they only ring while cook mode is open.";

/**
 * The current time, redrawn while anything is counting down. `refresh` brings
 * it up to date at once, for the tap that starts a timer: without it the new
 * countdown would show a few seconds more than it was started with until the
 * next tick.
 */
function useNow(ticking: boolean): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const handle = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(handle);
  }, [ticking]);
  return [now, useCallback(() => setNow(Date.now()), [])];
}

/** A timer for a time written in a step, starting now. */
function timerFrom(step: number, duration: Duration): CookTimer {
  const now = Date.now();
  return {
    id: `${now}-${step}-${duration.start}`,
    step,
    at: duration.start,
    text: duration.text,
    endsAt: now + duration.seconds * 1000,
  };
}

/**
 * Cook mode: one step at a time, large, with the screen held on.
 *
 * Its own screen rather than a view of the recipe page. It sits outside the app
 * shell, so no navigation competes with Back and Next for the bottom of a
 * phone, and it has its own URL, so a reload - or iOS relaunching a discarded
 * app - lands back in it. Where the cook was is kept in cookProgress.
 *
 * Keyed by recipe so moving from one recipe's cook mode to another's starts
 * from that recipe's own progress rather than carrying the last one's over.
 */
export default function CookPage() {
  const { id } = useParams();
  return <Cooking key={id} recipeId={Number(id)} />;
}

function Cooking({ recipeId }: { recipeId: number }) {
  const { data: recipe, error, reload } = useLoad(
    useCallback(() => api.getRecipe(recipeId), [recipeId]),
  );

  if (error && !recipe) {
    return (
      <div className="cook cook-failed">
        <EmptyState glyph="🤷" title={error} role="alert">
          <Toolbar center>
            <Button variant="primary" onClick={reload}>
              Try again
            </Button>
            <LinkButton to={`/recipes/${recipeId}`}>Back to the recipe</LinkButton>
          </Toolbar>
        </EmptyState>
      </div>
    );
  }
  if (!recipe) return null;
  return <Kitchen recipe={recipe} />;
}

function Kitchen({ recipe }: { recipe: Recipe }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const wake = useWakeLock();
  const phone = useMediaQuery(below(PHONE));

  const [progress, setProgress] = useState<CookProgress>(() => loadProgress(recipe.id));
  const [resumed, setResumed] = useState(() => hasProgress(progress));
  const [view, setView] = useState<"steps" | "ingredients">("steps");
  const [now, refreshNow] = useNow(progress.timers.length > 0);
  const main = useRef<HTMLElement | null>(null);

  useEffect(() => saveProgress(recipe.id, progress), [recipe.id, progress]);

  const steps = recipeSteps(recipe.instructions);
  const last = Math.max(0, steps.length - 1);
  // A recipe edited to fewer steps since the progress was saved.
  const step = Math.min(progress.step, last);

  // The same scaling the recipe page's stepper applied, carried in the link.
  const wanted = Number(params.get("servings"));
  const servings = recipe.servings && Number.isInteger(wanted) && wanted > 0 ? wanted : null;
  const factor = servings && recipe.servings ? servings / recipe.servings : 1;

  const timers = [...progress.timers].sort((a, b) => a.endsAt - b.endsAt);
  const ringing = timers.some((t) => now >= t.endsAt && now - t.endsAt < RING_FOR_MS);

  useEffect(() => {
    if (!ringing) return;
    ringAlarm();
    const handle = setInterval(ringAlarm, RING_EVERY_MS);
    return () => clearInterval(handle);
  }, [ringing]);

  const goTo = useCallback(
    (to: number) => {
      setResumed(false);
      setView("steps");
      setProgress((p) => ({ ...p, step: Math.max(0, Math.min(to, last)) }));
      main.current?.scrollTo?.({ top: 0 });
    },
    [last],
  );

  // Arrow keys for a laptop on the counter. Not while typing, and a ticked
  // checkbox keeps focus, so it is not counted as typing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]')) {
        return;
      }
      if (event.key === "ArrowRight" && step < last) goTo(step + 1);
      else if (event.key === "ArrowLeft" && step > 0) goTo(step - 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goTo, step, last]);

  function toggleIngredient(id: number) {
    setProgress((p) => ({
      ...p,
      checked: p.checked.includes(id) ? p.checked.filter((c) => c !== id) : [...p.checked, id],
    }));
  }

  function startTimer(duration: Duration) {
    primeAlarm();
    refreshNow();
    const timer = timerFrom(step, duration);
    setProgress((p) => ({ ...p, timers: [...p.timers, timer] }));
  }

  function addMinute(timer: CookTimer) {
    primeAlarm();
    refreshNow();
    setProgress((p) => ({
      ...p,
      timers: p.timers.map((t) =>
        t.id === timer.id ? { ...t, endsAt: Math.max(t.endsAt, Date.now()) + 60_000 } : t,
      ),
    }));
  }

  function removeTimer(timer: CookTimer) {
    setProgress((p) => ({ ...p, timers: p.timers.filter((t) => t.id !== timer.id) }));
  }

  function startOver() {
    setResumed(false);
    setProgress(freshProgress());
    main.current?.scrollTo?.({ top: 0 });
  }

  function confirmLeave(event: MouseEvent) {
    if (progress.timers.length > 0 && !window.confirm(LEAVE_WITH_TIMERS)) event.preventDefault();
  }

  function finish() {
    if (progress.timers.length > 0 && !window.confirm(LEAVE_WITH_TIMERS)) return;
    clearProgress(recipe.id);
    navigate(`/recipes/${recipe.id}`);
  }

  const checkedCount = recipe.ingredients.filter((i) => progress.checked.includes(i.id!)).length;
  const showIngredients = !phone || view === "ingredients";
  const showSteps = !phone || view === "steps";

  return (
    <div className="cook">
      <header className="cook-bar">
        <LinkButton size="small" to={`/recipes/${recipe.id}`} onClick={confirmLeave}>
          <span aria-hidden>✕</span> Exit
        </LinkButton>
        <h1 className="cook-title">{recipe.title}</h1>
        <span
          className={wake === "on" ? "cook-wake on" : "cook-wake"}
          title={
            wake === "on"
              ? "Cook mode is keeping your screen from locking"
              : "This browser did not let cook mode keep the screen on"
          }
        >
          {wake === "on" ? "Screen stays on" : "Screen may sleep"}
        </span>
      </header>

      {phone && (
        <div className="cook-tabs" role="tablist" aria-label="Show">
          <button
            type="button"
            role="tab"
            id="cook-tab-steps"
            aria-selected={view === "steps"}
            aria-controls="cook-steps"
            onClick={() => setView("steps")}
          >
            Steps
          </button>
          <button
            type="button"
            role="tab"
            id="cook-tab-ingredients"
            aria-selected={view === "ingredients"}
            aria-controls="cook-ingredients"
            onClick={() => setView("ingredients")}
          >
            Ingredients
            {recipe.ingredients.length > 0 && (
              <span className="count">
                {checkedCount}/{recipe.ingredients.length}
              </span>
            )}
          </button>
        </div>
      )}

      <div className="cook-body">
        {showIngredients && (
          <section
            className="cook-ingredients"
            id="cook-ingredients"
            aria-labelledby={phone ? "cook-tab-ingredients" : "cook-ingredients-title"}
            role={phone ? "tabpanel" : undefined}
          >
            <h2 id="cook-ingredients-title">
              Ingredients
              {servings !== null && servings !== recipe.servings && (
                <span className="cook-scaled">for {servings} servings</span>
              )}
            </h2>
            <ul className="cook-checklist">
              {recipe.ingredients.map((ing, i) => {
                const checked = progress.checked.includes(ing.id!);
                const quantity = ing.quantity != null ? ing.quantity * factor : null;
                return (
                  <li key={ing.id ?? i}>
                    <label className={checked ? "checked" : undefined}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleIngredient(ing.id!)}
                      />
                      <span className="qty">{formatQuantity(quantity, ing.unit)}</span>
                      <span className="name">{ing.name}</span>
                    </label>
                  </li>
                );
              })}
              {recipe.ingredients.length === 0 && (
                <li className="empty-note">No ingredients listed.</li>
              )}
            </ul>
          </section>
        )}

        {showSteps && (
          <section
            className="cook-main"
            id="cook-steps"
            ref={main}
            aria-labelledby={phone ? "cook-tab-steps" : "cook-step-title"}
            role={phone ? "tabpanel" : undefined}
          >
            {steps.length === 0 ? (
              <p className="cook-empty">
                This recipe has no steps yet.{" "}
                <Link className="cook-link" to={`/recipes/${recipe.id}/edit`}>
                  Add them
                </Link>
              </p>
            ) : (
              <div className="cook-step">
                <div className="cook-step-head">
                  <h2 className="cook-count" id="cook-step-title">
                    Step {step + 1} <span>of {steps.length}</span>
                  </h2>
                  {resumed && (
                    <p className="cook-resumed">
                      Picked up where you left off ·{" "}
                      <button type="button" className="cook-link" onClick={startOver}>
                        Start over
                      </button>
                    </p>
                  )}
                </div>
                <ol className="cook-progress">
                  {steps.map((_, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className={i < step ? "done" : i === step ? "current" : undefined}
                        aria-label={`Go to step ${i + 1}`}
                        aria-current={i === step ? "step" : undefined}
                        onClick={() => goTo(i)}
                      />
                    </li>
                  ))}
                </ol>
                <p className="cook-text" aria-live="polite">
                  {splitStep(steps[step]).map((part, i) => {
                    if (typeof part === "string") return part;
                    const timer = progress.timers.find((t) => t.step === step && t.at === part.start);
                    if (!timer) {
                      return (
                        <button
                          key={i}
                          type="button"
                          className="cook-duration"
                          aria-label={`Start a ${part.text} timer`}
                          onClick={() => startTimer(part)}
                        >
                          <span className="glyph" aria-hidden>
                            ⏱
                          </span>
                          {part.text}
                        </button>
                      );
                    }
                    const done = now >= timer.endsAt;
                    return (
                      <span key={i} className={done ? "cook-duration done" : "cook-duration running"}>
                        <span className="glyph" aria-hidden>
                          ⏱
                        </span>
                        {part.text}
                        <span className="left">
                          {done ? "done" : formatClock((timer.endsAt - now) / 1000)}
                        </span>
                      </span>
                    );
                  })}
                </p>
              </div>
            )}
          </section>
        )}
      </div>

      {timers.length > 0 && (
        <section className="cook-timers" aria-label="Timers">
          <ul>
            {timers.map((timer) => {
              const done = now >= timer.endsAt;
              return (
                <li key={timer.id} className={done ? "cook-timer done" : "cook-timer"}>
                  <button
                    type="button"
                    className="cook-timer-step"
                    aria-label={`Step ${timer.step + 1}, ${timer.text}. Go to step ${timer.step + 1}`}
                    onClick={() => goTo(timer.step)}
                  >
                    Step {timer.step + 1} · {timer.text}
                  </button>
                  {/* Remounted rather than updated when it finishes: an alert is
                      announced when it appears, and a countdown that was one all
                      along would be read out every second. */}
                  {done ? (
                    <span key="done" className="cook-timer-left" role="alert">
                      Done
                    </span>
                  ) : (
                    <span key="left" className="cook-timer-left">
                      {formatClock((timer.endsAt - now) / 1000)}
                    </span>
                  )}
                  <Button size="small" onClick={() => addMinute(timer)}>
                    +1 min
                  </Button>
                  <IconButton
                    label={done ? `Dismiss the ${timer.text} timer` : `Cancel the ${timer.text} timer`}
                    onClick={() => removeTimer(timer)}
                  >
                    ✕
                  </IconButton>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="cook-controls">
        <Button onClick={() => goTo(step - 1)} disabled={step === 0 || steps.length === 0}>
          <span aria-hidden>←</span> Back
        </Button>
        {step < last ? (
          <Button variant="primary" onClick={() => goTo(step + 1)}>
            Next step <span aria-hidden>→</span>
          </Button>
        ) : (
          <Button variant="primary" onClick={finish}>
            Finish
          </Button>
        )}
      </footer>
    </div>
  );
}
