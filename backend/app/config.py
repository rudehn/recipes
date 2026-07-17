import os
from pathlib import Path

# Async SQLAlchemy URL. SQLite for local dev, Postgres (asyncpg) in production.
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "sqlite+aiosqlite:///./data/recipes.db"
)

# Where uploaded recipe images live. Mounted as a volume in production.
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
IMAGES_DIR = DATA_DIR / "images"

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
