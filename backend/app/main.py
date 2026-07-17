from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import IMAGES_DIR
from .db import Base, engine
from .routes import grocery, import_recipe, meal_plan, pantry, recipes


def _additive_migrations(sync_conn) -> None:
    """Adds columns create_all can't (it only creates missing tables)."""
    from sqlalchemy import inspect, text

    inspector = inspect(sync_conn)
    columns = {c["name"] for c in inspector.get_columns("meal_plan_entries")}
    if "servings" not in columns:
        sync_conn.execute(text("ALTER TABLE meal_plan_entries ADD COLUMN servings INTEGER"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_additive_migrations)
    yield
    await engine.dispose()


app = FastAPI(title="Recipes", lifespan=lifespan)

api = FastAPI(title="Recipes API")
api.include_router(recipes.router)
api.include_router(meal_plan.router)
api.include_router(pantry.router)
api.include_router(grocery.router)
api.include_router(import_recipe.router)


@api.get("/health")
async def health():
    return {"status": "ok"}


app.mount("/api/images", StaticFiles(directory=IMAGES_DIR, check_dir=False))
app.mount("/api", api)
