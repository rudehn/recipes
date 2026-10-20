import { describe, expect, it, vi } from "vitest";

import { api, imageUrl, NetworkError } from "./api";
import { recipe } from "./test/fixtures";

/** Capture what the client sends, and answer with `respond`. */
function stubFetch(respond: () => Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function lastInit(fetchMock: ReturnType<typeof stubFetch>): RequestInit {
  return fetchMock.mock.calls.at(-1)![1]!;
}

describe("request", () => {
  it("sends JSON bodies with a JSON content type", async () => {
    const fetchMock = stubFetch(() => jsonResponse(recipe()));

    await api.addPantryItem("olive oil", true);

    const [url] = fetchMock.mock.calls.at(-1)!;
    const init = lastInit(fetchMock);
    expect(url).toBe("/api/pantry");
    expect(init?.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ name: "olive oil", in_stock: true });
  });

  it("leaves the content type off an upload", async () => {
    // Setting it by hand would omit the multipart boundary and the upload
    // would arrive unparseable.
    const fetchMock = stubFetch(() => jsonResponse(recipe()));

    await api.uploadImage(7, new File(["x"], "curry.jpg", { type: "image/jpeg" }));

    const init = lastInit(fetchMock);
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("throws the server's detail message so the page can show it", async () => {
    stubFetch(() =>
      jsonResponse({ detail: "Could not read that page." }, 422, "Unprocessable Content"),
    );

    await expect(api.importRecipe("https://example.com/x")).rejects.toThrow(
      "Could not read that page.",
    );
  });

  it("falls back to the status text when the error has no detail", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 502, statusText: "Bad Gateway" }));

    await expect(api.listRecipes()).rejects.toThrow("Bad Gateway");
  });

  it("ignores a non-string detail rather than showing [object Object]", async () => {
    // FastAPI validation errors put a list here, not a sentence.
    stubFetch(() =>
      jsonResponse(
        { detail: [{ loc: ["body", "title"], msg: "field required" }] },
        422,
        "Unprocessable Content",
      ),
    );

    await expect(api.listRecipes()).rejects.toThrow("Unprocessable Content");
  });

  it("reports a request that never reached the server as a NetworkError", async () => {
    // What a browser throws when the tunnel is not up. Callers retry this and
    // not an HTTP status, so the distinction has to survive `request`.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Load failed"))),
    );

    const failure = await api.listRecipes().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(NetworkError);
    expect((failure as NetworkError).message).toBe("Could not reach the server.");
    expect((failure as NetworkError).cause).toBeInstanceOf(TypeError);
  });

  it("does not mistake an error status for an unreachable server", async () => {
    stubFetch(() => jsonResponse({ detail: "Database is down" }, 500, "Server Error"));

    const failure = await api.listRecipes().catch((e: unknown) => e);

    expect(failure).not.toBeInstanceOf(NetworkError);
    expect((failure as Error).message).toBe("Database is down");
  });

  it("resolves without parsing a body on 204", async () => {
    // Deletes answer 204; calling .json() on an empty body would throw.
    stubFetch(() => new Response(null, { status: 204 }));

    await expect(api.deleteRecipe(7)).resolves.toBeUndefined();
  });

  it("names each tag of a filter as a parameter of its own", async () => {
    // The server reads a repeated `tag` as "carrying all of these"; joined
    // into one value it would be a single tag nobody has.
    const fetchMock = stubFetch(() => jsonResponse({ items: [], total: 0, page: 1, per_page: 24 }));

    await api.listRecipes({ q: "noodles", tags: ["dinner", "chinese"], page: 1 });

    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      "/api/recipes?q=noodles&tag=dinner&tag=chinese&page=1",
    );
  });

  it("sends the local date with Recently cooked, and only with it", async () => {
    // The server may run on UTC, already tomorrow during a US evening, and a
    // plan for tomorrow has not been cooked yet.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 9, 20, 22, 30));
      const fetchMock = stubFetch(() =>
        jsonResponse({ items: [], total: 0, page: 1, per_page: 24 }),
      );

      await api.listRecipes({ sort: "cooked" });
      expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/recipes?sort=cooked&today=2026-10-20");

      await api.listRecipes({ sort: "newest" });
      expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/recipes?sort=newest");
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for tag counts within the same filters as the list", async () => {
    const fetchMock = stubFetch(() => jsonResponse([]));

    await api.listRecipeTags({ q: "noodles", tags: ["dinner", "chinese"] });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      "/api/recipes/tags?q=noodles&tag=dinner&tag=chinese",
    );

    await api.listRecipeTags();
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/recipes/tags");
  });

  it("sends ingredients as repeated params and on sale only when set", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ tags: [], on_sale: null, ingredients: [] }));

    await api.recipeFacets({ ingredients: ["ground-beef", "rice"], onSale: true });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      "/api/recipes/facets?ingredient=ground-beef&ingredient=rice&on_sale=true",
    );

    await api.recipeFacets({ onSale: false });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/recipes/facets");
  });

  it("asks for suggestions with the typed text and the filters", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ingredients: [], tags: [], recipes: [] }));

    await api.suggestRecipes("100% egg", { tags: ["dinner"] });

    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/recipes/suggest?text=100%25+egg&tag=dinner");
  });

  it("records, lists and forgets searches", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));

    await api.recordSearch({ text: "x", tags: ["a"], ingredients: ["rice"], on_sale: true });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/recipes/searches");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "x",
      tags: ["a"],
      ingredients: ["rice"],
      on_sale: true,
    });

    await api.forgetSearch("a|b");
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/recipes/searches?signature=a%7Cb");
    expect(fetchMock.mock.calls.at(-1)![1]?.method).toBe("DELETE");

    fetchMock.mockImplementation(async () => jsonResponse([]));
    await api.recentSearches();
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/recipes/searches?limit=5");
  });

  it("passes the date range as query parameters", async () => {
    const fetchMock = stubFetch(() => jsonResponse([]));

    await api.listMealPlan("2026-07-27", "2026-08-02");

    expect(fetchMock.mock.calls.at(-1)![0]).toBe(
      "/api/meal-plan?start=2026-07-27&end=2026-08-02",
    );
  });
});

describe("imageUrl", () => {
  it("points at the API's image route", () => {
    expect(imageUrl("abc123.jpg")).toBe("/api/images/abc123.jpg");
  });

  it("is null when a recipe has no photo, so callers can fall back", () => {
    expect(imageUrl(null)).toBeNull();
  });
});

// Source labels are no longer derived here: the server sends `source_label`,
// because the allowlist that maps a host to "Budget Bytes" lives there. See
// app/services/recipe_search.py::site_label.
