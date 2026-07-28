import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import IMAGES_DIR
from .db import engine
from .migrations import run_migrations
from .routes import grocery, import_recipe, meal_plan, pantry, recipes

# Uvicorn only installs handlers on its own loggers, so without this the app's
# own records - including what the migration step did - go nowhere.
logging.basicConfig(
    level=logging.INFO, format="%(levelname)-8s %(name)s: %(message)s"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    await run_migrations()
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
