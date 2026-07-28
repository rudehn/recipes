/**
 * A stand-in backend for component tests.
 *
 * Pages talk to the server through `api.ts`, so stubbing `fetch` rather than
 * mocking the `api` module keeps request shapes honest: a test that expects a
 * PATCH to /api/meal-plan/3 fails if the page sends something else, and the
 * error handling in `request` runs for real.
 */

import { vi } from "vitest";

export interface MockRequest {
  method: string;
  /** Path without the query string, e.g. "/api/recipes/7". */
  path: string;
  /** Path parameters captured by a ":name" segment in the route pattern. */
  params: Record<string, string>;
  searchParams: URLSearchParams;
  /** Parsed JSON body, the FormData itself for uploads, or null. */
  body: unknown;
}

export type RouteHandler = (req: MockRequest) => unknown;

/** Reply with an error status instead of a body; `detail` is what the UI shows. */
export class HttpError {
  constructor(
    readonly status: number,
    readonly detail?: string,
  ) {}
}

/**
 * Route patterns are "METHOD /path", where any segment may be a ":name"
 * placeholder: "PATCH /api/meal-plan/:id". A handler's return value becomes the
 * JSON body; returning undefined answers 204, and returning an HttpError fails
 * the request. A route may also be a plain value when the response is fixed.
 */
export type Routes = Record<string, RouteHandler | unknown>;

interface MatchedRoute {
  route: RouteHandler | unknown;
  params: Record<string, string>;
}

function matchRoute(routes: Routes, method: string, path: string): MatchedRoute | null {
  const segments = path.split("/");
  for (const [pattern, route] of Object.entries(routes)) {
    const [patternMethod, patternPath] = pattern.split(" ");
    if (patternMethod !== method) continue;

    const patternSegments = patternPath.split("/");
    if (patternSegments.length !== segments.length) continue;

    const params: Record<string, string> = {};
    const matches = patternSegments.every((patternSegment, i) => {
      if (patternSegment.startsWith(":")) {
        params[patternSegment.slice(1)] = segments[i];
        return true;
      }
      return patternSegment === segments[i];
    });
    if (matches) return { route, params };
  }
  return null;
}

async function parseBody(init: RequestInit | undefined): Promise<unknown> {
  if (!init?.body) return null;
  if (init.body instanceof FormData) return init.body;
  return JSON.parse(String(init.body));
}

export interface MockBackend {
  /** Every request the page made, oldest first. */
  requests: MockRequest[];
  /** Requests matching a "METHOD /path" pattern, for asserting on one call. */
  requestsTo(pattern: string): MockRequest[];
}

/**
 * Install `routes` as the global fetch for the current test. Requests to a path
 * with no route fail loudly, so a page quietly calling an endpoint the test did
 * not anticipate shows up as a failure rather than an empty screen.
 */
export function mockBackend(routes: Routes): MockBackend {
  const requests: MockRequest[] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(String(input), "http://localhost");
    const matched = matchRoute(routes, method, url.pathname);
    if (!matched) {
      // Answered rather than thrown: a rejected fetch means "never reached the
      // server", which `useLoad` retries and reports in the app's own wording,
      // burying the mistake. A status carries the diagnostic to the screen.
      return new Response(
        JSON.stringify({ detail: `No mock route for ${method} ${url.pathname}` }),
        { status: 501, statusText: "Not Implemented" },
      );
    }

    const request: MockRequest = {
      method,
      path: url.pathname,
      params: matched.params,
      searchParams: url.searchParams,
      body: await parseBody(init),
    };
    requests.push(request);

    // Awaited so a handler can return a pending promise, letting a test hold a
    // request open and assert on the loading state the page shows meanwhile.
    const result = await (typeof matched.route === "function"
      ? (matched.route as RouteHandler)(request)
      : matched.route);

    if (result instanceof Response) return result;
    if (result instanceof HttpError) {
      return new Response(result.detail ? JSON.stringify({ detail: result.detail }) : "", {
        status: result.status,
        statusText: "Server Error",
      });
    }
    if (result === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  return {
    requests,
    requestsTo(pattern: string) {
      const method = pattern.split(" ")[0];
      return requests.filter(
        (r) => r.method === method && matchRoute({ [pattern]: null }, method, r.path) !== null,
      );
    },
  };
}
