from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import IMAGES_DIR
from .db import Base, engine
from .routes import grocery, meal_plan, pantry, recipes


@asynccontextmanager
async def lifespan(app: FastAPI):
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


app = FastAPI(title="Recipes", lifespan=lifespan)

api = FastAPI(title="Recipes API")
api.include_router(recipes.router)
api.include_router(meal_plan.router)
api.include_router(pantry.router)
api.include_router(grocery.router)


@api.get("/health")
async def health():
    return {"status": "ok"}


app.mount("/api/images", StaticFiles(directory=IMAGES_DIR, check_dir=False))
app.mount("/api", api)
