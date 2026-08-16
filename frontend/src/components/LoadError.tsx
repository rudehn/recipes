import { Banner, Button, EmptyState } from "./ui";

/**
 * What a page shows when it could not load its data.
 *
 * Two shapes, because what is worth saying depends on whether the user is left
 * with anything.
 *
 * With nothing on screen this takes the page. It is deliberately distinct from
 * the empty states: those say "you have not added anything yet", which is the
 * one claim a self-hosted app must never make by accident when the truth is
 * that it could not reach the server.
 *
 * With data already showing - a refresh that failed, which on a phone away
 * from home is the usual way this goes - that data is worth more than the news
 * that it might be a few minutes old. The page keeps it and reports the
 * failure beside it, rather than replacing something useful with something
 * that is not.
 */
export function LoadFailure({
  what,
  message,
  onRetry,
  showing,
}: {
  /** What failed to load, as it reads after "Couldn't load": "your recipes". */
  what: string;
  message: string;
  onRetry: () => void;
  /** Whether the page still has data on screen from an earlier load. */
  showing: boolean;
}) {
  if (showing) {
    return (
      <Banner tone="notice" spaced role="status">
        <span>Showing the last version that loaded. {message}</span>
        <Button size="small" onClick={onRetry}>
          Try again
        </Button>
      </Banner>
    );
  }

  return (
    <EmptyState glyph="📡" title={`Couldn't load ${what}`} role="alert">
      <p>{message}</p>
      <p className="hint">
        Nothing has been lost - the app could not reach the server.
      </p>
      <p>
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      </p>
    </EmptyState>
  );
}
