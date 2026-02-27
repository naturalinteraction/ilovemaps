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

## Cesium Ion Token

The user has a token set and working.