/**
 * What a page shows when it could not load its data.
 *
 * Deliberately distinct from the empty states: those say "you have not added
 * anything yet", which is a claim about the user's data and is alarming when
 * it is really the server that is unreachable.
 */
export function LoadError({
  what,
  message,
  onRetry,
}: {
  /** What failed to load, as it reads after "Couldn't load": "your recipes". */
  what: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="empty-state" role="alert">
      <div className="glyph">📡</div>
      <h2>Couldn't load {what}</h2>
      <p>{message}</p>
      <p className="hint">
        Nothing has been lost - the app could not reach the server.
      </p>
      <p>
        <button className="btn primary" onClick={onRetry}>
          Try again
        </button>
      </p>
    </div>
  );
}
