/**
 * Standing in for a phone.
 *
 * Real user-agent strings, because that is the only kind that proves anything
 * about code that reads them: an approximation written from the same guess as
 * the regex would agree with it and catch nothing. Two of these are identical
 * on purpose - see IPAD.
 */

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";

export const USER_AGENTS = {
  iphoneSafari: `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`,
  iphoneChrome: `${IOS} CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1`,
  iphoneFacebook: `${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/468.0.0.47.108]`,

  /**
   * An iPad and a Mac send the same string: since iPadOS 13 an iPad claims to
   * be a Macintosh, and only the touch count tells them apart. Two names for
   * one value, because the pair is the point of the test that uses them.
   */
  ipadSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",

  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
} as const;

const define = (key: string, value: unknown) =>
  Object.defineProperty(navigator, key, { value, configurable: true });

const REAL_AGENT = navigator.userAgent;
const REAL_TOUCH_POINTS = navigator.maxTouchPoints;

/**
 * jsdom's navigator is not writable, but its properties are configurable, so
 * they can be redefined in place. Replacing the whole object instead would take
 * the parts Testing Library and user-event read with it.
 *
 * `installed` is iOS Safari's `navigator.standalone`: true when the page was
 * launched from the home screen rather than opened in the browser.
 */
export function pretendToBe(
  ua: string,
  { touch = 5, installed = false } = {},
): void {
  define("userAgent", ua);
  define("maxTouchPoints", touch);
  define("standalone", installed);
}

/** Pair with `afterEach` in any file that calls `pretendToBe`. */
export function restoreRealAgent(): void {
  define("userAgent", REAL_AGENT);
  define("maxTouchPoints", REAL_TOUCH_POINTS);
  define("standalone", undefined);
}
