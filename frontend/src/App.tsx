import { Suspense, lazy, useCallback } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";

import { api } from "./api";
import { InstallHint } from "./components/InstallHint";
import GroceryPage from "./pages/GroceryPage";
import PantryPage from "./pages/PantryPage";
import PlannerPage from "./pages/PlannerPage";
import RecipeDetailPage from "./pages/RecipeDetailPage";
import RecipeFormPage from "./pages/RecipeFormPage";
import RecipeSearchPage from "./pages/RecipeSearchPage";
import RecipesPage from "./pages/RecipesPage";
import SettingsPage from "./pages/SettingsPage";
import { useLoad } from "./useLoad";

/**
 * A development tool that still ships, so the system can be checked on the
 * phone it has to look right on rather than only on a laptop. Split into its
 * own chunk, since it costs the cook nothing until someone asks for it, and
 * deliberately absent from the nav: it is a workbench, not a fifth section of
 * the app.
 */
const StyleguidePage = lazy(() => import("./pages/StyleguidePage"));

export default function App() {
  // Pricing is opt-in and often absent, so the nav does not advertise it
  // until it is actually configured. A failure here just means no link,
  // which is the same as the far more common case of it being switched off.
  const { data: pricing } = useLoad(useCallback(() => api.pricingStatus(), []));

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
            {pricing?.enabled && <NavLink to="/settings">Settings</NavLink>}
          </nav>
        </div>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to="/recipes" replace />} />
          <Route path="/recipes" element={<RecipesPage />} />
          <Route path="/recipes/search" element={<RecipeSearchPage />} />
          <Route path="/recipes/new" element={<RecipeFormPage />} />
          <Route path="/recipes/:id" element={<RecipeDetailPage />} />
          <Route path="/recipes/:id/edit" element={<RecipeFormPage />} />
          <Route path="/planner" element={<PlannerPage />} />
          <Route path="/groceries" element={<GroceryPage />} />
          <Route path="/pantry" element={<PantryPage />} />
          {/* Registered whether or not pricing is on, so the page can explain
              itself to anyone who follows a link to it. */}
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="/styleguide"
            element={
              <Suspense fallback={<p className="list-status">Loading…</p>}>
                <StyleguidePage />
              </Suspense>
            }
          />
        </Routes>
      </main>
      {/* Last in the shell so it comes after the page in reading order: it is
          an aside about the app itself, and nothing on the page depends on it.
          Where it appears on screen is the stylesheet's business. */}
      <InstallHint />
    </div>
  );
}
