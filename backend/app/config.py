import os
from pathlib import Path

# Async SQLAlchemy URL. SQLite for local dev, Postgres (asyncpg) in production.
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "sqlite+aiosqlite:///./data/recipes.db"
)

# Where uploaded recipe images live. Mounted as a volume in production.
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
IMAGES_DIR = DATA_DIR / "images"

# Kroger Public API credentials, for the pricing features. Unset by default:
# everything else in this app works without an account, and it has to keep
# working that way, so the pricing code treats "no credentials" as a normal
# state rather than a misconfiguration.
#
# Read these as `config.KROGER_CLIENT_ID` rather than importing them by value.
# They are the only settings whose absence is a supported runtime state, so
# tests need to switch them on and off, which a by-value import prevents.
KROGER_CLIENT_ID = os.environ.get("KROGER_CLIENT_ID", "")
KROGER_CLIENT_SECRET = os.environ.get("KROGER_CLIENT_SECRET", "")

# Where Kroger sends the browser back to after someone signs in to grant this
# app access to their cart. Separate from the credentials above because it is
# a separate capability: pricing reads the catalog on the app's own token,
# while writing to a cart is done on a real shopper's, and only the second
# needs a redirect.
#
# It must match a redirect URI registered on the Kroger app exactly, so it
# cannot be derived from the incoming request - a reverse proxy would give a
# different host than the one registered. Left empty, adding to a cart
# switches itself off the way pricing does without credentials.
#
# The path is this app's callback route: e.g.
# https://recipes.your-tailnet.ts.net/api/cart/callback
KROGER_REDIRECT_URI = os.environ.get("KROGER_REDIRECT_URI", "")

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
