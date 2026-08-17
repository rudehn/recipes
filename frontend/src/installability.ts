/**
 * What the browser can be told about installing this app.
 *
 * Everything in index.html and the web manifest already makes the app
 * installable on iOS - own icon, own name, no Safari chrome - but Safari
 * implements no `beforeinstallprompt`, so it never offers. The feature is
 * reachable only through a share sheet nobody opens by accident, which means an
 * app that does not mention it is an app nobody installs.
 *
 * So the page has to ask, and this module is what it asks. It is deliberately
 * narrow: a hint you cannot act on is worse than none, so the answer is yes
 * only where the instructions the banner gives are literally true.
 */

/**
 * Browsers on iOS that are not Safari.
 *
 * Every one of these renders with Safari's engine but wraps it in its own
 * furniture, so "tap the share button" points at a control that is somewhere
 * else or, in the in-app webviews, absent. Chrome and friends can install a web
 * app since iOS 16.4; they just do not do it from the same place, and a wrong
 * instruction costs more than a missing one.
 */
const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram|Line\//;

/**
 * `maxTouchPoints` is not a redundant second signal. Since iPadOS 13 an iPad
 * claims to be a Macintosh, and a touch count is the only thing separating it
 * from the desktop Safari it is imitating - where this would be talking about a
 * share button that installs nothing.
 */
export function isIosSafari(ua: string, maxTouchPoints: number): boolean {
  const ios =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  return ios && !NOT_SAFARI.test(ua);
}

/**
 * Whether the page is already running as the installed app.
 *
 * Two answers to one question because the standard one is recent: home-screen
 * web apps only started reporting `display-mode: standalone` in iOS 16.4, and
 * `navigator.standalone` is what every iPhone older than that has. Reading only
 * the standard query would leave those phones being told to install an app they
 * are already inside.
 */
export function isInstalled(): boolean {
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  return (
    legacy === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

/** Whether there is anything worth saying to whoever is looking at this page. */
export function canOfferInstall(): boolean {
  return (
    isIosSafari(navigator.userAgent, navigator.maxTouchPoints) && !isInstalled()
  );
}

const DISMISSED_KEY = "mise:install-hint-dismissed";

/*
 * Safari throws on storage access rather than returning null - private
 * browsing, Lockdown Mode, cookies blocked - and it throws on the read as
 * readily as on the write. Neither is worth taking the app down for, so a
 * storage failure degrades to the honest default: the hint behaves as though it
 * has not been dismissed, and asks again next launch.
 */
export function installHintDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    return false;
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Dismissing still works for this visit; only the memory of it is lost.
  }
}
