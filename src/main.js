import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { loadMilitaryUnits, setupZoomListener, setupPreRender, handleClick, handleKeydown } from "./clustering.js";

// Token Cesium Ion (registrarsi su cesium.com/ion per ottenerne uno)
// Il globo funziona anche senza token, ma senza terrain 3D
// Per vedere il terrain 3D occorre anche selezionare Cesium 3D Terrain nell'interfaccia grafica
Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI4NjI4NDI4Mi1jM2I2LTRiYzgtOTcwMy1mYWY1OTFjYmZiMzEiLCJpZCI6Mzg5OTAwLCJpYXQiOjE3NzA4ODE0ODd9.mPlDG2N5Kct-2CMb5olZ4eZeI5kzJOq3UNOOKPlCI-Y";

const viewer = new Cesium.Viewer("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain({
    requestWaterMask: true,
  }),
});

const waypointEntities = [];
const waypointRouteInfo = new Map(); // entity -> { route: [{lat,lon,alt}...], wpIdx: number }

async function loadWaypoints() {
  // Remove previously loaded waypoint entities
  for (const e of waypointEntities) {
    viewer.entities.remove(e);
  }
  waypointEntities.length = 0;
  waypointRouteInfo.clear();

  const response = await fetch("/data/waypoints.json");
  const routes = await response.json();

  for (const waypoints of routes) {
    const positions = [];

    for (let wi = 0; wi < waypoints.length; wi++) {
      const wp = waypoints[wi];
      const position = Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt + 50);
      positions.push(position);

      const entity = viewer.entities.add({
        name: wp.name,
        position,
        point: {
          pixelSize: 10,
          color: Cesium.Color.BLACK,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
        label: {
          text: wp.name,
          font: "18px sans-serif",
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -15),
        },
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            wp.lon, wp.lat, wp.alt + 50,
            wp.lon, wp.lat, wp.alt - 500
          ]),
          width: 1,
          material: Cesium.Color.WHITE,
        },
      });
      waypointEntities.push(entity);
      waypointRouteInfo.set(entity, { route: waypoints, wpIdx: wi });
    }

    waypointEntities.push(viewer.entities.add({
      polyline: {
        positions,
        width: 3,
        material: Cesium.Color.WHITE,
        clampToGround: true,
      },
    }));
  }

  currentRouteLetter = routes.length < 26 ? String.fromCharCode(65 + routes.length) : "?";
}

loadWaypoints();

async function loadCameraView() {
  try {
    const response = await fetch("/data/camera.json");
    if (!response.ok) return;
    const cameraData = await response.json();
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        cameraData.lon,
        cameraData.lat,
        cameraData.height
      ),
      orientation: {
        heading: Cesium.Math.toRadians(cameraData.heading),
        pitch: Cesium.Math.toRadians(cameraData.pitch),
        roll: Cesium.Math.toRadians(cameraData.roll),
      },
    });
  } catch (e) {
    // camera.json not found, use default view
  }
}

loadCameraView();

// Military unit clustering
loadMilitaryUnits(viewer);
setupZoomListener(viewer);
setupPreRender(viewer);

let currentRouteLetter = "?";
let inspectedEntity = null; // black pin with temporarily changed label
let inspectedOriginalLabel = null;

const clickedGroundPositions = [];
const clickedEntities = [];
const clickedWaypointData = [];
let pathEntity = null;

const clickedPathEntity = viewer.entities.add({
  polyline: {
    positions: new Cesium.CallbackProperty(() => clickedGroundPositions, false),
    width: 3,
    material: Cesium.Color.WHITE,
    clampToGround: true,
  },
});

function computeRouteStats(waypoints, upToIndex) {
  let totalDist = 0, dPlus = 0, dMinus = 0;
  for (let i = 1; i <= upToIndex; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    totalDist += Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.alt),
      Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.alt),
    );
    const dh = b.alt - a.alt;
    if (dh > 0) dPlus += dh; else dMinus += dh;
  }
  return { totalDist, dPlus, dMinus };
}

function formatLabel(name, totalDist, dPlus, dMinus) {
  return `${name} (${Math.round(totalDist)}m +${Math.round(dPlus)} -${Math.round(Math.abs(dMinus))})`;
}

const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click) => {
  // Check military unit click first
  if (handleClick(viewer, click)) return;

  // Restore previously inspected black pin label
  if (inspectedEntity) {
    inspectedEntity.label.text = inspectedOriginalLabel;
    inspectedEntity = null;
    inspectedOriginalLabel = null;
  }

  const cartesian = viewer.scene.pickPosition(click.position);
  if (!cartesian) return;

  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  console.log(`lat: ${lat.toFixed(6)}, lon: ${lon.toFixed(6)}, height: ${carto.height.toFixed(6)}`);

  // Check if an existing waypoint entity was picked
  const picked = viewer.scene.pick(click.position);
  const pickedEntity = picked?.id instanceof Cesium.Entity && waypointRouteInfo.has(picked.id)
    ? picked.id : null;

  if (pickedEntity) {
    // Show route stats on the black pin's own route, don't add to red route
    const { route, wpIdx } = waypointRouteInfo.get(pickedEntity);
    const origLabel = pickedEntity.label.text.getValue();
    if (wpIdx === 0) {
      pickedEntity.label.text = origLabel;
    } else {
      const { totalDist, dPlus, dMinus } = computeRouteStats(route, wpIdx);
      pickedEntity.label.text = formatLabel(origLabel, totalDist, dPlus, dMinus);
    }
    inspectedEntity = pickedEntity;
    inspectedOriginalLabel = origLabel;
    return;
  }

  // Add new red point to current route
  clickedGroundPositions.push(Cesium.Cartesian3.fromDegrees(lon, lat));

  const allPts = [...clickedWaypointData, { lat, lon, alt: carto.height }];
  const { totalDist, dPlus, dMinus } = computeRouteStats(allPts, allPts.length - 1);
  const wpNum = clickedWaypointData.length + 1;
  const labelText = wpNum === 1
    ? `${currentRouteLetter}${wpNum}`
    : formatLabel(`${currentRouteLetter}${wpNum}`, totalDist, dPlus, dMinus);

  const elevatedPosition = Cesium.Cartesian3.fromDegrees(lon, lat, carto.height + 50);
  const entity = viewer.entities.add({
    position: elevatedPosition,
    point: {
      pixelSize: 10,
      color: Cesium.Color.RED,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
    },
    label: {
      text: labelText,
      font: "18px sans-serif",
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 2,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -15),
    },
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArrayHeights([
        lon, lat, carto.height + 50,
        lon, lat, carto.height - 500,
      ]),
      width: 1,
      material: Cesium.Color.WHITE,
    },
  });
  clickedEntities.push(entity);
  clickedWaypointData.push({ lat, lon, alt: carto.height });
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// Color picker tooltip
const colorTooltip = document.createElement("div");
colorTooltip.style.cssText = "position:absolute;display:none;padding:6px 10px;background:rgba(0,0,0,0.8);color:#fff;font:14px monospace;border-radius:4px;pointer-events:none;z-index:9999;white-space:nowrap";
document.body.appendChild(colorTooltip);

// Debug tile preview in bottom-left corner
const tilePreview = document.createElement("canvas");
tilePreview.style.cssText = "position:absolute;bottom:10px;left:10px;width:200px;height:200px;border:2px solid #fff;z-index:9999;pointer-events:none;image-rendering:pixelated;display:none";
document.body.appendChild(tilePreview);
const tilePreviewCtx = tilePreview.getContext("2d");

let colorPickerCache = { level: -1, tileX: -1, tileY: -1, ctx: null, rect: null };
let colorPickerPending = false;

handler.setInputAction(async (movement) => {
  if (colorPickerPending) return;
  const ray = viewer.camera.getPickRay(movement.endPosition);
  const cartesian = ray && viewer.scene.globe.pick(ray, viewer.scene);
  if (!cartesian) { colorTooltip.style.display = "none"; tilePreview.style.display = "none"; return; }
  const carto = Cesium.Cartographic.fromCartesian(cartesian);

  const layer = viewer.imageryLayers.get(0);
  const provider = layer.imageryProvider;
  const tilingScheme = provider.tilingScheme;
  const maxLevel = provider.maximumLevel || 18;

  const camHeight = viewer.camera.positionCartographic.height;
  const level = Math.max(0, Math.min(maxLevel, Math.round(Math.log2(40075016 / (camHeight * 2)))));

  const tileXY = tilingScheme.positionToTileXY(carto, level);
  if (!tileXY) { colorTooltip.style.display = "none"; return; }

  // Reuse cached tile if same tile
  let ctx = colorPickerCache.ctx;
  let tileRect = colorPickerCache.rect;
  if (level !== colorPickerCache.level || tileXY.x !== colorPickerCache.tileX || tileXY.y !== colorPickerCache.tileY) {
    colorPickerPending = true;
    const image = await provider.requestImage(tileXY.x, tileXY.y, level);
    colorPickerPending = false;
    if (!image) { colorTooltip.style.display = "none"; return; }
    const offscreen = document.createElement("canvas");
    offscreen.width = image.width;
    offscreen.height = image.height;
    ctx = offscreen.getContext("2d");
    ctx.drawImage(image, 0, 0);
    tileRect = tilingScheme.tileXYToRectangle(tileXY.x, tileXY.y, level);
    colorPickerCache = { level, tileX: tileXY.x, tileY: tileXY.y, ctx, rect: tileRect };
  }

  const u = (carto.longitude - tileRect.west) / (tileRect.east - tileRect.west);
  let v;
  if (tilingScheme instanceof Cesium.WebMercatorTilingScheme) {
    const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat / 2));
    v = (mercY(carto.latitude) - mercY(tileRect.south)) / (mercY(tileRect.north) - mercY(tileRect.south));
  } else {
    v = (carto.latitude - tileRect.south) / (tileRect.north - tileRect.south);
  }
  const px = Math.min(Math.max(0, Math.floor(u * ctx.canvas.width)), ctx.canvas.width - 1);
  const py = Math.min(Math.max(0, Math.floor(v * ctx.canvas.height)), ctx.canvas.height - 1);
  const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;

  // Draw tile preview with crosshair
  tilePreview.width = ctx.canvas.width;
  tilePreview.height = ctx.canvas.height;
  tilePreview.style.display = "block";
  tilePreviewCtx.drawImage(ctx.canvas, 0, 0);
  const crossY = py; // flip Y for screen coords
  tilePreviewCtx.strokeStyle = "red";
  tilePreviewCtx.lineWidth = 1;
  tilePreviewCtx.beginPath();
  tilePreviewCtx.moveTo(px, 0); tilePreviewCtx.lineTo(px, ctx.canvas.height);
  tilePreviewCtx.moveTo(0, crossY); tilePreviewCtx.lineTo(ctx.canvas.width, crossY);
  tilePreviewCtx.stroke();

  const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  colorTooltip.innerHTML = `<span style="display:inline-block;width:14px;height:14px;background:${hex};border:1px solid #fff;vertical-align:middle;margin-right:6px"></span>RGB(${r}, ${g}, ${b}) ${hex}`;
  colorTooltip.style.left = (movement.endPosition.x + 15) + "px";
  colorTooltip.style.top = (movement.endPosition.y - 10) + "px";
  colorTooltip.style.display = "block";
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

const gridEntities = [];
let gridVisible = false;

function removePath() {
  if (pathEntity) {
    viewer.entities.remove(pathEntity);
    pathEntity = null;
  }
  for (const e of gridEntities) viewer.entities.remove(e);
  gridEntities.length = 0;
}

function showGridPoints(bounds, stepMeters, color, corridor) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const stepLat = stepMeters / 111320;
  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const stepLon = stepMeters / (111320 * cosLat);
  const latScale = 111320;
  const lonScale = 111320 * cosLat;
  const rows = Math.ceil((maxLat - minLat) / stepLat) + 1;
  const cols = Math.ceil((maxLon - minLon) / stepLon) + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat = minLat + r * stepLat;
      const lon = minLon + c * stepLon;
      if (corridor && distToPath(lat, lon, corridor.path, latScale, lonScale) > corridor.radius) continue;
      gridEntities.push(viewer.entities.add({
        show: gridVisible,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 2,
          color,
          outlineWidth: 0,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
    }
  }
}

function showGridBounds(bounds, color) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  gridEntities.push(viewer.entities.add({
    show: gridVisible,
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        minLon, minLat,
        maxLon, minLat,
        maxLon, maxLat,
        minLon, maxLat,
        minLon, minLat,
      ]),
      width: 2,
      material: color,
      depthFailMaterial: color,
    },
  }));
}

function distToPath(lat, lon, path, latScale, lonScale) {
  let minD = Infinity;
  const px = lat * latScale, py = lon * lonScale;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i].lat * latScale, ay = path[i].lon * lonScale;
    const bx = path[i + 1].lat * latScale, by = path[i + 1].lon * lonScale;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
    if (d < minD) minD = d;
  }
  return minD;
}

async function runAStar(terrainProvider, bounds, stepMeters, startLatLon, endLatLon, corridor) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const stepLat = stepMeters / 111320;
  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const stepLon = stepMeters / (111320 * cosLat);

  const rows = Math.ceil((maxLat - minLat) / stepLat) + 1;
  const cols = Math.ceil((maxLon - minLon) / stepLon) + 1;

  // Build mask: which cells are within corridor
  const latScale = 111320;
  const lonScale = 111320 * cosLat;
  const inCorridor = [];
  let sampledCount = 0;
  for (let r = 0; r < rows; r++) {
    inCorridor[r] = [];
    for (let c = 0; c < cols; c++) {
      if (corridor) {
        const lat = minLat + r * stepLat;
        const lon = minLon + c * stepLon;
        inCorridor[r][c] = distToPath(lat, lon, corridor.path, latScale, lonScale) <= corridor.radius;
      } else {
        inCorridor[r][c] = true;
      }
      if (inCorridor[r][c]) sampledCount++;
    }
  }
  console.log(`Grid: ${rows}x${cols}, sampling ${sampledCount} points (${stepMeters}m)`);

  // Only sample terrain for cells in corridor
  const cartographics = [];
  const cartToCell = []; // maps cartographics index -> [r, c]
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (inCorridor[r][c]) {
        cartographics.push(Cesium.Cartographic.fromDegrees(
          minLon + c * stepLon,
          minLat + r * stepLat,
        ));
        cartToCell.push([r, c]);
      }
    }
  }

  console.log("Sampling terrain...");
  const sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, cartographics);

  const grid = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = new Array(cols).fill(null);
  }
  for (let i = 0; i < sampled.length; i++) {
    const [r, c] = cartToCell[i];
    const h = sampled[i].height;
    grid[r][c] = h !== undefined ? h : null;
  }

  const clamp = (v, max) => Math.max(0, Math.min(max - 1, v));
  const sr = clamp(Math.round((startLatLon.lat - minLat) / stepLat), rows);
  const sc = clamp(Math.round((startLatLon.lon - minLon) / stepLon), cols);
  const er = clamp(Math.round((endLatLon.lat - minLat) / stepLat), rows);
  const ec = clamp(Math.round((endLatLon.lon - minLon) / stepLon), cols);

  console.log(`A* from [${sr},${sc}] to [${er},${ec}]...`);

  const cellKey = (r, c) => r * cols + c;
  const latDist = stepLat * 111320;
  const lonDist = stepLon * 111320 * Math.cos(midLat * Math.PI / 180);
  const diagDist = Math.sqrt(latDist * latDist + lonDist * lonDist);
  const maxSpeed = 6 * 1000 / 3600;

  const neighbors = [
    [-1, 0, latDist], [1, 0, latDist],
    [0, -1, lonDist], [0, 1, lonDist],
    [-1, -1, diagDist], [-1, 1, diagDist],
    [1, -1, diagDist], [1, 1, diagDist],
  ];

  function heuristic(r, c) {
    const dr = (r - er) * latDist;
    const dc = (c - ec) * lonDist;
    return Math.sqrt(dr * dr + dc * dc) / maxSpeed;
  }

  const startH = grid[sr][sc] || 0;

  function toblerCost(dh, dist, neighborH) {
    const slope = dh / dist;
    const speed = 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
    let cost = dist / (speed * 1000 / 3600);
    const above = Math.max(0, neighborH - startH);
    cost += above * 10;
    return cost;
  }

  const pq = [];
  function pqPush(item) {
    pq.push(item);
    let i = pq.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (pq[p].f <= pq[i].f) break;
      [pq[p], pq[i]] = [pq[i], pq[p]];
      i = p;
    }
  }
  function pqPop() {
    const top = pq[0];
    const last = pq.pop();
    if (pq.length > 0) {
      pq[0] = last;
      let i = 0;
      while (true) {
        let s = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < pq.length && pq[l].f < pq[s].f) s = l;
        if (r < pq.length && pq[r].f < pq[s].f) s = r;
        if (s === i) break;
        [pq[s], pq[i]] = [pq[i], pq[s]];
        i = s;
      }
    }
    return top;
  }

  const closedSet = new Set();
  const cameFrom = new Map();
  const gScore = new Map();

  gScore.set(cellKey(sr, sc), 0);
  pqPush({ r: sr, c: sc, f: heuristic(sr, sc) });

  let found = false;
  let iterations = 0;

  while (pq.length > 0) {
    const current = pqPop();
    const ck = cellKey(current.r, current.c);

    if (closedSet.has(ck)) continue;
    closedSet.add(ck);

    if (current.r === er && current.c === ec) {
      found = true;
      break;
    }

    iterations++;
    if (iterations % 10000 === 0) {
      console.log(`A* iteration ${iterations}, open: ${pq.length}`);
    }

    const currentH = grid[current.r][current.c];
    if (currentH === null) continue;

    for (const [dr, dc, dist] of neighbors) {
      const nr = current.r + dr;
      const nc = current.c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;

      const nk = cellKey(nr, nc);
      if (closedSet.has(nk)) continue;

      const nh = grid[nr][nc];
      if (nh === null) continue;

      const dh = nh - currentH;
      const cost = toblerCost(dh, dist, nh);
      const tentG = gScore.get(ck) + cost;

      if (!gScore.has(nk) || tentG < gScore.get(nk)) {
        gScore.set(nk, tentG);
        cameFrom.set(nk, ck);
        pqPush({ r: nr, c: nc, f: tentG + heuristic(nr, nc) });
      }
    }
  }

  if (!found) return null;

  const path = [];
  let ck = cellKey(er, ec);
  while (ck !== undefined) {
    const r = Math.floor(ck / cols);
    const c = ck % cols;
    path.unshift({ lat: minLat + r * stepLat, lon: minLon + c * stepLon });
    ck = cameFrom.get(ck);
  }

  console.log(`Path: ${path.length} points, ${iterations} iterations`);
  return path;
}

async function planPath(start, end) {
  removePath();

  // Distance AB in meters
  const midLat = (start.lat + end.lat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const dLatM = (end.lat - start.lat) * 111320;
  const dLonM = (end.lon - start.lon) * 111320 * cosLat;
  const distAB = Math.sqrt(dLatM * dLatM + dLonM * dLonM);
  console.log(`Distance AB: ${Math.round(distAB)}m`);

  const coarseStep = Math.max(40, distAB / 60);
  const fineStep = Math.max(10, distAB / 300);

  // Pass 1: coarse grid
  const latSpan = Math.abs(end.lat - start.lat) || 0.001;
  const lonSpan = Math.abs(end.lon - start.lon) || 0.001;
  const span = Math.max(latSpan, lonSpan);

  console.log(`=== Pass 1: coarse (${Math.round(coarseStep)}m) ===`);
  const coarseBounds = {
    minLat: Math.min(start.lat, end.lat) - span * 0.6,
    maxLat: Math.max(start.lat, end.lat) + span * 0.6,
    minLon: Math.min(start.lon, end.lon) - span * 0.6,
    maxLon: Math.max(start.lon, end.lon) + span * 0.6,
  };
  showGridBounds(coarseBounds, Cesium.Color.YELLOW);
  showGridPoints(coarseBounds, coarseStep, Cesium.Color.YELLOW);
  const coarsePath = await runAStar(viewer.terrainProvider, coarseBounds, coarseStep, start, end);

  if (!coarsePath) {
    console.warn("No path found!");
    return;
  }

  // Pass 2: fine grid, corridor around coarse path
  const corridorRadius = coarseStep * 1.5;
  const bufferDeg = corridorRadius / 111320;
  const bufferDegLon = corridorRadius / (111320 * cosLat);
  let fMinLat = Infinity, fMaxLat = -Infinity, fMinLon = Infinity, fMaxLon = -Infinity;
  for (const p of coarsePath) {
    if (p.lat < fMinLat) fMinLat = p.lat;
    if (p.lat > fMaxLat) fMaxLat = p.lat;
    if (p.lon < fMinLon) fMinLon = p.lon;
    if (p.lon > fMaxLon) fMaxLon = p.lon;
  }

  console.log(`=== Pass 2: fine (${Math.round(fineStep)}m, corridor ${Math.round(corridorRadius)}m) ===`);
  const fineBounds = {
    minLat: fMinLat - bufferDeg,
    maxLat: fMaxLat + bufferDeg,
    minLon: fMinLon - bufferDegLon,
    maxLon: fMaxLon + bufferDegLon,
  };
  showGridBounds(fineBounds, Cesium.Color.CYAN);
  const corridorObj = { path: coarsePath, radius: corridorRadius };
  showGridPoints(fineBounds, fineStep, Cesium.Color.CYAN, corridorObj);
  const finePath = await runAStar(viewer.terrainProvider, fineBounds, fineStep, start, end, corridorObj);

  let resultPath = finePath || coarsePath;

  // Low-pass filter: moving average on lat/lon (2 passes, window 7)
  for (let pass = 0; pass < 2; pass++) {
    const filtered = [resultPath[0]];
    const w = 3; // half-window
    for (let i = 1; i < resultPath.length - 1; i++) {
      let lat = 0, lon = 0, count = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(resultPath.length - 1, i + w); k++) {
        lat += resultPath[k].lat;
        lon += resultPath[k].lon;
        count++;
      }
      filtered.push({ lat: lat / count, lon: lon / count });
    }
    filtered.push(resultPath[resultPath.length - 1]);
    resultPath = filtered;
  }

  // Convert to Cartesian3
  const path = resultPath.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
  path[0] = Cesium.Cartesian3.fromDegrees(start.lon, start.lat);
  path[path.length - 1] = Cesium.Cartesian3.fromDegrees(end.lon, end.lat);

  // Catmull-Rom spline smoothing (extrapolate phantom endpoints)
  const n = path.length;
  const phantomStart = Cesium.Cartesian3.subtract(
    Cesium.Cartesian3.multiplyByScalar(path[0], 2, new Cesium.Cartesian3()),
    path[1], new Cesium.Cartesian3(),
  );
  const phantomEnd = Cesium.Cartesian3.subtract(
    Cesium.Cartesian3.multiplyByScalar(path[n - 1], 2, new Cesium.Cartesian3()),
    path[n - 2], new Cesium.Cartesian3(),
  );
  const padded = [phantomStart, ...path, phantomEnd];
  const spline = new Cesium.CatmullRomSpline({
    times: padded.map((_, i) => i),
    points: padded,
  });
  const smoothPath = [];
  const subdivisions = 4;
  for (let i = 1; i < padded.length - 2; i++) {
    for (let j = 0; j < subdivisions; j++) {
      smoothPath.push(spline.evaluate(i + j / subdivisions));
    }
  }
  smoothPath.push(spline.evaluate(padded.length - 2));

  pathEntity = viewer.entities.add({
    polyline: {
      positions: smoothPath,
      width: 4,
      material: Cesium.Color.LIME,
      clampToGround: true,
    },
  });
}

document.addEventListener("keydown", (event) => {
  // Military clustering keys (M, 1-4)
  if (handleKeydown(event, viewer)) return;

  if (event.key === "Delete" && clickedEntities.length > 0) {
    viewer.entities.remove(clickedEntities.pop());
    clickedGroundPositions.pop();
    clickedWaypointData.pop();
    removePath();
  } else if (event.key === "s" || event.key === "S") {
    if (clickedWaypointData.length === 0) return;
    fetch("/data/waypoints.json").then(r => r.json()).then((routes) => {
      if (routes.length >= 26) {
        console.warn("Maximum 26 routes (A-Z) reached, cannot save more");
        return;
      }
      const letter = String.fromCharCode(65 + routes.length);
      const route = clickedWaypointData.map((wp, i) => ({
        name: `${letter}${i + 1}`,
        lat: parseFloat(wp.lat.toFixed(6)),
        lon: parseFloat(wp.lon.toFixed(6)),
        alt: parseFloat(wp.alt.toFixed(6)),
      }));
      return fetch("/api/save-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route),
      });
    }).then((res) => {
      if (!res || !res.ok) return;
      console.log("Route saved");
      // Clear clicked points and path
      for (const e of clickedEntities) viewer.entities.remove(e);
      clickedEntities.length = 0;
      clickedGroundPositions.length = 0;
      clickedWaypointData.length = 0;
      removePath();
      // Reload saved routes
      loadWaypoints();
    }).catch((e) => console.error("Save error:", e));
  } else if (event.key === "c" || event.key === "C") {
    const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    const cameraData = {
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      lon: Cesium.Math.toDegrees(cartographic.longitude),
      height: cartographic.height,
      heading: Cesium.Math.toDegrees(viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
      roll: Cesium.Math.toDegrees(viewer.camera.roll),
    };
    console.log("Camera view saved:", cameraData);
  } else if (event.key === "p" || event.key === "P") {
    if (clickedWaypointData.length < 2) {
      console.warn("Need at least 2 clicked points for path planning");
      return;
    }
    const start = clickedWaypointData[clickedWaypointData.length - 2];
    const end = clickedWaypointData[clickedWaypointData.length - 1];
    planPath(start, end);
  } else if (event.key === "Tab") {
    event.preventDefault();
    gridVisible = !gridVisible;
    for (const e of gridEntities) e.show = gridVisible;
  }
});
