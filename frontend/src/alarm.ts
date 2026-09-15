/**
 * The sound a finished cook-mode timer makes.
 *
 * Synthesised rather than a bundled audio file: three short tones are a few
 * lines of Web Audio, and there is nothing to load or cache.
 *
 * iOS only lets a page make sound from an AudioContext that was started inside
 * a tap, and a timer finishes minutes after the last one. So the context is
 * created and resumed by `primeAlarm`, called from the tap that starts a timer,
 * and `ringAlarm` reuses it later. Where there is no Web Audio at all, a
 * vibration is still attempted and nothing throws.
 */

let context: AudioContext | null = null;

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Call from a user gesture, so the alarm is allowed to sound later. */
export function primeAlarm(): void {
  const Context = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
  if (!Context) return;
  try {
    context ??= new Context();
    if (context.state === "suspended") void context.resume();
  } catch {
    context = null;
  }
}

const TONE_HZ = 880;
const TONE_SECONDS = 0.18;
const GAP_SECONDS = 0.12;
const TONES = 3;
const VOLUME = 0.35;

/** One ring: three tones, and a buzz on a phone that can. */
export function ringAlarm(): void {
  // A browser refuses to vibrate for a page nobody has tapped since it loaded,
  // and logs the refusal as an error - which is what a timer that finished
  // while the app was relaunched would otherwise do on every ring.
  if (navigator.userActivation?.hasBeenActive ?? true) {
    navigator.vibrate?.([200, 100, 200, 100, 200]);
  }
  if (!context || context.state !== "running") return;
  const start = context.currentTime;
  for (let i = 0; i < TONES; i++) {
    const at = start + i * (TONE_SECONDS + GAP_SECONDS);
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = TONE_HZ;
    // A short ramp in and out, or each tone starts and stops with a click.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(VOLUME, at + 0.02);
    gain.gain.linearRampToValueAtTime(0, at + TONE_SECONDS);
    tone.connect(gain).connect(context.destination);
    tone.start(at);
    tone.stop(at + TONE_SECONDS);
  }
}
