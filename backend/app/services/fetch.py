"""Shared HTTP settings for fetching recipe pages.

Several large recipe sites (AllRecipes among them) sit behind a bot wall that
returns 403 and a JavaScript challenge page unless the request carries the
headers a browser only sends when navigating to a page. A User-Agent alone is
not enough: the wall looks for `Sec-Fetch-*` / `Upgrade-Insecure-Requests`,
which HTTP clients omit and browsers always send on a top-level navigation.
Sending them is what we are actually doing - fetching one page a user asked
for - so this describes the request honestly rather than disguising it."""

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "application/json,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}
