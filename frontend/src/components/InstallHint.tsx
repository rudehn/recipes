import { useCallback, useEffect, useState } from "react";

import { IconButton } from "./ui";
import {
  canOfferInstall,
  dismissInstallHint,
  installHintDismissed,
} from "../installability";

/**
 * The nudge that turns a link into an app.
 *
 * iOS never offers to install a web app, so this is the offer - see
 * installability.ts for why the page has to make it itself, and for the rules
 * about when there is anything worth offering. Shown once, then never again.
 */

/** Names the region for a screen reader without the headline being read twice. */
const HEADLINE_ID = "install-hint-headline";

/** iOS's share glyph, drawn rather than described, since that is what to look for. */
function ShareGlyph() {
  return (
    <svg
      className="install-hint-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Share"
      role="img"
    >
      <path d="M12 15.5V3" />
      <path d="M8 6.5 12 2.5l4 4" />
      <path d="M7.5 10H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V12a2 2 0 0 0-2-2h-1.5" />
    </svg>
  );
}

export function InstallHint() {
  /*
   * Both reads happen once, in a lazy initialiser. Neither answer can change
   * while this page is open: installing happens in Safari's own UI and launches
   * the app as a new page, so there is no moment where re-checking would tell
   * us something the mount did not.
   */
  const [offerable] = useState(canOfferInstall);
  const [dismissed, setDismissed] = useState(installHintDismissed);
  const showing = offerable && !dismissed;

  /*
   * The card floats over the page, so without this it parks on top of the last
   * recipe in the list - which is where a phone leaves you. The page already
   * ends in a gap, just not a banner's worth of one, and the extra is owed for
   * exactly as long as there is a banner to make room for.
   */
  useEffect(() => {
    if (!showing) return;
    document.body.classList.add("has-install-hint");
    return () => document.body.classList.remove("has-install-hint");
  }, [showing]);

  const dismiss = useCallback(() => {
    dismissInstallHint();
    setDismissed(true);
  }, []);

  if (!showing) return null;

  return (
    <aside className="install-hint" aria-labelledby={HEADLINE_ID}>
      <span className="install-hint-text">
        <strong id={HEADLINE_ID}>Add Mise to your Home Screen</strong>
        {/*
          "In Safari" rather than "below": Safari puts the share button at the
          bottom on an iPhone but at the top on an iPad, and either way the user
          can move it. The glyph says what to look for, which is true everywhere;
          a direction is true on one device held one way.

          The quoted label is the string the user has to find in a menu, so it
          is the one phrase here that must not be split across a line break.
        */}
        <span>
          Tap <ShareGlyph /> in Safari, then{" "}
          <span className="install-hint-label">“Add to Home Screen”.</span>
        </span>
      </span>
      <IconButton label="Dismiss" onClick={dismiss}>
        ✕
      </IconButton>
    </aside>
  );
}
