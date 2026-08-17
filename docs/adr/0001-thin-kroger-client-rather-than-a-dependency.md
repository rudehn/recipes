# 1. A thin Kroger client rather than the published one

Accepted, August 2026.

## Context

Grocery pricing needs three Kroger endpoints: product search, product lookup by id, and store lookup.

There is a maintained Python client, `kroger-api` on PyPI - MIT, released July 2026, and genuinely good.
It wraps every endpoint, handles the OAuth dance, and refreshes tokens.

Writing a client instead of installing one is the sort of decision that looks like pride a year later, so the reasons belong somewhere durable.

## Decision

Write our own, in `backend/app/services/kroger/client.py`, at about 150 lines.

## Why

**It is built on `requests`.**
This backend is async end to end - FastAPI, SQLAlchemy's async session, `httpx` everywhere else.
Every call through a synchronous client blocks the event loop, and pricing fans out across a grocery list, so it would block it repeatedly.
Wrapping each call in a threadpool would work, and would add a moving part to every call site in exchange for nothing.

**It persists tokens to files under the user's home directory.**
That is the right shape for a script on a laptop and the wrong one for a container.
A token cached in memory for the lifetime the API reports needs no disk, no volume, and no thought about what happens when two replicas share a path.

**We need three endpoints.**
The cost of a dependency is not its size, it is that its shape is not ours: its token storage, its error types, its sync-ness.

## What we took anyway

Its source, as documentation.
The developer portal renders entirely in the browser and returns the same shell to every HTTP client, so the request and response shapes cannot be fetched from Kroger at all.
Reading the library was how we learned the parameter names, the `items[0].price` nesting, and the `soldBy` distinction that later turned out to matter a great deal.

That is worth saying plainly: the library earned its keep without being installed.

## Consequences

- Auth, retry and error translation are ours to maintain.
  They are small and covered by tests.
- New endpoints cost a function each rather than nothing.
- A Kroger API change lands on us rather than on an upstream maintainer.
  The three endpoints used here have been stable, and the failure mode is a pricing feature that switches itself off, not an app that breaks.
