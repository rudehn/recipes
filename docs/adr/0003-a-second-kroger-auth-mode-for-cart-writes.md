# 3. A second Kroger auth mode, for cart writes

Accepted, August 2026.

## Context

Everything the app read from Kroger until now - products, prices, stores - runs on the client credentials grant.
The app mints its own token, needs no browser, no user, and no redirect, and caches it in memory for the half hour Kroger reports.
That worked because reading a public catalog is the app's own business.

Adding a grocery list to a cart is not.
A cart belongs to a person, and Kroger will only write to one on a token that person granted, through the authorization code grant: a browser round trip, a real Kroger sign-in, a redirect URI registered on the developer app, and a refresh token that lasts months rather than minutes.

`docs/kroger-pricing-plan.md` set this aside twice, first as a later stage and then as out of scope, precisely because it is a second auth mode with its own storage and its own failure modes.
Building it means accepting all three.

## Decision

Keep the two grants distinct at every level rather than generalising over them.

- `services/kroger/client.py` mints and spends both, but caches only the app's own token.
- `services/kroger/cart.py` owns the shopper's token: its lifecycle, its storage, and its expiry.
- The refresh token lives in `app_settings`, beside the chosen store.
- `cart.basic:write` is requested on its own, never bundled with `product.compact`.
- Being connected is reported separately from pricing being configured, through `/api/cart/status`.

## Why

**The two tokens have nothing in common but their endpoint.**
One is minted on demand, is disposable, and is the same for everybody.
The other is granted once by a person, survives restarts, must be written to disk, and is rotated by Kroger on every use.
A single "get me a token" abstraction over both would have to know about the database to serve the second, which is exactly what keeps `client.py` free of it today.

**A cart write cannot recover from a 401 the way a read can.**
`client.get` renews and retries by itself, because it can: it holds everything needed to mint a new app token.
Renewing a shopper's token means reading a refresh token out of the database, so the 401 is raised and `cart.send` handles it - one renewal, one retry, and a disconnect if the second attempt is refused too.

**The scope is asked for alone because a consent screen is a promise.**
The catalog is already readable on the app's own key.
Listing `product.compact` on the screen where someone grants cart access would overstate what is being handed over, in the one place where the wording is not ours to soften afterwards.

**Being configured and being connected are different states with different remedies.**
Pricing has two states, off and on. This has three: not set up on this server, set up but nobody has signed in, and connected.
Only the middle one is fixed by a button, and collapsing it into either neighbour produces a screen that is either a dead end or a lie.

## The refresh token is stored as issued

It is a credential, and the only one the app holds rather than reads from the environment - it cannot live in `config.py`, because it is granted at runtime by a person clicking through a sign-in.

It is not encrypted.
This is a single-tenant app on a private host, and a key kept on the same host as the database would move the secret rather than protect it.
What that buys, honestly stated: a leaked backup is a leaked cart.
So the app forgets the token on request, forgets it by itself the moment Kroger refuses it, and the settings page says plainly that Kroger keeps its own record of the grant, which only the account holder can withdraw.

## Consequences

- `KROGER_REDIRECT_URI` is a third setting, and it has to match a redirect URI registered on the Kroger developer app exactly.
  It cannot be derived from the incoming request: a reverse proxy would offer a host Kroger has never seen.
- The callback is the one place this app acts on an instruction from outside, so the `state` is signed with the client secret and time-bounded rather than merely present.
- The Cart API is write-only.
  Nothing can be read back and nothing removed, so the app shows what it is about to send, records when it last sent, and never claims to know what is in the cart.
  See ADR 4.
- The app's own token path is unchanged.
  Someone with credentials and no redirect URI has exactly the app they had before.
