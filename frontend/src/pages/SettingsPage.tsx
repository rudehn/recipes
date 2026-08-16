import { useCallback, useState } from "react";

import { api, type Store } from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, Field, PageHead, Panel } from "../components/ui";
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

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}
    </div>
  );
}
