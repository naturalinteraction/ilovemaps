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
- `data/waypoints.json` — Array of `{name, lat, lon, alt}` objects served as static data via Vite's public-like fetch.
- `index.html` — Fullscreen `#cesiumContainer` div, loads `src/main.js` as ES module.

## Cesium Ion Token

`Cesium.Ion.defaultAccessToken` in `src/main.js` is commented out. The globe works without a token (no 3D terrain). Set a token from cesium.com/ion to enable terrain and premium imagery.
