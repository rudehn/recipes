import os
import tempfile
from pathlib import Path

import pytest

# Point the app at a throwaway database and data dir before it is imported.
_tmp = tempfile.mkdtemp(prefix="recipes-test-")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmp}/test.db"
os.environ["DATA_DIR"] = _tmp

from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
async def clean_db():
    from app.config import IMAGES_DIR

    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def images_dir() -> Path:
    from app.config import IMAGES_DIR

    return IMAGES_DIR
