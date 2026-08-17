import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, type Store } from "../api";
import { LoadFailure } from "../components/LoadError";
import type { BannerTone } from "../components/ui/Banner";
import { Banner, Button, EmptyState, Field, PageHead, Panel } from "../components/ui";
import { formatWhen } from "../dates";
import { useAction } from "../useAction";
import { errorMessage, useLoad } from "../useLoad";

/**
 * Where the Kroger store is chosen.
 *
 * Choosing one is not really a preference. Kroger returns no price at all
 * without a store, so until this is set there is nothing for the rest of the
 * pricing features to show - which is why the page says so plainly rather
 * than leaving an empty field to be discovered.
 *
 * The search runs on its own state rather than through `useAction`, which is
 * about putting the screen back when a *write* fails. Searching writes
 * nothing and has nothing to undo.
 */
export default function SettingsPage() {
  const {
    data: status,
    error: loadError,
    reload,
  } = useLoad(useCallback(() => api.pricingStatus(), []));
  const [zip, setZip] = useState("");
  const [results, setResults] = useState<Store[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const action = useAction();

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = zip.trim();
    if (!/^\d{5}$/.test(trimmed)) {
      setSearchError("Enter a 5-digit ZIP code.");
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await api.searchStores(trimmed));
    } catch (cause) {
      setSearchError(errorMessage(cause, "Could not look up stores just now."));
    } finally {
      setSearching(false);
    }
  }

  async function choose(store: Store) {
    if (await action.run(() => api.selectStore(store.location_id))) {
      setResults(null);
      setZip("");
      reload();
    }
  }

  async function changeStore() {
    if (await action.run(() => api.clearStore())) {
      setResults(null);
      reload();
    }
  }

  const store = status?.store ?? null;

  return (
    <div className="settings-layout">
      <PageHead title="Settings" />

      {loadError && (
        <LoadFailure
          what="your settings"
          message={loadError}
          onRetry={reload}
          showing={status !== null}
        />
      )}

      {status && !status.enabled && (
        <Panel title="Grocery pricing">
          <EmptyState glyph="🏷️" title="Pricing is switched off">
            <p>
              Prices come from Kroger, which needs an API key. Set{" "}
              <code>KROGER_CLIENT_ID</code> and <code>KROGER_CLIENT_SECRET</code>, then
              restart. Everything else works without one.
            </p>
          </EmptyState>
        </Panel>
      )}

      {status?.enabled && (
        <Panel
          title="Grocery pricing"
          action={
            store ? (
              <Button size="small" onClick={changeStore}>
                Change store
              </Button>
            ) : undefined
          }
        >
          {store ? (
            <div className="store-current">
              <span className="name">{store.name}</span>
              <span className="address">{store.address}</span>
            </div>
          ) : (
            <>
              <p className="page-note">
                Prices are set store by store, so pick the one you shop at. Nothing can
                be priced until you do.
              </p>

              <form className="store-search" onSubmit={search}>
                <Field label="ZIP code" htmlFor="store-zip">
                  <input
                    id="store-zip"
                    inputMode="numeric"
                    placeholder="45431"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                  />
                </Field>
                <Button type="submit" variant="primary" disabled={searching}>
                  {searching ? "Searching…" : "Find stores"}
                </Button>
              </form>

              {searchError && <Banner tone="error">{searchError}</Banner>}

              {results?.length === 0 && (
                <p className="list-status">No stores found near that ZIP code.</p>
              )}

              {results?.map((s) => (
                <div key={s.location_id} className="store-result">
                  <div className="store-detail">
                    <span className="name">{s.name}</span>
                    <span className="address">{s.address}</span>
                  </div>
                  <Button size="small" onClick={() => choose(s)}>
                    Use this store
                  </Button>
                </div>
              ))}
            </>
          )}
        </Panel>
      )}

      {/* Only once pricing is on. Ordering needs everything pricing needs and
          a sign-in on top, so offering it first would be a dead end. */}
      {status?.enabled && <CartPanel />}

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}
    </div>
  );
}

/**
 * What the app says when the browser comes back from Kroger.
 *
 * The outcome arrives as a short code in the URL rather than as a message,
 * because the backend puts it there and the shopper can see it. Turning it
 * into words is this page's job - it is the page that knows what the sign-in
 * was for.
 */
const SIGN_IN_OUTCOME: Record<string, { tone: BannerTone; text: string }> = {
  connected: {
    tone: "notice",
    text: "Your Kroger account is connected. Grocery lists can now be sent to its cart.",
  },
  declined: {
    tone: "notice",
    text: "Nothing was connected, so grocery lists cannot be sent to a Kroger cart yet.",
  },
  stale: {
    tone: "error",
    text: "That sign-in took too long, or it did not start here. Try connecting again.",
  },
  failed: {
    tone: "error",
    text: "Kroger could not finish the sign-in. Try again in a moment.",
  },
  unconfigured: {
    tone: "error",
    text: "Adding to a Kroger cart is not set up on this server.",
  },
};

/**
 * Connecting a Kroger account, so the grocery list can be ordered.
 *
 * A second, separate permission from the API key that prices the list, and
 * the page says so: reading the catalog is the app's own business, while a
 * cart belongs to a person and needs them to sign in and say yes.
 *
 * The disconnect wording is careful on purpose. It ends the connection here,
 * and Kroger keeps its own record of what the account has authorised, which
 * only the account holder can revoke. Implying otherwise would be the more
 * comfortable lie.
 */
/**
 * The callback address, laid out to be compared character by character.
 *
 * Kroger matches it exactly, and the differences that break it are the ones
 * that are hardest to see in running prose: a trailing slash, http for https,
 * a hostname that is nearly right. So it gets its own line, in monospace, with
 * nothing wrapped around it that could be mistaken for part of the string.
 */
function CallbackAddress({ uri, lede }: { uri: string; lede?: string }) {
  if (!uri) return null;
  return (
    <div className="callback-address">
      {lede && <p className="section-note">{lede}</p>}
      <code>{uri}</code>
    </div>
  );
}

function CartPanel() {
  const [params, setParams] = useSearchParams();
  const { data: cart, reload } = useLoad(useCallback(() => api.cartStatus(), []));
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const action = useAction();

  const outcome = SIGN_IN_OUTCOME[params.get("kroger") ?? ""];

  function dismiss() {
    const next = new URLSearchParams(params);
    next.delete("kroger");
    setParams(next, { replace: true });
  }

  /**
   * Hand the browser over to Kroger.
   *
   * A full navigation rather than a popup or a frame: this asks for someone's
   * real store account password, and it belongs on Kroger's own origin, in an
   * address bar where it can be checked.
   *
   * `connecting` is never cleared on the way out. The page is leaving, and
   * putting the button back would make the last thing on screen before the
   * navigation look like nothing happened.
   */
  async function connect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const { url } = await api.cartSignInUrl();
      window.location.assign(url);
    } catch (cause) {
      setConnectError(errorMessage(cause, "Could not start the Kroger sign-in."));
      setConnecting(false);
    }
  }

  async function disconnect() {
    if (await action.run(() => api.disconnectCart())) {
      dismiss();
      reload();
    }
  }

  if (!cart) return null;

  return (
    <Panel
      title="Kroger cart"
      action={
        cart.connected ? (
          <Button size="small" onClick={disconnect}>
            Disconnect
          </Button>
        ) : undefined
      }
    >
      {outcome && (
        <Banner tone={outcome.tone} spaced role="status">
          <span>{outcome.text}</span>
          <Button size="small" onClick={dismiss}>
            Dismiss
          </Button>
        </Banner>
      )}

      {(action.error || connectError) && (
        <Banner tone="error">{action.error ?? connectError}</Banner>
      )}

      {!cart.configured && (
        <EmptyState glyph="🛒" title="Sending to a cart is switched off">
          <p>
            Prices work, but ordering needs one more setting. Set{" "}
            <code>KROGER_REDIRECT_URI</code> to this app&rsquo;s callback address, and
            register the same address on your Kroger app, then restart.
          </p>
          {/* Guessed from the address bar here, because the server has no
              value to report - that is what "not configured" means. */}
          <CallbackAddress uri={`${window.location.origin}/api/cart/callback`} />
        </EmptyState>
      )}

      {cart.configured && !cart.connected && (
        <>
          <p className="page-note">
            Prices are read with this server&rsquo;s own API key. A cart belongs to a
            person, so ordering needs you to sign in to Kroger once and allow it. You
            will be taken to Kroger, and back here afterwards.
          </p>
          <Button variant="primary" onClick={connect} disabled={connecting}>
            {connecting ? "Taking you to Kroger…" : "Connect Kroger account"}
          </Button>
          {/* The one thing that goes wrong before the sign-in even starts.
              Kroger compares this against the app's registered redirect URI
              and refuses on its own page, so the browser never comes back and
              nothing here can detect it - the address can only be put where
              it is easy to check against. */}
          <CallbackAddress
            uri={cart.redirect_uri}
            lede="Kroger refuses the sign-in on its own error page unless your Kroger app has this exact address registered as a redirect URI:"
          />
        </>
      )}

      {cart.connected && (
        <div className="cart-connection">
          <p className="connected">
            Connected
            {cart.connected_at && ` since ${formatWhen(new Date(cart.connected_at))}`}.
          </p>
          {cart.last_sent_at && (
            <p className="page-note">
              A list was last sent {formatWhen(new Date(cart.last_sent_at))}.
            </p>
          )}
          <p className="page-note">
            Disconnecting stops this app from adding anything. Kroger keeps its own
            record of what you allowed, which you can withdraw from your Kroger
            account.
          </p>
        </div>
      )}
    </Panel>
  );
}
