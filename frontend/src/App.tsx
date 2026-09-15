import { Suspense, lazy, useCallback } from "react";
import { NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";

import { api } from "./api";
import { InstallHint } from "./components/InstallHint";
import { PHONE, below } from "./layout";
import CookPage from "./pages/CookPage";
import GroceryPage from "./pages/GroceryPage";
import PantryPage from "./pages/PantryPage";
import PlannerPage from "./pages/PlannerPage";
import RecipeDetailPage from "./pages/RecipeDetailPage";
import RecipeFormPage from "./pages/RecipeFormPage";
import RecipeSearchPage from "./pages/RecipeSearchPage";
import RecipesPage from "./pages/RecipesPage";
import SettingsPage from "./pages/SettingsPage";
import { useLoad } from "./useLoad";
import { useMediaQuery } from "./useMediaQuery";

/**
 * A development tool that still ships, so the system can be checked on the
 * phone it has to look right on rather than only on a laptop. Split into its
 * own chunk, since it costs the cook nothing until someone asks for it, and
 * deliberately absent from the nav: it is a workbench, not a fifth section of
 * the app.
 */
const StyleguidePage = lazy(() => import("./pages/StyleguidePage"));

/**
 * The sections of the app, in the order they are worked through: find a
 * recipe, plan the week, shop for it.
 *
 * The glyph is only ever shown by the phone's tab bar, where a label alone at
 * a fifth of the screen width is both unreadable and untappable. It is marked
 * aria-hidden there, so the label is the accessible name in both layouts and
 * the two cannot describe different things.
 */
const SECTIONS = [
  { to: "/recipes", label: "Recipes", glyph: "📖" },
  { to: "/planner", label: "Planner", glyph: "📅" },
  { to: "/groceries", label: "Groceries", glyph: "🛒" },
  { to: "/pantry", label: "Pantry", glyph: "🫙" },
];

const SETTINGS = { to: "/settings", label: "Settings", glyph: "⚙️" };

function Nav({ className, sections }: { className: string; sections: typeof SECTIONS }) {
  return (
    <nav className={className} aria-label="Sections">
      {sections.map((section) => (
        <NavLink key={section.to} to={section.to}>
          <span className="nav-glyph" aria-hidden>
            {section.glyph}
          </span>
          <span className="nav-label">{section.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The route table.
 *
 * Cook mode stands outside the shell: it is a screen to be used at arm's length
 * with messy hands, and the top bar and tab bar would only be things to hit by
 * mistake - the tab bar sitting exactly where Back and Next want to be.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/recipes/:id/cook" element={<CookPage />} />
      <Route element={<Shell />}>
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
      </Route>
    </Routes>
  );
}

function Shell() {
  // Pricing is opt-in and often absent, so the nav does not advertise it
  // until it is actually configured. A failure here just means no link,
  // which is the same as the far more common case of it being switched off.
  const { data: pricing } = useLoad(useCallback(() => api.pricingStatus(), []));

  /*
   * On a phone the five sections move out of the top bar and into a tab bar
   * along the bottom edge: they measure 387px laid out as a row of pills,
   * which is wider than the screen, and the last of them was simply off it.
   *
   * Rendered in one place or the other rather than styled into position,
   * because the top bar carries a backdrop-filter - and a filtered element is
   * a containing block for anything fixed inside it, so a tab bar that stayed
   * in the header would anchor itself to the header rather than to the
   * bottom of the screen.
   */
  const phone = useMediaQuery(below(PHONE));
  const sections = pricing?.enabled ? [...SECTIONS, SETTINGS] : SECTIONS;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/recipes" className="brand">
            <span className="mark">🍳</span>
            <span className="word">Mise</span>
          </NavLink>
          {!phone && <Nav className="nav" sections={sections} />}
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
      {/* Last in the shell so it comes after the page in reading order: it is
          an aside about the app itself, and nothing on the page depends on it.
          Where it appears on screen is the stylesheet's business. */}
      <InstallHint />
      {phone && <Nav className="tabbar" sections={sections} />}
    </div>
  );
}
