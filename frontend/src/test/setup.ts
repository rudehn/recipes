import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals, so Testing Library's own auto-cleanup hook
// never registers. Without this, mounted trees pile up across tests and
// queries start matching elements from a previous test.
afterEach(cleanup);

// jsdom implements no object URLs, and the recipe form previews a newly chosen
// photo with one. A fixed string is enough: tests assert that the preview
// points somewhere, never where.
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => {};
}
