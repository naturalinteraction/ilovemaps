# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Start Vite dev server (http://localhost:5173)
- `npm run build` — Production build to `dist/`
- `npm run preview` — Preview production build

No tests or linter configured.

## Architecture

CesiumJS 3D globe app built with Vite. `vite-plugin-cesium` handles Cesium static assets (workers, imagery, widgets).

- `src/main.js` — Entry point. Creates `Cesium.Viewer`, loads waypoints from JSON, adds point entities with labels, and a polyline connecting them. Calls `viewer.zoomTo()` to frame all entities.
- `src/clustering.js` has clustering, merge/unmerge, decluttering, military units rendering and units' text labels. Commanders, staff, platoons, individuals, etcetera are here.

## Session History

### 2026-02-28: Label Decluttering & Multitouch

**Goal:** Improve label decluttering in Cesium military unit visualization, enable multitouch tilt controls.

**Completed:**
- Added UI sliders for declutter parameters (Cell Width 4-40, Cell Height 4-40, Hysteresis 0-0.49)
- Default values: Cell W/H = 8, Hysteresis = 0.4
- Added debug mode (press D) showing green outlines for showing labels, red for blocked
- Fixed declutter bugs: vertical position, horizontal centering, hysteresis scaling from center
- Added multitouch tilt controls via `enableTilt`, `enableLook`, `touch-action: none`
- Commits: `93334de`, `f6ce206`

**Key files:** `src/clustering.js`, `src/main.js`

## Cesium Ion Token

The user has a token set and working.