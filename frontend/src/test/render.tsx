/**
 * Rendering helpers for page tests.
 *
 * Every page reads the router - params, search params, or navigation - so they
 * are always mounted inside the real route table from App.tsx rather than in
 * isolation. That way a test navigating to /recipes/new lands on the same
 * component the running app would show, and a page that navigates away can be
 * asserted on by what renders next.
 */

import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";

import App from "../App";

/** A path, or a path carrying router state the way a navigate() call would. */
export type Route = string | { pathname: string; state?: unknown };

export interface AppRender extends RenderResult {
  user: ReturnType<typeof userEvent.setup>;
}

/**
 * user-event pauses between keystrokes by default, which is realistic and, in
 * a form with ten fields, slow enough to time the test out on a loaded CI box.
 * Nothing here depends on typing taking wall-clock time: the one place the app
 * cares is the search debounce, which the tests wait on explicitly.
 */
function setupUser() {
  return userEvent.setup({ delay: null });
}

/**
 * Mount the whole app at `route`, exactly as a browser landing there would.
 * `route` may be an entry object when the page reads router state, as the
 * recipe form does for a draft picked out of search.
 */
export function renderApp(route: Route ="/recipes"): AppRender {
  const user = setupUser();
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  );
  return { ...result, user };
}

/** Mount a single component that needs a router but no particular route. */
export function renderInRouter(ui: ReactElement, route: Route ="/"): AppRender {
  const user = setupUser();
  const result = render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
  return { ...result, user };
}
