import { useEffect, useState } from "react";

/**
 * `value` once it has held still for `delayMs`.
 *
 * Search moved to the server, so an undebounced input would fire a request per
 * keystroke - most of them for a prefix the user was still in the middle of
 * typing.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
