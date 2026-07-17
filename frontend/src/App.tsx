import { NavLink, Navigate, Route, Routes } from "react-router-dom";

import GroceryPage from "./pages/GroceryPage";
import PantryPage from "./pages/PantryPage";
import PlannerPage from "./pages/PlannerPage";
import RecipeDetailPage from "./pages/RecipeDetailPage";
import RecipeFormPage from "./pages/RecipeFormPage";
import RecipesPage from "./pages/RecipesPage";

export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/recipes" className="brand">
            <span className="mark">🍳</span>
            <span className="word">Mise</span>
          </NavLink>
          <nav className="nav">
            <NavLink to="/recipes">Recipes</NavLink>
            <NavLink to="/planner">Planner</NavLink>
            <NavLink to="/groceries">Groceries</NavLink>
            <NavLink to="/pantry">Pantry</NavLink>
          </nav>
        </div>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/recipes" replace />} />
          <Route path="/recipes" element={<RecipesPage />} />
          <Route path="/recipes/new" element={<RecipeFormPage />} />
          <Route path="/recipes/:id" element={<RecipeDetailPage />} />
          <Route path="/recipes/:id/edit" element={<RecipeFormPage />} />
          <Route path="/planner" element={<PlannerPage />} />
          <Route path="/groceries" element={<GroceryPage />} />
          <Route path="/pantry" element={<PantryPage />} />
        </Routes>
      </main>
    </div>
  );
}
