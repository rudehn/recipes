import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canOfferInstall,
  dismissInstallHint,
  installHintDismissed,
  isIosSafari,
} from "./installability";
import { USER_AGENTS as UA, pretendToBe, restoreRealAgent } from "./test/agents";

afterEach(restoreRealAgent);

describe("isIosSafari", () => {
  it("recognises Safari on an iPhone", () => {
    expect(isIosSafari(UA.iphoneSafari, 5)).toBe(true);
  });

  it("recognises an iPad, which claims to be a Mac", () => {
    // The user agents are identical; the touch count is the whole difference,
    // and getting this backwards means nagging desktop Safari users forever
    // about a share button that installs nothing.
    expect(isIosSafari(UA.ipadSafari, 5)).toBe(true);
    expect(isIosSafari(UA.macSafari, 0)).toBe(false);
  });

  it("stays quiet in iOS browsers that are not Safari", () => {
    // Both render with Safari's engine, so a naive check for "AppleWebKit" and
    // "iPhone" would send them looking for a control that is somewhere else.
    expect(isIosSafari(UA.iphoneChrome, 5)).toBe(false);
    expect(isIosSafari(UA.iphoneFacebook, 5)).toBe(false);
  });

  it("stays quiet off iOS entirely", () => {
    expect(isIosSafari(UA.androidChrome, 5)).toBe(false);
  });
});

describe("canOfferInstall", () => {
  it("offers on an iPhone in Safari", () => {
    pretendToBe(UA.iphoneSafari);

    expect(canOfferInstall()).toBe(true);
  });

  it("does not offer to an app that is already installed", () => {
    // Pre-16.4 phones have only this signal, and it is the one that stops the
    // standalone app from opening with instructions to install it.
    pretendToBe(UA.iphoneSafari, { installed: true });

    expect(canOfferInstall()).toBe(false);
  });

  it("reads display-mode too, for phones that report it", () => {
    // iOS 16.4 and up answer the standard query. Both paths stay live, because
    // neither covers every phone in a family on its own.
    pretendToBe(UA.iphoneSafari);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(display-mode: standalone)",
    }));

    expect(canOfferInstall()).toBe(false);
  });
});

describe("the dismissal flag", () => {
  it("remembers a dismissal across reloads", () => {
    expect(installHintDismissed()).toBe(false);

    dismissInstallHint();

    expect(installHintDismissed()).toBe(true);
  });

  it("reports not-dismissed when storage cannot be read", () => {
    // Private browsing and Lockdown Mode throw here rather than returning null.
    // Asking again is the harmless way to be wrong; crashing is not.
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(installHintDismissed()).toBe(false);
  });

  it("survives storage that cannot be written", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => dismissInstallHint()).not.toThrow();
  });
});
