import * as Cesium from "cesium";

// --- Symbol rendering ---

const SYMBOL_SIZE = 64;
const BLUE = "#2040FF";
const NIGHT_GREEN = "#202066";

// Draw a path twice: first as thick white outline, then as blue foreground
function outlinedStroke(ctx, drawPath) {
  ctx.strokeStyle = "white"; ctx.lineWidth = 5;
  ctx.beginPath(); drawPath(); ctx.stroke();
  ctx.strokeStyle = BLUE; ctx.lineWidth = 2;
  ctx.beginPath(); drawPath(); ctx.stroke();
}

function outlinedDot(ctx, x, y, r) {
  ctx.fillStyle = "white";
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = BLUE;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

function drawMilitarySymbol(type, hq) {
  const canvas = document.createElement("canvas");
  canvas.width = SYMBOL_SIZE;
  canvas.height = SYMBOL_SIZE;
  const ctx = canvas.getContext("2d");

  // Rectangle body (white fill + outline, then blue)
  const rx = 10, ry = 16, rw = 44, rh = 24;
  ctx.fillStyle = "white";
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = "white"; ctx.lineWidth = 5;
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.fillStyle = "rgba(30,60,255,0.8)";
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = BLUE; ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, rw, rh);

  const cx = SYMBOL_SIZE / 2;

  // HQ staff line below rectangle (APP-6 HQ indicator)
  if (hq) {
    outlinedStroke(ctx, () => {
      ctx.moveTo(rx, ry + rh);
      ctx.lineTo(rx, ry + rh + 14);
    });
  }

  // Echelon marker above rectangle
  if (type === "squad") {
    const y = ry - 4;
    outlinedStroke(ctx, () => {
      ctx.moveTo(cx - 5, y - 5); ctx.lineTo(cx + 5, y + 5);
      ctx.moveTo(cx + 5, y - 5); ctx.lineTo(cx - 5, y + 5);
    });
  } else if (type === "platoon") {
    const y = ry - 6;
    for (const dx of [-8, 0, 8]) outlinedDot(ctx, cx + dx, y, 3);
  } else if (type === "company") {
    outlinedStroke(ctx, () => {
      ctx.moveTo(cx, ry - 2); ctx.lineTo(cx, ry - 12);
    });
  } else if (type === "battalion") {
    outlinedStroke(ctx, () => {
      ctx.moveTo(cx - 5, ry - 2); ctx.lineTo(cx - 5, ry - 12);
      ctx.moveTo(cx + 5, ry - 2); ctx.lineTo(cx + 5, ry - 12);
    });
  } else if (type === "regiment") {
    // III — three vertical lines
    outlinedStroke(ctx, () => {
      ctx.moveTo(cx - 10, ry - 2); ctx.lineTo(cx - 10, ry - 12);
      ctx.moveTo(cx, ry - 2); ctx.lineTo(cx, ry - 12);
      ctx.moveTo(cx + 10, ry - 2); ctx.lineTo(cx + 10, ry - 12);
    });
  } else if (type === "brigade") {
    // X — two crossing diagonal lines
    outlinedStroke(ctx, () => {
      ctx.moveTo(cx - 8, ry - 2); ctx.lineTo(cx + 8, ry - 14);
      ctx.moveTo(cx + 8, ry - 2); ctx.lineTo(cx - 8, ry - 14);
    });
  }

  return canvas;
}

// Cache billboard images
const symbolImages = {};
function getSymbolImage(type, hq) {
  const key = hq ? type + "_hq" : type;
  if (!symbolImages[key]) {
    symbolImages[key] = drawMilitarySymbol(type, hq);
  }
  return symbolImages[key];
}

// --- Identity-based symbol rendering (APP-6 shapes) ---

const IDENTITY_COLORS = {
  friendly: "#2040FF",
  hostile:  "#FF2020",
  neutral:  "#20AA80",
  unknown:  "#C8A800",
};

function drawIdentityShape(ctx, identity, rx, ry, rw, rh) {
  const color = IDENTITY_COLORS[identity] || IDENTITY_COLORS.unknown;
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const hw = rw / 2, hh = rh / 2;

  // White fill + outline, then colored fill + outline
  ctx.fillStyle = "white";
  ctx.strokeStyle = "white";
  ctx.lineWidth = 5;

  if (identity === "friendly") {
    // Rectangle (same as existing)
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.fillStyle = color + "CC";
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);
  } else if (identity === "hostile") {
    // Diamond
    ctx.beginPath();
    ctx.moveTo(cx, ry - 2);
    ctx.lineTo(rx + rw + 2, cy);
    ctx.lineTo(cx, ry + rh + 2);
    ctx.lineTo(rx - 2, cy);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color + "CC";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, ry);
    ctx.lineTo(rx + rw, cy);
    ctx.lineTo(cx, ry + rh);
    ctx.lineTo(rx, cy);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (identity === "neutral") {
    // Square
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.fillStyle = color + "CC";
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);
  } else {
    // Unknown: quatrefoil (clover shape)
    const r = Math.min(hw, hh) * 0.55;
    ctx.beginPath();
    ctx.arc(cx, ry + r * 0.3, r, 0, Math.PI * 2);
    ctx.arc(cx + hw * 0.6, cy, r, 0, Math.PI * 2);
    ctx.arc(cx, ry + rh - r * 0.3, r, 0, Math.PI * 2);
    ctx.arc(cx - hw * 0.6, cy, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color + "CC";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, ry + r * 0.3, r, 0, Math.PI * 2);
    ctx.arc(cx + hw * 0.6, cy, r, 0, Math.PI * 2);
    ctx.arc(cx, ry + rh - r * 0.3, r, 0, Math.PI * 2);
    ctx.arc(cx - hw * 0.6, cy, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
}

function drawEntityIcon(ctx, entityType, threatType, cx, cy, color) {
  ctx.fillStyle = "white";
  ctx.strokeStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 11px sans-serif";

  if (entityType === "uav") {
    // Small drone silhouette: V-shape wings
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy + 4);
    ctx.lineTo(cx, cy - 5);
    ctx.lineTo(cx + 10, cy + 4);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy + 4);
    ctx.lineTo(cx, cy - 5);
    ctx.lineTo(cx + 10, cy + 4);
    ctx.stroke();
  } else if (entityType === "ugv") {
    // Tracked vehicle: hull rectangle with two track wheels
    const hw = 10, hh = 5;
    // White outline
    ctx.lineWidth = 4;
    ctx.strokeStyle = "white";
    ctx.strokeRect(cx - hw, cy - hh, hw * 2, hh * 2);
    ctx.beginPath();
    ctx.arc(cx - hw + 2, cy + hh, 3, 0, Math.PI * 2);
    ctx.arc(cx + hw - 2, cy + hh, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Color layer
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - hw, cy - hh, hw * 2, hh * 2);
    ctx.beginPath();
    ctx.arc(cx - hw + 2, cy + hh, 3, 0, Math.PI * 2);
    ctx.arc(cx + hw - 2, cy + hh, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (entityType === "sensor") {
    // Antenna icon: vertical line with radiating arcs
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 6);
    ctx.lineTo(cx, cy - 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy - 4, 5, -Math.PI * 0.8, -Math.PI * 0.2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 6);
    ctx.lineTo(cx, cy - 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy - 4, 5, -Math.PI * 0.8, -Math.PI * 0.2);
    ctx.stroke();
  } else if (entityType === "artillery") {
    // Circle with dot
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (entityType === "human") {
    // Infantry X cross
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 6);
    ctx.lineTo(cx + 8, cy + 6);
    ctx.moveTo(cx + 8, cy - 6);
    ctx.lineTo(cx - 8, cy + 6);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 6);
    ctx.lineTo(cx + 8, cy + 6);
    ctx.moveTo(cx + 8, cy - 6);
    ctx.lineTo(cx - 8, cy + 6);
    ctx.stroke();
  } else if (entityType === "threat") {
    // Downward-pointing triangle (hazard/threat)
    const s = 9;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "white";
    ctx.beginPath();
    ctx.moveTo(cx, cy + s);
    ctx.lineTo(cx - s, cy - s * 0.6);
    ctx.lineTo(cx + s, cy - s * 0.6);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + s);
    ctx.lineTo(cx - s, cy - s * 0.6);
    ctx.lineTo(cx + s, cy - s * 0.6);
    ctx.closePath();
    ctx.stroke();
    // Exclamation mark inside
    ctx.fillStyle = color;
    ctx.fillRect(cx - 1, cy - 4, 2.5, 6);
    ctx.beginPath();
    ctx.arc(cx + 0.25, cy + 5, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawOtherUnitSymbol(entityType, identity, threatType) {
  const canvas = document.createElement("canvas");
  canvas.width = SYMBOL_SIZE;
  canvas.height = SYMBOL_SIZE;
  const ctx = canvas.getContext("2d");

  const rx = 8, ry = 14, rw = 48, rh = 28;
  drawIdentityShape(ctx, identity, rx, ry, rw, rh);

  const color = IDENTITY_COLORS[identity] || IDENTITY_COLORS.unknown;
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  drawEntityIcon(ctx, entityType, threatType, cx, cy, color);

  return canvas;
}

const otherSymbolImages = {};
function getOtherSymbolImage(entityType, identity, threatType) {
  const key = `${identity}_${entityType}_${threatType || ""}`;
  if (!otherSymbolImages[key]) {
    otherSymbolImages[key] = drawOtherUnitSymbol(entityType, identity, threatType);
  }
  return otherSymbolImages[key];
}

export async function loadOtherUnits(viewer) {
  const response = await fetch("/data/other-units.json");
  const units = await response.json();

  // Wait for terrain provider to be ready, then sample ground altitudes
  let terrainProvider = viewer.terrainProvider;
  if (!terrainProvider || terrainProvider instanceof Cesium.EllipsoidTerrainProvider) {
    await new Promise(resolve => {
      const remove = viewer.scene.terrainProviderChanged.addEventListener((tp) => {
        if (!(tp instanceof Cesium.EllipsoidTerrainProvider)) {
          remove();
          terrainProvider = tp;
          resolve();
        }
      });
    });
  }
  const cartographics = units.map(u =>
    Cesium.Cartographic.fromDegrees(u.position.lon, u.position.lat)
  );
  await Cesium.sampleTerrainMostDetailed(terrainProvider, cartographics);

  // let needsSave = false;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const groundAlt = cartographics[i].height || 0;
    const aboveGround = unit.entity === "uav"
      ? 100 + Math.random() * 200
      : 2;
    const correctedAlt = Math.round(groundAlt + aboveGround);
    // if (unit.position.alt !== correctedAlt) {
    //   unit.position.alt = correctedAlt;
    //   needsSave = true;
    // }
    const image = getOtherSymbolImage(unit.entity, unit.identity, unit.threatType);
    const position = Cesium.Cartesian3.fromDegrees(
      unit.position.lon, unit.position.lat, correctedAlt
    );

    const entity = viewer.entities.add({
      name: unit.name,
      position,
      billboard: {
        image,
        width: SYMBOL_SIZE,
        height: SYMBOL_SIZE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: 5000,
      },
      label: {
        text: unit.name,
        font: "14px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -(SYMBOL_SIZE + 4)),
        eyeOffset: new Cesium.Cartesian3(0, 0, -50),
        show: false,
      },
    });
    entity.show = false;
    entity._isOtherUnit = true;
    entity._otherUnitType = unit.entity;
    entity._labelPixelOffsetY = -(SYMBOL_SIZE + 4);
    estimateLabelSize(entity);
    otherUnitEntities.push(entity);
  }

  // if (needsSave) {
  //   fetch("/api/save-other-units", {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify(units),
  //   }).then(() => console.log("other-units.json altitudes updated from Cesium terrain"))
  //     .catch(e => console.warn("Failed to save other-units.json:", e));
  // }
}

// --- Data structures ---

const LEVEL_ORDER = ["individual", "squad", "platoon", "company", "battalion", "regiment", "brigade"];

// All nodes indexed by id
const nodesById = {};
// Flat list of all nodes
let allNodes = [];
// Root node
let rootNode = null;
const otherUnitEntities = [];
const OTHER_UNIT_TYPES = ["uav", "ugv", "threat", "artillery", "human", "sensor"];
const otherUnitTypeVisible = { uav: false, ugv: false, threat: false, artillery: false, human: false, sensor: false };

// Cesium entities indexed by node id
const entitiesById = {};
// Commander entities indexed by node id
const cmdEntitiesById = {};
// Staff entities indexed by node id → [staff1, staff2]
const staffEntitiesById = {};
const HEIGHT_ABOVE_TERRAIN = 2; // meters above terrain surface
const GEOID_UNDULATION = 0; // terrain heights now from Cesium

// Current visible level index (0=squad, 3=battalion)
let currentLevel = 6; // start at brigade level
let militaryVisible = true;
let labelsEnabled = true; // when true, text labels are shown on military entities
let nightMode = false;
let moduleViewer = null;          // viewer reference for dot updates

// Auto-level state
let autoLevelEnabled = true;
let floorLevel = 3;              // 0=individual (allow all), 6=brigade (block all)
let autoCurrentLevel = 6;        // current level determined by camera
const manuallyExpanded = new Set(); // node IDs expanded manually via tap
function updateResetButton() {
  const btn = document.getElementById("floor-reset-btn");
  if (!btn) return;
  const active = manuallyExpanded.size > 0;
  btn.disabled = !active;
  const activeColor = nightMode ? NIGHT_GREEN : BLUE;
  btn.style.background = active ? activeColor : "rgba(255,255,255,0.15)";
  btn.style.color = active ? (nightMode ? "#000" : "#fff") : "rgba(255,255,255,0.3)";
  btn.style.cursor = active ? "pointer" : "default";
}

const LEVEL_THRESHOLDS = [
  { level: 6, minHeight: 65000 }, // brigade
  { level: 5, minHeight: 30000 },  // regiment
  { level: 4, minHeight: 13000 },  // battalion
  { level: 3, minHeight: 6000 },   // company
  { level: 2, minHeight: 1500 },   // platoon
  { level: 1, minHeight: 600 },   // squad
  { level: 0, minHeight: 0 },    // individual
];

// Heatmap state
let oldHeatmap = null;
let heatmapLayer = null;          // Cesium.ImageryLayer
let heatmapCanvas = null;         // offscreen canvas (reused)
const HEATMAP_CANVAS_SIZE = 1024;
let heatmapUrlCounter = 0;        // cache-busting counter
let heatmapSwapTimer = null;      // pending swapHeatmaps timeout

// Heatmap adjustable parameters
let heatmapMinRadius = 8;
let heatmapMaxRadius = 20;
let heatmapMinAlpha = 0.11;
let heatmapMaxAlpha = 0.6;
let heatmapGradientMid = 0.3;
let heatmapGridSize = 32;
let heatmapBlendMode = "color";
let heatmapHue = 220;
let heatmapSaturation = 100;
let heatmapLightness = 50;


// Canvas overlay for drone arrows (full opacity, drawn on top of post-process stages)
let arrowCanvas = null;
let arrowCtx = null;

// Canvas overlay for labels (drawn on top of arrows so labels are never occluded by billboards)
let labelCanvas = null;
let labelCtx = null;
const labelDrawList = []; // rebuilt each frame by updateLabelDeclutter
// Each entry: { base: Cartesian3, tip: Cartesian3, color: string }
export const canvasArrows = [];
// Each entry: { lines: [[Cartesian3,Cartesian3],...], color: string, width: number }
export const canvasFrustumLines = [];
// Each entry: { position: Cartesian3, color: string, outlineColor: string, pixelSize: number, outlineWidth: number }
export const canvasDots = [];

// Label declutter constants
let LABEL_CELL_W = 8;
let LABEL_CELL_H = 8;
let LABEL_HYSTERESIS = 0.4; // also 0.34 seems to work fine
let LABEL_SETTLE_MS = 100; // camera settle time before labels appear
let DEBUG_LABEL_DECLUTTER = false;

// Label state tracking for hysteresis
const labelStates = new Map(); // entity id -> { showing: bool }
const labelDebugRects = []; // { x, y, w, h } for debug visualization

// --- Sound effects ---

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

export function playBeep(freq, duration = 0.08) {
  const ctx = getAudioCtx();
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

const UNMERGE_BEEP_FREQ = 880;   // A5 — higher pitch for unmerge
const MERGE_BEEP_FREQ = 440;     // A4 — lower pitch for merge

function playFloorClick(level) {
  const ctx = getAudioCtx();
  if (ctx.state === "suspended") ctx.resume();
  const baseFreq = 780 - level * 80;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = baseFreq;
  gain.gain.setValueAtTime(0.12, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.06);
}

function playLevelTick(level, direction) {
  const ctx = getAudioCtx();
  if (ctx.state === "suspended") ctx.resume();
  // Subtle soft tick — higher pitch zooming in, lower zooming out
  const freq = direction > 0 ? 1200 - level * 60 : 400 + level * 60;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.015, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.05);
}

// Animation state
const animations = []; // { entity, from, to, startTime, duration, fade, onComplete }
let animating = false;
const WHITE = Cesium.Color.WHITE;

function setEntityAlpha(entity, alpha) {
  // Use small epsilon for billboard to prevent Cesium from skipping fully-transparent billboards
  const a = Math.max(alpha, 0.005);
  entity.billboard.color = nightMode
    ? new Cesium.Color(0.3, 0.3, 0.3, a)
    : new Cesium.Color(1, 1, 1, a);
}

function setEntityScale(entity, scale) {
  entity.billboard.width = SYMBOL_SIZE * scale;
  entity.billboard.height = SYMBOL_SIZE * scale;
}


// --- Loading ---

function flattenTree(node, parent) {
  node.parent = parent;
  nodesById[node.id] = node;
  allNodes.push(node);
  // Units (squad+) have no position — always track commander position
  if (!node.position && node.commander) {
    node.position = node.commander.position;
  }
  const pos = node.position;
  node.homePosition = Cesium.Cartesian3.fromDegrees(
    pos.lon, pos.lat, pos.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
  );
  // Commander position (own position if available, otherwise same as unit)
  if (node.commander && node.commander.position) {
    node.cmdHomePosition = Cesium.Cartesian3.fromDegrees(
      node.commander.position.lon, node.commander.position.lat,
      node.commander.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
    );
  } else {
    node.cmdHomePosition = node.homePosition;
  }
  // Staff positions from JSON data
  if (node.staff && node.staff.length >= 2) {
    node.staffHomePositions = node.staff.map(s =>
      Cesium.Cartesian3.fromDegrees(s.position.lon, s.position.lat, s.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN)
    );
  }
  for (const child of node.children) {
    flattenTree(child, node);
  }
}

export async function loadMilitaryUnits(viewer) {
  moduleViewer = viewer;
  const response = await fetch("/data/military-units.json");
  const tree = await response.json();
  allNodes = [];
  rootNode = tree;
  flattenTree(tree, null);

  for (const node of allNodes) {
    const levelIdx = LEVEL_ORDER.indexOf(node.type);
    const image = getSymbolImage(node.type);
    const isIndividual = node.type === "individual";
    // const size = isIndividual ? 40 : SYMBOL_SIZE;
    const size = SYMBOL_SIZE;

    const entity = viewer.entities.add({
      name: node.name,
      position: node.homePosition,
      billboard: {
        image,
        width: size,
        height: size,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: 5000,
      },
      label: {
        text: node.name,
        font: isIndividual ? "18px sans-serif" : "18px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -(size + 4)),
        eyeOffset: new Cesium.Cartesian3(0, 0, -50),
        show: false,

      },
      show: levelIdx === currentLevel,
    });

    entity._milNode = node;
    entity._labelPixelOffsetY = -(size + 4);
    estimateLabelSize(entity);
    entitiesById[node.id] = entity;
  }

  // Create commander and staff entities for non-individual nodes
  for (const node of allNodes) {
    if (node.type === "individual" || !node.commander) continue;

    // Commander entity: HQ symbol of node's type, at node's position
    const cmdImage = getSymbolImage(node.type, true);
    const cmdLabel = node.name + " - " + node.commander.name;
    const cmdEntity = viewer.entities.add({
      name: cmdLabel,
      position: node.cmdHomePosition,
      billboard: {
        image: cmdImage,
        width: SYMBOL_SIZE,
        height: SYMBOL_SIZE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: 5000,
      },
      label: {
        text: cmdLabel,
        font: "18px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -(SYMBOL_SIZE + 4)),
        eyeOffset: new Cesium.Cartesian3(0, 0, -50),
        show: false,

      },
      show: false,
    });
    cmdEntity._milCmdOf = node;
    cmdEntity._labelPixelOffsetY = -(SYMBOL_SIZE + 4);
    estimateLabelSize(cmdEntity);
    cmdEntitiesById[node.id] = cmdEntity;

    // Staff entities: individual HQ symbol, at staff positions
    if (node.staff && node.staffHomePositions) {
      const staffImage = getSymbolImage("individual", true);
      const staffEnts = [];
      for (let si = 0; si < node.staff.length; si++) {
        const s = node.staff[si];
        const staffEntity = viewer.entities.add({
          name: s.name,
          position: node.staffHomePositions[si],
          billboard: {
            image: staffImage,
            // width: 48, height: 48,
            width: SYMBOL_SIZE,
            height: SYMBOL_SIZE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: 5000,
          },
          label: {
            text: s.name,
            font: "18px sans-serif",
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineWidth: 2,
            fillColor: Cesium.Color.WHITE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -52),
            eyeOffset: new Cesium.Cartesian3(0, 0, -50),
            show: false,

              },
          show: false,
        });
        staffEntity._milStaffOf = node;
        staffEntity._labelPixelOffsetY = -52;
        estimateLabelSize(staffEntity);
        staffEnts.push(staffEntity);
      }
      staffEntitiesById[node.id] = staffEnts;
    }
  }

  // Arrow canvas (full opacity, renders on top of everything)
  const container = document.getElementById("cesiumContainer");
  arrowCanvas = document.createElement("canvas");
  arrowCanvas.style.position = "absolute";
  arrowCanvas.style.top = "0";
  arrowCanvas.style.left = "0";
  arrowCanvas.style.pointerEvents = "none";
  container.appendChild(arrowCanvas);
  arrowCtx = arrowCanvas.getContext("2d");

  // Label canvas (renders on top of arrowCanvas)
  labelCanvas = document.createElement("canvas");
  labelCanvas.style.position = "absolute";
  labelCanvas.style.top = "0";
  labelCanvas.style.left = "0";
  labelCanvas.style.pointerEvents = "none";
  container.appendChild(labelCanvas);
  labelCtx = labelCanvas.getContext("2d");

  const syncCanvasSize = () => {
    const cw = viewer.canvas.clientWidth;
    const ch = viewer.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    arrowCanvas.style.width = cw + "px";
    arrowCanvas.style.height = ch + "px";
    arrowCanvas.width = cw * dpr;
    arrowCanvas.height = ch * dpr;
    arrowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    labelCanvas.style.width = cw + "px";
    labelCanvas.style.height = ch + "px";
    labelCanvas.width = cw * dpr;
    labelCanvas.height = ch * dpr;
    labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  syncCanvasSize();

  // Keep canvas size in sync with Cesium canvas
  const ro = new ResizeObserver(() => { syncCanvasSize(); });
  ro.observe(viewer.canvas);

  createHeatmapControls();
  createFloorSlider();
  createOtherUnitsToolbar();
  updateHeatmapLayer();
  return { entitiesById, nodesById, allNodes };
}

// --- Animation ---



function startAnimations(anims) {
  stopMoveUnits();
  const now = performance.now();
  for (const a of anims) {
    a.startTime = now;
    a.entity.show = true;
    if (a.fade === "in") {
      setEntityAlpha(a.entity, 0);
    } else if (a.fade === "out") {
      setEntityAlpha(a.entity, 1);
    }
    // Set position immediately since there's no movement animation
    a.entity.position = a.to;
    animations.push(a);
  }
  animating = true;
}

function onPreRender() {
  if (!animating) return;

  const now = performance.now();
  let allDone = true;

  for (let i = animations.length - 1; i >= 0; i--) {
    const a = animations[i];
    const t = (now - a.startTime) / a.duration;
    if (t >= 1) {
      // Animation complete — reset alpha, run callback
      if (a.fade) setEntityAlpha(a.entity, 1);
      if (a.onComplete) a.onComplete();
      animations.splice(i, 1);
    } else {
      if (a.fade) {
        // Linear fade
        const alpha = a.fade === "in" ? t : 1 - t;
        setEntityAlpha(a.entity, alpha);
      }
      allDone = false;
    }
  }

  if (allDone) {
    animating = false;
    labelStates.clear();
    updateHeatmapLayer();
    if (movementEnabled) startMoveUnits();
  }
}

// --- Merge / Unmerge ---




function setCmdStaffShow(node, show) {
  const cmdE = cmdEntitiesById[node.id];
  if (cmdE) {
    cmdE.show = show;
    cmdE.position = node.cmdHomePosition;
    if (show) setEntityAlpha(cmdE, 1);
  }
  // Hide the unit's own label when commander label is visible to avoid overlap
  const unitE = entitiesById[node.id];
  if (unitE) {
    unitE._labelHidden = show;
  }
  const staffEs = staffEntitiesById[node.id];
  if (staffEs) {
    for (const se of staffEs) {
      se.show = show;
      if (show) setEntityAlpha(se, 1);
    }
    // Reset staff positions
    if (node.staffHomePositions) {
      for (let i = 0; i < staffEs.length; i++) {
        staffEs[i].position = node.staffHomePositions[i];
      }
    }
  }
}

function hideAllCmdStaff() {
  for (const node of allNodes) {
    if (cmdEntitiesById[node.id]) cmdEntitiesById[node.id].show = false;
    const staffEs = staffEntitiesById[node.id];
    if (staffEs) for (const se of staffEs) se.show = false;
    const unitE = entitiesById[node.id];
    if (unitE) unitE._labelHidden = false;
  }
}

// --- Label decluttering ---

function entityRank(entity) {
  if (entity._milNode) return LEVEL_ORDER.indexOf(entity._milNode.type);
  if (entity._milCmdOf) return LEVEL_ORDER.indexOf(entity._milCmdOf.type) + 0.5;
  if (entity._milStaffOf) return 0;
  if (entity._isOtherUnit) return 0;
  return -1;
}

function estimateLabelSize(entity) {
  if (!entity || !entity.label) return;
  const text = entity.label.text;
  const str = (text && text.getValue) ? text.getValue(Cesium.JulianDate.now()) : text;
  if (!str) { entity._labelEstW = 60; entity._labelEstH = 24; return; }
  // Parse font size from label font string (e.g. "bold 18px sans-serif" or "14px sans-serif")
  const font = entity.label.font;
  const fontStr = (font && font.getValue) ? font.getValue(Cesium.JulianDate.now()) : font;
  let fontSize = 16;
  if (fontStr) {
    const m = fontStr.match(/(\d+)px/);
    if (m) fontSize = parseInt(m[1]);
  }
  entity._labelEstW = str.length * fontSize * 0.55 + 12;
  entity._labelEstH = fontSize * 1.3 + 4;
}

function updateLabelDeclutter(viewer) {
  labelDrawList.length = 0;
  labelDebugRects.length = 0;
  if (!labelsEnabled || animating) return;

  const scene = viewer.scene;
  const candidates = [];

  // Collect visible entities with labels
  for (const node of allNodes) {
    const entity = entitiesById[node.id];
    if (entity && entity.show && !entity._labelHidden) {
      const screen = scene.cartesianToCanvasCoordinates(entity.position.getValue ? entity.position.getValue(Cesium.JulianDate.now()) : entity.position);
      if (screen) {
        if (!entity._labelEstW) estimateLabelSize(entity);
        candidates.push({ entity, sx: screen.x, sy: screen.y, rank: entityRank(entity), estW: entity._labelEstW || 60, estH: entity._labelEstH || 24 });
      }
    }
    const cmdE = cmdEntitiesById[node.id];
    if (cmdE && cmdE.show) {
      const screen = scene.cartesianToCanvasCoordinates(cmdE.position.getValue ? cmdE.position.getValue(Cesium.JulianDate.now()) : cmdE.position);
      if (screen) {
        if (!cmdE._labelEstW) estimateLabelSize(cmdE);
        candidates.push({ entity: cmdE, sx: screen.x, sy: screen.y, rank: entityRank(cmdE), estW: cmdE._labelEstW || 60, estH: cmdE._labelEstH || 24 });
      }
    }
    const staffEs = staffEntitiesById[node.id];
    if (staffEs) {
      for (const se of staffEs) {
        if (se && se.show) {
          const screen = scene.cartesianToCanvasCoordinates(se.position.getValue ? se.position.getValue(Cesium.JulianDate.now()) : se.position);
          if (screen) {
            if (!se._labelEstW) estimateLabelSize(se);
            candidates.push({ entity: se, sx: screen.x, sy: screen.y, rank: entityRank(se), estW: se._labelEstW || 60, estH: se._labelEstH || 24 });
          }
        }
      }
    }
  }

  // Collect other-unit entities
  for (const entity of otherUnitEntities) {
    if (entity.show && !entity._labelHidden) {
      const pos = entity.position.getValue ? entity.position.getValue(Cesium.JulianDate.now()) : entity.position;
      const screen = scene.cartesianToCanvasCoordinates(pos);
      if (screen) {
        if (!entity._labelEstW) estimateLabelSize(entity);
        candidates.push({ entity, sx: screen.x, sy: screen.y, rank: 0, estW: entity._labelEstW || 60, estH: entity._labelEstH || 24 });
      }
    }
  }

  if (candidates.length === 0) return;

  // Sort by rank descending (highest priority first)
  candidates.sort((a, b) => b.rank - a.rank);

  // Grid occupancy pass
  const grid = new Map();

  {
    for (const c of candidates) {
      const entityId = c.entity.id;
      let state = labelStates.get(entityId);
      if (!state) {
        state = { showing: false };
        labelStates.set(entityId, state);
      }
      const hyst = state.showing ? (1 - LABEL_HYSTERESIS) : (1 + LABEL_HYSTERESIS);
      const cellW = Math.max(1, LABEL_CELL_W);
      const cellH = Math.max(1, LABEL_CELL_H);
      const sizeW = c.estW * hyst;
      const sizeH = c.estH * hyst;
      const cellsX = Math.max(1, Math.ceil(sizeW / cellW));
      const cellsY = Math.max(1, Math.ceil(sizeH / cellH));
      const labelSy = c.sy + (c.entity._labelPixelOffsetY || 0);
      const centerX = c.sx;
      const centerY = labelSy - c.estH / 2;
      const cx = Math.floor(centerX / cellW) - Math.floor(cellsX / 2);
      const cy = Math.floor(centerY / cellH) - Math.floor(cellsY / 2);

      // Check if any cell is occupied (same cells that will be claimed)
      let blocked = false;
      for (let dx = 0; dx < cellsX && !blocked; dx++) {
        for (let dy = 0; dy < cellsY && !blocked; dy++) {
          const key = (cx + dx) + "," + (cy + dy);
          if (grid.has(key)) blocked = true;
        }
      }

      const wouldShow = !blocked;

      // While camera is moving, only remove labels — don't add new ones
      const show = wouldShow && !(cameraMoving && !state.showing);

      if (show) {
        // Claim cells
        for (let dx = 0; dx < cellsX; dx++) {
          for (let dy = 0; dy < cellsY; dy++) {
            grid.set((cx + dx) + "," + (cy + dy), true);
          }
        }
        // Store debug rect (grid cells being claimed)
        if (DEBUG_LABEL_DECLUTTER) {
          const gridW = cellsX * cellW;
          const gridH = cellsY * cellH;
          labelDebugRects.push({
            x: cx * cellW,
            y: cy * cellH,
            w: gridW,
            h: gridH,
            showing: true,
            labelText: c.entity.label.text
          });
        }
      } else if (DEBUG_LABEL_DECLUTTER) {
        // Still show blocked labels in red for debug (grid cells they would need)
        const gridW = cellsX * cellW;
        const gridH = cellsY * cellH;
        labelDebugRects.push({
          x: cx * cellW,
          y: cy * cellH,
          w: gridW,
          h: gridH,
          showing: false,
          labelText: c.entity.label.text
        });
      }

      // Only update state when it changes
      if (show !== state.showing) {
        state.showing = show;
      }

      if (state.showing) {
        const text = c.entity.label.text;
        const str = (text && text.getValue) ? text.getValue(Cesium.JulianDate.now()) : text;
        if (str) labelDrawList.push({ text: str, sx: c.sx, sy: labelSy, offsetY: 0 });
      }
    }
  }
}

// --- Heatmap ---

function createFloorSlider() {
  const container = document.getElementById("cesiumContainer");
  if (!container) return;

  const wrapper = document.createElement("div");
  wrapper.id = "floor-slider-widget";
  wrapper.style.cssText = `
    position: absolute;
    left: 1px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    background: rgba(20, 20, 20, 0.85);
    width: 100px;
    padding: 14px 70px 14px 0px;
    border-radius: 8px;
    z-index: 100;
    user-select: none;
  `;

  const topLabel = document.createElement("div");
  topLabel.style.cssText = `
    color: rgba(255,255,255,0.5);
    font-family: sans-serif;
    font-size: 10px;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 1px;
  `;
  topLabel.textContent = "brigade";
  wrapper.appendChild(topLabel);

  // Slider + floating label container
  const sliderWrap = document.createElement("div");
  sliderWrap.style.cssText = `position: relative; display: flex; align-items: center; height: 250px;`;

  const input = document.createElement("input");
  input.type = "range";
  input.id = "floor-level-slider";
  input.min = 0;
  input.max = 6;
  input.step = 1;
  input.value = 6 - floorLevel;
  input.orient = "vertical";
  input.style.cssText = `
    writing-mode: vertical-lr;
    appearance: none;
    -webkit-appearance: none;
    width: 70px;
    height: 250px;
    cursor: pointer;
    background: transparent;
    position: relative;
    z-index: 1;
  `;

  // Thumb and track styling
  const thumbStyle = document.createElement("style");
  thumbStyle.id = "floor-slider-style";
  thumbStyle.textContent = `
    #floor-level-slider::-webkit-slider-runnable-track {
      width: 10px;
      background: rgba(255,255,255,0.2);
      border-radius: 3px;
    }
    #floor-level-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 70px;
      height: 40px;
      background: ${BLUE};
      border: none;
      border-radius: 6px;
      cursor: pointer;
      margin-left: -32px;
    }
    #floor-level-slider::-webkit-slider-thumb:hover {
      background: #4060FF;
    }
    #floor-level-slider::-moz-range-track {
      width: 10px;
      background: rgba(255,255,255,0.2);
      border-radius: 3px;
      border: none;
    }
    #floor-level-slider::-moz-range-progress {
      background: ${BLUE};
      border-radius: 3px;
    }
    #floor-level-slider::-moz-range-thumb {
      width: 70px;
      height: 40px;
      background: ${BLUE};
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    #floor-level-slider::-moz-range-thumb:hover {
      background: #4060FF;
    }
  `;
  document.head.appendChild(thumbStyle);

  // Thin fill bar behind the slider
  const trackFill = document.createElement("div");
  trackFill.id = "floor-slider-fill";
  trackFill.style.cssText = `
    position: absolute;
    width: 10px;
    left: 30px;
    top: 0;
    border-radius: 3px;
    background: ${BLUE};
    pointer-events: none;
  `;
  function updateTrackFill() {
    const pct = (parseInt(input.value) / 6) * 100;
    trackFill.style.height = pct + "%";
  }
  updateTrackFill();

  const label = document.createElement("div");
  label.id = "val-floor-level";
  label.style.cssText = `
    position: absolute;
    left: 78px;
    color: #fff;
    font-family: sans-serif;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    white-space: nowrap;
    pointer-events: none;
  `;
  label.textContent = LEVEL_ORDER[floorLevel];

  const trackHeight = 250;
  const thumbH = 40;
  function updateThumbLabel() {
    const raw = parseInt(input.value);
    const frac = raw / 6; // 0 = top, 1 = bottom (due to direction: rtl)
    const top = frac * (trackHeight - thumbH) + thumbH / 2;
    label.style.top = top + "px";
    label.style.transform = "translateY(-50%)";
  }
  updateThumbLabel();

  input.oninput = () => {
    const val = 6 - parseInt(input.value);
    label.textContent = LEVEL_ORDER[val];
    floorLevel = val;
    playFloorClick(val);
    updateThumbLabel();
    updateTrackFill();
    manuallyExpanded.clear(); updateResetButton();
    if (autoLevelEnabled && moduleViewer) {
      const height = moduleViewer.camera.positionCartographic.height;
      autoCurrentLevel = -1; // force update
      applyAutoLevel(levelFromCameraHeight(height));
    }
  };

  sliderWrap.appendChild(trackFill);
  sliderWrap.appendChild(input);
  sliderWrap.appendChild(label);
  wrapper.appendChild(sliderWrap);

  const title = document.createElement("div");
  title.style.cssText = `
    color: rgba(255,255,255,0.5);
    font-family: sans-serif;
    font-size: 10px;
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 1px;
  `;
  title.textContent = "individual";
  wrapper.appendChild(title);

  const resetBtn = document.createElement("button");
  resetBtn.id = "floor-reset-btn";
  resetBtn.textContent = "RESET";
  resetBtn.style.cssText = `
    margin-top: 24px;
    background: ${BLUE};
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0;
    width: 70px;
    height: 70px;
    font-family: sans-serif;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    cursor: pointer;
  `;
  resetBtn.onclick = () => {
    if (manuallyExpanded.size === 0) return;
    playBeep(270, 0.15);
    manuallyExpanded.clear(); updateResetButton();
    updateResetButton();
    if (moduleViewer) {
      const height = moduleViewer.camera.positionCartographic.height;
      autoCurrentLevel = -1;
      applyAutoLevel(levelFromCameraHeight(height));
    }
  };
  // Start inactive
  resetBtn.disabled = true;
  resetBtn.style.background = "rgba(255,255,255,0.15)";
  resetBtn.style.color = "rgba(255,255,255,0.3)";
  resetBtn.style.cursor = "default";
  wrapper.appendChild(resetBtn);

  const aglDisplay = document.createElement("div");
  aglDisplay.id = "val-camera-agl";
  aglDisplay.style.cssText = `
    color: rgba(255,255,255,0.5);
    font-family: sans-serif;
    font-size: 10px;
    margin-top: 8px;
    text-align: center;
  `;
  aglDisplay.textContent = "";
  wrapper.appendChild(aglDisplay);

  container.appendChild(wrapper);
}

function applyOtherUnitVisibility() {
  // squad level index is 1; when camera is zoomed in to squad level or below, show all
  const showAll = moduleViewer && levelFromCameraHeight(moduleViewer.camera.positionCartographic.height) <= 1;
  for (const entity of otherUnitEntities) {
    entity.show = showAll || otherUnitTypeVisible[entity._otherUnitType];
  }
  // Show blue underline on unselected buttons when showAll is active
  for (const type of OTHER_UNIT_TYPES) {
    const btn = document.getElementById("other-unit-btn-" + type);
    if (!btn) continue;
    btn.style.borderBottom = (showAll && !otherUnitTypeVisible[type])
      ? `6px solid ${nightMode ? NIGHT_GREEN : BLUE}` : "none";
  }
}

function createOtherUnitsToolbar() {
  const container = document.getElementById("cesiumContainer");
  if (!container) return;

  const bar = document.createElement("div");
  bar.id = "other-units-toolbar";
  bar.style.cssText = `
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 14px;
    background: rgba(20, 20, 20, 0.85);
    padding: 10px;
    border-radius: 8px;
    z-index: 100;
    user-select: none;
  `;

  const TYPE_LABELS = { uav: "UAV", ugv: "UGV", threat: "THREAT", artillery: "ARTY", human: "HUMAN", sensor: "SENSOR" };

  for (const type of OTHER_UNIT_TYPES) {
    const btn = document.createElement("button");
    btn.id = "other-unit-btn-" + type;
    btn.textContent = TYPE_LABELS[type];
    btn.style.cssText = `
      background: rgba(255,255,255,0.15);
      color: rgba(255,255,255,0.3);
      border: none;
      border-radius: 4px;
      padding: 0;
      width: 70px;
      height: 40px;
      text-align: center;
      font-family: sans-serif;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      cursor: pointer;
    `;
    btn.onclick = () => {
      otherUnitTypeVisible[type] = !otherUnitTypeVisible[type];
      playBeep(otherUnitTypeVisible[type] ? 500 : 300, 0.06);
      btn.style.background = otherUnitTypeVisible[type] ? (nightMode ? NIGHT_GREEN : BLUE) : "rgba(255,255,255,0.15)";
      btn.style.color = otherUnitTypeVisible[type] ? (nightMode ? "#000" : "#fff") : "rgba(255,255,255,0.3)";
      applyOtherUnitVisibility();
    };
    bar.appendChild(btn);
  }

  container.appendChild(bar);

  // Standalone NVG button — bottom-left, aligned with slider
  const nvgWrap = document.createElement("div");
  nvgWrap.id = "nvg-wrap";
  nvgWrap.style.cssText = `
    position: absolute;
    bottom: 16px;
    left: 1px;
    background: rgba(20, 20, 20, 0.85);
    padding: 10px;
    border-radius: 8px;
    z-index: 100;
    user-select: none;
  `;
  const nvgBtn = document.createElement("button");
  nvgBtn.id = "nvg-btn";
  nvgBtn.innerHTML = "NIGHT<br>VISION";
  nvgBtn.style.cssText = `
    background: ${BLUE};
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0 10px;
    width: 70px;
    height: 40px;
    text-align: center;
    font-family: sans-serif;
    font-size: 11px;
    line-height: 1.3;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    cursor: pointer;
  `;
  nvgBtn.onclick = () => toggleNightMode();
  nvgWrap.appendChild(nvgBtn);
  container.appendChild(nvgWrap);
}

function toggleNightMode() {
  nightMode = !nightMode;
  const viewer = moduleViewer;
  if (!viewer) return;

  // Update NVG button style and text
  const nvgBtn = document.getElementById("nvg-btn");
  if (nvgBtn) {
    nvgBtn.innerHTML = nightMode ? "DAYLIGHT" : "NIGHT<br>VISION";
    nvgBtn.style.background = nightMode ? NIGHT_GREEN : BLUE;
    nvgBtn.style.color = nightMode ? "#000" : "#fff";
  }
  const nvgWrap = document.getElementById("nvg-wrap");
  if (nvgWrap) nvgWrap.style.background = nightMode ? "rgba(5,5,5,0.95)" : "rgba(20,20,20,0.85)";

  // Imagery layer dimming
  const layer = viewer.imageryLayers.get(0);
  if (layer) {
    layer.brightness = nightMode ? 0.3 : 1.0;
    layer.contrast = nightMode ? 0.99 : 1.0;
    layer.saturation = nightMode ? 0.0 : 1.0;
    //layer.hue = nightMode ? 1.2 : 0.0;
    //layer.gamma = nightMode ? 1.0 : 0.8;
  }
  if (heatmapLayer) {
    heatmapLayer.brightness = nightMode ? 1.2 : 1.0;
    heatmapLayer.saturation = 1.1;
    updateHeatmapLayer();
  }

  // Scene atmosphere
  const scene = viewer.scene;
  scene.skyAtmosphere.show = !nightMode;
  scene.sun.show = !nightMode;
  scene.moon.show = !nightMode;
  scene.backgroundColor = nightMode ? Cesium.Color.BLACK : new Cesium.Color(0, 0, 0, 1);

  // UI panel styling
  const darkBg = "rgba(5,5,5,0.95)";
  const normalBg = "rgba(20,20,20,0.85)";
  for (const id of ["other-units-toolbar", "floor-slider-widget", "heatmap-controls"]) {
    const el = document.getElementById(id);
    if (el) el.style.background = nightMode ? darkBg : normalBg;
  }
  const claude = document.getElementById("claude-panel");
  if (claude) {
    claude.style.background = nightMode ? "rgba(0,0,0,0.88)" : "";
    claude.style.borderColor = nightMode ? "rgba(180,160,140,0.4)" : "";
  }

  // Slider thumb, track fill, and active buttons → green in night mode
  const accentColor = nightMode ? NIGHT_GREEN : BLUE;
  const hoverColor = nightMode ? "#303077" : "#4060FF";
  const progressColor = nightMode ? NIGHT_GREEN : BLUE;
  const sliderStyle = document.getElementById("floor-slider-style");
  if (sliderStyle) {
    sliderStyle.textContent = `
      #floor-level-slider::-webkit-slider-runnable-track {
        width: 10px; background: rgba(255,255,255,0.1); border-radius: 0px;
      }
      #floor-level-slider::-webkit-slider-thumb {
        -webkit-appearance: none; width: 70px; height: 40px;
        background: ${accentColor}; border: none; border-radius: 6px;
        cursor: pointer; margin-left: -32px;
      }
      #floor-level-slider::-webkit-slider-thumb:hover { background: ${hoverColor}; }
      #floor-level-slider::-moz-range-track {
        width: 10px; background: rgba(255,255,255,0.2); border-radius: 3px; border: none;
      }
      #floor-level-slider::-moz-range-progress { background: ${progressColor}; border-radius: 3px; }
      #floor-level-slider::-moz-range-thumb {
        width: 70px; height: 40px; background: ${accentColor};
        border: none; border-radius: 6px; cursor: pointer;
      }
      #floor-level-slider::-moz-range-thumb:hover { background: ${hoverColor}; }
    `;
  }
  const trackFill = document.getElementById("floor-slider-fill");
  if (trackFill) trackFill.style.background = accentColor;

  // Update reset button colors
  updateResetButton();

  // Update other-unit buttons that are active
  const activeTextColor = nightMode ? "#000" : "#fff";
  for (const type of OTHER_UNIT_TYPES) {
    const btn = document.getElementById("other-unit-btn-" + type);
    if (btn && otherUnitTypeVisible[type]) {
      btn.style.background = accentColor;
      btn.style.color = activeTextColor;
    }
  }
  applyOtherUnitVisibility();

  // Slider thumb label
  const thumbLabel = document.getElementById("val-floor-level");
  if (thumbLabel) thumbLabel.style.color = nightMode ? "rgba(255,255,255,0.4)" : "#fff";

  // Re-tint all visible billboards
  function retintEntity(entity) {
    if (!entity || !entity.billboard) return;
    const cp = entity.billboard.color;
    if (!cp) { setEntityAlpha(entity, 1); return; }
    const c = cp.getValue ? cp.getValue(Cesium.JulianDate.now()) : cp;
    setEntityAlpha(entity, c ? c.alpha : 1);
  }
  for (const node of allNodes) {
    retintEntity(entitiesById[node.id]);
    retintEntity(cmdEntitiesById[node.id]);
    const staffEs = staffEntitiesById[node.id];
    if (staffEs) for (const se of staffEs) retintEntity(se);
  }
  for (const entity of otherUnitEntities) retintEntity(entity);

  playBeep(nightMode ? 300 : 500, 0.06);
}

function createHeatmapControls() {
  const container = document.getElementById("cesiumContainer");
  if (!container) return;

  const panel = document.createElement("div");
  panel.id = "heatmap-controls";
  panel.style.cssText = "position:absolute;top:10px;right:10px;background:rgba(30,30,30,0.85);color:#fff;padding:12px;border-radius:6px;font-family:sans-serif;font-size:12px;z-index:100;display:none;";

  function makeSlider(label, min, max, step, initial, onChange) {
    const row = document.createElement("div");
    row.style.cssText = "margin-bottom:8px;";
    row.innerHTML = `<div style="margin-bottom:2px;">${label}: <span id="val-${label}">${initial}</span></div>`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = initial;
    input.style.width = "120px";
    input.oninput = () => {
      const val = parseFloat(input.value);
      document.getElementById(`val-${label}`).textContent = val;
      onChange(val);
    };
    input.onchange = () => {
      updateHeatmapLayer();
    };
    row.appendChild(input);
    panel.appendChild(row);
  }

  makeSlider("Min Radius", 1, 30, 1, heatmapMinRadius, v => heatmapMinRadius = v);
  makeSlider("Max Radius", 10, 200, 1, heatmapMaxRadius, v => heatmapMaxRadius = v);
  makeSlider("Min Alpha", 0.01, 1, 0.01, heatmapMinAlpha, v => heatmapMinAlpha = v);
  makeSlider("Max Alpha", 0.01, 1, 0.01, heatmapMaxAlpha, v => heatmapMaxAlpha = v);
  makeSlider("Gradient Mid", 0.1, 0.9, 0.05, heatmapGradientMid, v => heatmapGradientMid = v);
  makeSlider("Grid Size", 16, 128, 1, heatmapGridSize, v => heatmapGridSize = v);
  makeSlider("Hue", 200, 260, 1, heatmapHue, v => heatmapHue = v);
  makeSlider("Saturation", 35, 100, 1, heatmapSaturation, v => heatmapSaturation = v);
  makeSlider("Lightness", 20, 70, 1, heatmapLightness, v => heatmapLightness = v);

  const labelHeader = document.createElement("div");
  labelHeader.style.cssText = "margin-top:12px;padding-top:8px;border-top:1px solid #555;font-weight:bold;";
  labelHeader.textContent = "Label Declutter";
  panel.appendChild(labelHeader);

  makeSlider("Cell Width", 4, 40, 1, LABEL_CELL_W, v => LABEL_CELL_W = v);
  makeSlider("Cell Height", 4, 40, 1, LABEL_CELL_H, v => LABEL_CELL_H = v);
  makeSlider("Hysteresis", 0, 0.49, 0.01, LABEL_HYSTERESIS, v => LABEL_HYSTERESIS = v);
  makeSlider("Settle (ms)", 100, 500, 10, LABEL_SETTLE_MS, v => LABEL_SETTLE_MS = v);

  const blendModes = [
    "source-over", 
    "destination-over", 
    "lighter", "xor",
    "multiply", "screen", "overlay", "darken", 
    "color-dodge", "color-burn", "hard-light", "soft-light",
    "difference", "exclusion", "hue", "saturation", "color", "luminosity"
  ];
  const blendRow = document.createElement("div");
  blendRow.style.cssText = "margin-top:8px;";
  blendRow.innerHTML = `<div style="margin-bottom:4px;">Blend Mode</div>`;
  let btnGroup = document.createElement("div");
  btnGroup.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;";
  for (const mode of blendModes) {
    if (btnGroup.children.length >= 2) {
      blendRow.appendChild(btnGroup);
      btnGroup = document.createElement("div");
      btnGroup.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;";
    }
    const btn = document.createElement("button");
    btn.textContent = mode;
    btn.style.cssText = "padding:4px 8px;background:#444;border:1px solid #666;color:#fff;cursor:pointer;";
    if (mode === heatmapBlendMode) {
      btn.style.background = "#1e50ff";
      btn.style.borderColor = "#1e50ff";
    }
    btn.onclick = () => {
      heatmapBlendMode = mode;
      Array.from(blendRow.querySelectorAll("button")).forEach(b => {
        b.style.background = "#444";
        b.style.borderColor = "#666";
      });
      btn.style.background = "#1e50ff";
      btn.style.borderColor = "#1e50ff";
      updateHeatmapLayer();
    };
    btnGroup.appendChild(btn);
  }
  if (btnGroup.children.length > 0) {
    blendRow.appendChild(btnGroup);
  }
  panel.appendChild(blendRow);

  container.appendChild(panel);
}

function getHeatmapPositions() {
  // Include humans whose billboard is NOT currently visible
  const results = [];
  for (const node of allNodes) {
    // Individuals
    if (node.type === "individual") {
      const entity = entitiesById[node.id];
      if (!entity || !entity.show) {
        results.push({ position: node.position });
      }
      continue;
    }
    // Commander
    if (node.commander && node.commander.position) {
      const cmdE = cmdEntitiesById[node.id];
      if (!cmdE || !cmdE.show) {
        results.push({ position: node.commander.position });
      }
    }
    // Staff
    if (node.staff) {
      const staffEs = staffEntitiesById[node.id];
      for (let i = 0; i < node.staff.length; i++) {
        const visible = staffEs && staffEs[i] && staffEs[i].show;
        if (!visible) {
          results.push({ position: node.staff[i].position });
        }
      }
    }
  }
  return results;
}

// Heatmap canvas rendering
function renderHeatmapCanvas(positions) {
  if (!heatmapCanvas) {
    heatmapCanvas = document.createElement("canvas");
    heatmapCanvas.width = HEATMAP_CANVAS_SIZE;
    heatmapCanvas.height = HEATMAP_CANVAS_SIZE;
  }
  const ctx = heatmapCanvas.getContext("2d");
  const W = HEATMAP_CANVAS_SIZE;

  // Compute lat/lon bounds with padding
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of positions) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const latSpan = maxLat - minLat || 0.01;
  const lonSpan = maxLon - minLon || 0.01;
  const pad = 0.15;
  minLat -= latSpan * pad;
  maxLat += latSpan * pad;
  minLon -= lonSpan * pad;
  maxLon += lonSpan * pad;

  ctx.clearRect(0, 0, W, W);
  ctx.globalCompositeOperation = heatmapBlendMode;

  // Pre-compute canvas coordinates
  const lonRange = maxLon - minLon;
  const latRange = maxLat - minLat;
  const pts = positions.map(p => ({
    x: ((p.lon - minLon) / lonRange) * W,
    y: ((maxLat - p.lat) / latRange) * W,
  }));

  // Grid-based local density: count neighbors in each cell
  const GRID_SIZE = heatmapGridSize;
  const cellW = W / GRID_SIZE;
  const grid = new Uint16Array(GRID_SIZE * GRID_SIZE);
  for (const pt of pts) {
    const gx = Math.min(GRID_SIZE - 1, Math.floor(pt.x / cellW));
    const gy = Math.min(GRID_SIZE - 1, Math.floor(pt.y / cellW));
    grid[gy * GRID_SIZE + gx]++;
  }
  // For each point, sum its cell + 8 neighbors for smooth density
  function localDensity(px, py) {
    const gx = Math.min(GRID_SIZE - 1, Math.floor(px / cellW));
    const gy = Math.min(GRID_SIZE - 1, Math.floor(py / cellW));
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx, ny = gy + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
          count += grid[ny * GRID_SIZE + nx];
        }
      }
    }
    return count;
  }

  // Radius: large for isolated points, small for dense clusters
  // Alpha: low for dense clusters (individuals), high for isolated points (commanders)
  const MIN_RADIUS = heatmapMinRadius;
  const MAX_RADIUS = heatmapMaxRadius;
  const ALPHA_CENTER_MIN = heatmapMinAlpha;
  const ALPHA_CENTER_MAX = heatmapMaxAlpha;

  for (const pt of pts) {
    const density = localDensity(pt.x, pt.y);
    const densityFactor = 1 / Math.sqrt(Math.max(1, density));
    const radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, MAX_RADIUS * densityFactor));
    const alphaCenter = ALPHA_CENTER_MIN + (ALPHA_CENTER_MAX - ALPHA_CENTER_MIN) * densityFactor;
    const alphaMid = alphaCenter * heatmapGradientMid;
    const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radius);
    const hsla = (a) => `hsla(${heatmapHue}, ${heatmapSaturation}%, ${heatmapLightness}%, ${a})`;
    grad.addColorStop(0, hsla(alphaCenter));
    grad.addColorStop(heatmapGradientMid, hsla(alphaMid));
    grad.addColorStop(1, hsla(0));
    ctx.fillStyle = grad;
    ctx.fillRect(pt.x - radius, pt.y - radius, radius * 2, radius * 2);
  }

  ctx.globalCompositeOperation = "source-over";
  return {
    west: Cesium.Math.toRadians(minLon),
    south: Cesium.Math.toRadians(minLat),
    east: Cesium.Math.toRadians(maxLon),
    north: Cesium.Math.toRadians(maxLat),
  };
}

function updateCesiumHeatmapLayer() {
  const viewer = moduleViewer;
  if (!viewer) return;

  // Cancel any pending crossfade swap
  if (heatmapSwapTimer) { clearTimeout(heatmapSwapTimer); heatmapSwapTimer = null; }
  // Immediately show current layer if swap was pending
  if (heatmapLayer) heatmapLayer.alpha = 1.0;
  if (oldHeatmap) { viewer.imageryLayers.remove(oldHeatmap, false); oldHeatmap = null; }

  if (!militaryVisible) {
    if (heatmapLayer) {
      viewer.imageryLayers.remove(heatmapLayer, false);
      heatmapLayer = null;
    }
    return;
  }

  const positions = getHeatmapPositions().map(e => e.position);
  if (positions.length === 0) {
    if (heatmapLayer) {
      viewer.imageryLayers.remove(heatmapLayer, false);
      heatmapLayer = null;
    }
    return;
  }

  // Compute bounds
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of positions) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const latSpan = maxLat - minLat || 0.01;
  const lonSpan = maxLon - minLon || 0.01;
  const pad = 0.15;
  minLat -= latSpan * pad;
  maxLat += latSpan * pad;
  minLon -= lonSpan * pad;
  maxLon += lonSpan * pad;

  // Render canvas
  renderHeatmapCanvas(positions);

  // Create new layer
  const provider = new Cesium.SingleTileImageryProvider({
    url: heatmapCanvas.toDataURL() + "?v=" + (++heatmapUrlCounter),
    rectangle: new Cesium.Rectangle(
      Cesium.Math.toRadians(minLon),
      Cesium.Math.toRadians(minLat),
      Cesium.Math.toRadians(maxLon),
      Cesium.Math.toRadians(maxLat)
    ),
    tileWidth: HEATMAP_CANVAS_SIZE,
    tileHeight: HEATMAP_CANVAS_SIZE,
  });

  // save previous heatmap so we can remove it later
  oldHeatmap = heatmapLayer;

  heatmapLayer = viewer.imageryLayers.addImageryProvider(provider);
  heatmapLayer.alpha = 0.0;
  if (nightMode) {
    heatmapLayer.brightness = 0.5;
    heatmapLayer.saturation = 0.3;
  }

  heatmapSwapTimer = setTimeout(swapHeatmaps, 500);
}

function updateHeatmapLayer() {
  const viewer = moduleViewer;
  if (!viewer) return;

  updateCesiumHeatmapLayer();
}

function levelFromCameraHeight(height) {
  // Convert absolute height to height above ground level
  if (moduleViewer) {
    const carto = moduleViewer.camera.positionCartographic;
    const terrainHeight = moduleViewer.scene.globe.getHeight(carto);
    if (terrainHeight !== undefined) {
      height = height - terrainHeight;
    }
  }
  // const el = document.getElementById("val-camera-agl");
  // if (el) el.textContent = Math.round(height) + "m";
  for (const t of LEVEL_THRESHOLDS) {
    // Hysteresis: require 10% overshoot to change level
    if (autoCurrentLevel > t.level) {
      // zooming in — need to go 10% below threshold to drop
      if (height > t.minHeight * 0.9) return t.level;
    } else if (autoCurrentLevel < t.level) {
      // zooming out — need to go 10% above threshold to rise
      if (height > t.minHeight * 1.1) return t.level;
    } else {
      if (height >= t.minHeight) return t.level;
    }
  }
  return 0;
}

function hasManuallyExpandedAncestor(node) {
  let n = node.parent;
  while (n) {
    if (manuallyExpanded.has(n.id)) return true;
    n = n.parent;
  }
  return false;
}

function clearDescendantOverrides(node) {
  for (const child of node.children) {
    manuallyExpanded.delete(child.id); updateResetButton();
    clearDescendantOverrides(child);
  }
}

function applyAutoLevel(targetLevel) {
  const effectiveLevel = Math.max(targetLevel, floorLevel);
  if (effectiveLevel === autoCurrentLevel) return;
  const direction = effectiveLevel < autoCurrentLevel ? 1 : -1; // 1 = zooming in (lower level), -1 = zooming out
  autoCurrentLevel = effectiveLevel;
  currentLevel = effectiveLevel;
  playLevelTick(effectiveLevel, direction);

  for (const node of allNodes) {
    const nodeLevelIdx = LEVEL_ORDER.indexOf(node.type);
    // Skip nodes with manual override or whose ancestor was manually expanded
    if (manuallyExpanded.has(node.id) || hasManuallyExpandedAncestor(node)) continue;

    const entity = entitiesById[node.id];
    entity.show = militaryVisible && nodeLevelIdx >= effectiveLevel;
    entity.position = node.homePosition;
  }

  // Commander/staff visibility
  hideAllCmdStaff();
  if (militaryVisible) {
    for (const node of allNodes) {
      if (manuallyExpanded.has(node.id) || hasManuallyExpandedAncestor(node)) continue;
      const nodeLevelIdx = LEVEL_ORDER.indexOf(node.type);
      if (nodeLevelIdx > effectiveLevel) {
        // Commanders always visible when expanded, staff only at squad level or below
        const cmdE = cmdEntitiesById[node.id];
        if (cmdE) {
          cmdE.show = true;
          cmdE.position = node.cmdHomePosition;
          setEntityAlpha(cmdE, 1);
          const unitE = entitiesById[node.id];
          if (unitE) unitE._labelHidden = true;
        }
        if (effectiveLevel <= 1) {
          const staffEs = staffEntitiesById[node.id];
          if (staffEs) {
            for (let i = 0; i < staffEs.length; i++) {
              staffEs[i].show = true;
              setEntityAlpha(staffEs[i], 1);
              if (node.staffHomePositions) staffEs[i].position = node.staffHomePositions[i];
            }
          }
        }
      }
    }
    // Re-show cmd/staff for manually expanded nodes
    for (const nodeId of manuallyExpanded) {
      const node = allNodes.find(n => n.id === nodeId);
      if (node) {
        const cmdE = cmdEntitiesById[node.id];
        if (cmdE) {
          cmdE.show = true;
          cmdE.position = node.cmdHomePosition;
          setEntityAlpha(cmdE, 1);
          const unitE = entitiesById[node.id];
          if (unitE) unitE._labelHidden = true;
        }
        const childLevel = node.children && node.children[0] ? LEVEL_ORDER.indexOf(node.children[0].type) : 99;
        if (childLevel <= 1 || effectiveLevel <= 1) {
          const staffEs = staffEntitiesById[node.id];
          if (staffEs) {
            for (let i = 0; i < staffEs.length; i++) {
              staffEs[i].show = true;
              setEntityAlpha(staffEs[i], 1);
              if (node.staffHomePositions) staffEs[i].position = node.staffHomePositions[i];
            }
          }
        }
      }
    }
  }

  updateHeatmapLayer();
  labelStates.clear();
}

function showLevel(levelIdx) {
  // Show all levels from brigade (top) down to the selected level
  for (const node of allNodes) {
    const entity = entitiesById[node.id];
    const nodeLevelIdx = LEVEL_ORDER.indexOf(node.type);
    entity.show = militaryVisible && nodeLevelIdx >= levelIdx;
    entity.position = node.homePosition;
  }
  // Commander/staff: visible for units whose children are also visible
  // (i.e. all levels above the lowest visible level)
  hideAllCmdStaff();
  if (militaryVisible) {
    for (const node of allNodes) {
      const nodeLevelIdx = LEVEL_ORDER.indexOf(node.type);
      if (nodeLevelIdx > levelIdx) {
        setCmdStaffShow(node, true);
      }
    }
  }
  updateHeatmapLayer();
  labelStates.clear();
}

// --- Click toggle ---

function resolvePickedEntity(viewer, click) {
  if (animating) return null;
  // Use drillPick to see through non-pickable overlay entities (dots, dot-lines)
  const picks = viewer.scene.drillPick(click.position);
  for (const picked of picks) {
    if (!(picked.id instanceof Cesium.Entity)) continue;
    let entity = picked.id;
    return entity;
  }
  return null;
}

function pickMilNode(viewer, click) {
  const entity = resolvePickedEntity(viewer, click);
  if (!entity) return null;
  // Commander click: already unmerged, no-op for left click
  if (entity._milCmdOf || entity._milStaffOf) return null;
  const node = entity._milNode;
  if (!node || node.children.length === 0) return null;
  const childType = LEVEL_ORDER[LEVEL_ORDER.indexOf(node.type) - 1];
  if (!childType) return null;
  return { entity, node, childType };
}

export function handleRightClick(viewer, click) {
  const entity = resolvePickedEntity(viewer, click);
  if (!entity) return false;
  // Right click only merges — eat event for any military entity
  if (!entity._milNode && !entity._milCmdOf && !entity._milStaffOf) return false;

  // Support right-clicking a commander entity to merge its children
  let node = entity._milNode;
  let cmdOfNode = entity._milCmdOf || entity._milStaffOf;
  if (cmdOfNode) {
    // Right-clicked a commander — treat as merging this unit's children
    const parentNode = cmdOfNode;
    const parentEntity = entitiesById[parentNode.id];

    const anims = [];
    // Animate ALL visible descendants (handles exploded sub-levels too)
    animateMergeAllDescendants(parentNode, parentNode.homePosition, anims);

    parentEntity.position = parentNode.homePosition;
    anims.push({
      entity: parentEntity,
      from: parentNode.homePosition,
      to: parentNode.homePosition,
      duration: 400,
      fade: "in",
      onComplete: () => { parentEntity.position = parentNode.homePosition; },
    });

    // Fade OUT merge target's own commander/staff
    const cmdE = cmdEntitiesById[parentNode.id];
    if (cmdE && cmdE.show) {
      anims.push({
        entity: cmdE,
        from: parentNode.cmdHomePosition,
        to: parentNode.cmdHomePosition,
        duration: 400,
        fade: "out",
        onComplete: () => { cmdE.show = false; parentEntity._labelHidden = false; },
      });
    }
    const staffEs = staffEntitiesById[parentNode.id];
    if (staffEs && parentNode.staffHomePositions) {
      for (let si = 0; si < staffEs.length; si++) {
        const se = staffEs[si];
        if (se.show) {
          anims.push({
            entity: se,
            from: parentNode.staffHomePositions[si],
            to: parentNode.staffHomePositions[si],
            duration: 400,
            fade: "out",
            onComplete: () => { se.show = false; },
          });
        }
      }
    }

    if (anims.length > 0) {
      playBeep(MERGE_BEEP_FREQ);
      startAnimations(anims);
      manuallyExpanded.delete(parentNode.id); updateResetButton();
      clearDescendantOverrides(parentNode);
    }
    return true;
  }

  if (!node || node.children.length === 0) return true; // no descendants to merge, eat event

  const anims = [];
  // Animate ALL visible descendants back into this node
  animateMergeAllDescendants(node, node.homePosition, anims);

  // Fade IN the unit entity if it was hidden (from a previous unmerge)
  const unitEntity = entitiesById[node.id];
  if (unitEntity && !unitEntity.show) {
    unitEntity.position = node.homePosition;
    anims.push({
      entity: unitEntity,
      from: node.homePosition,
      to: node.homePosition,
      duration: 400,
      fade: "in",
      onComplete: () => { unitEntity.position = node.homePosition; },
    });
  }

  // Fade OUT this node's own commander/staff (commander disappears, unit symbol returns)
  const cmdE = cmdEntitiesById[node.id];
  if (cmdE && cmdE.show) {
    anims.push({
      entity: cmdE,
      from: node.cmdHomePosition,
      to: node.cmdHomePosition,
      duration: 400,
      fade: "out",
      onComplete: () => { cmdE.show = false; unitEntity._labelHidden = false; },
    });
  }
  const staffEs = staffEntitiesById[node.id];
  if (staffEs && node.staffHomePositions) {
    for (let si = 0; si < staffEs.length; si++) {
      const se = staffEs[si];
      if (se.show) {
        anims.push({
          entity: se,
          from: node.staffHomePositions[si],
          to: node.staffHomePositions[si],
          duration: 400,
          fade: "out",
          onComplete: () => { se.show = false; },
        });
      }
    }
  }

  if (anims.length > 0) {
    playBeep(MERGE_BEEP_FREQ);
    startAnimations(anims);
    manuallyExpanded.delete(node.id); updateResetButton();
    clearDescendantOverrides(node);
  }
  return true;
}

function picksMilEntity(viewer, click) {
  const entity = resolvePickedEntity(viewer, click);
  if (!entity) return false;
  return !!(entity._milNode || entity._milCmdOf || entity._milStaffOf);
}

export function handleLeftClick(viewer, click) {
  if (!picksMilEntity(viewer, click)) return false;
  // Always eat the event for military entities — left click only unmerges
  const hit = pickMilNode(viewer, click);
  if (!hit) return true; // can't unmerge, but still eat event

  const { entity, node, childType } = hit;
  const firstChild = node.children[0];
  const childEntity = entitiesById[firstChild.id];
  if (childEntity.show) return true; // children already visible, can't unmerge further

  const anims = [];
  anims.push({
    entity,
    from: node.homePosition,
    to: node.homePosition,
    duration: 400,
    fade: "out",
    onComplete: () => {
      entity.show = false;
      entity.position = node.homePosition;
    },
  });
  forEachDescendantAtLevel(node, childType, (desc) => {
    const e = entitiesById[desc.id];
    anims.push({
      entity: e,
      from: desc.homePosition,
      to: desc.homePosition,
      duration: 400,
      fade: "in",
      onComplete: () => {
        e.position = desc.homePosition;
      },
    });
  });

  // Fade IN commander/staff for this node (commander replaces unit symbol)
  const cmdE = cmdEntitiesById[node.id];
  if (cmdE) {
    cmdE.position = node.cmdHomePosition;
    anims.push({
      entity: cmdE,
      from: node.cmdHomePosition,
      to: node.cmdHomePosition,
      duration: 400,
      fade: "in",
      onComplete: () => { cmdE.position = node.cmdHomePosition; },
    });
  }
  const staffEs = staffEntitiesById[node.id];
  const childLevelIdx = LEVEL_ORDER.indexOf(childType);
  if (staffEs && node.staffHomePositions && childLevelIdx <= 1) {
    for (let si = 0; si < staffEs.length; si++) {
      const se = staffEs[si];
      se.position = node.staffHomePositions[si];
      anims.push({
        entity: se,
        from: node.staffHomePositions[si],
        to: node.staffHomePositions[si],
        duration: 400,
        fade: "in",
        onComplete: () => { se.position = node.staffHomePositions[si]; },
      });
    }
  }

  if (anims.length > 0) {
    playBeep(UNMERGE_BEEP_FREQ);
    startAnimations(anims);
    manuallyExpanded.add(node.id); updateResetButton();
  }
  return true;
}

export function handleDoubleClick(viewer, click) {
  // Pick directly — bypass animating guard since single-click may have started an animation
  const picks = viewer.scene.drillPick(click.position);
  let entity = null;
  for (const picked of picks) {
    if (!(picked.id instanceof Cesium.Entity)) continue;
    const e = picked.id;
    entity = e;
    break;
  }
  if (!entity) return false;
  const node = entity._milNode || entity._milCmdOf || entity._milStaffOf;
  if (!node || node.children.length === 0) return false;

  // Finish any in-progress animations immediately
  if (animating) {
    for (const a of animations) {
      if (a.fade) setEntityAlpha(a.entity, 1);
      if (a.onComplete) a.onComplete();
      a.entity.position = a.to;
    }
    animations.length = 0;
    animating = false;
    updateHeatmapLayer();
  }

  // Collect positions of all leaf descendants
  const positions = [];
  function collectLeaves(n) {
    if (n.children.length === 0) {
      positions.push(n.homePosition);
    } else {
      for (const c of n.children) collectLeaves(c);
    }
    if (n.commander) positions.push(n.cmdHomePosition || Cesium.Cartesian3.fromDegrees(
      n.commander.position.lon, n.commander.position.lat, n.commander.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN));
  }
  collectLeaves(node);

  if (positions.length === 0) return false;
  viewer.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(positions), { duration: 1.0 });
  return true;
}

function forEachDescendantAtLevel(node, type, fn) {
  for (const child of node.children) {
    if (child.type === type) {
      fn(child);
    } else {
      forEachDescendantAtLevel(child, type, fn);
    }
  }
}

// Collect animations to merge ALL visible descendants (at any level) back to targetPos.
// This handles cases where deeper levels have been exploded (e.g. individuals under an exploded squad).
function animateMergeAllDescendants(node, targetPos, anims) {
  for (const child of node.children) {
    const e = entitiesById[child.id];
    if (e && e.show) {
      anims.push({
        entity: e,
        from: child.homePosition,
        to: child.homePosition,
        duration: 400,
        fade: "out",
        onComplete: () => {
          e.show = false;
          e.position = child.homePosition;
        },
      });
    }
    // Hide commander/staff of this child if visible
    const cmdE = cmdEntitiesById[child.id];
    if (cmdE && cmdE.show) {
      anims.push({
        entity: cmdE,
        from: child.cmdHomePosition,
        to: child.cmdHomePosition,
        duration: 400,
        fade: "out",
        onComplete: () => { cmdE.show = false; },
      });
    }
    const staffEs = staffEntitiesById[child.id];
    if (staffEs && child.staffHomePositions) {
      for (let si = 0; si < staffEs.length; si++) {
        const se = staffEs[si];
        if (se.show) {
          anims.push({
            entity: se,
            from: child.staffHomePositions[si],
            to: child.staffHomePositions[si],
            duration: 400,
            fade: "out",
            onComplete: () => { se.show = false; },
          });
        }
      }
    }
    animateMergeAllDescendants(child, targetPos, anims);
  }
}

// --- Zoom listener ---

let cameraMoving = false;
let cameraSettleTimer = null;

export function setupZoomListener(viewer) {
  viewer.camera.changed.addEventListener(() => {
    cameraMoving = true;
    // Update AGL display in real-time
    levelFromCameraHeight(viewer.camera.positionCartographic.height);
    if (cameraSettleTimer) clearTimeout(cameraSettleTimer);
    cameraSettleTimer = setTimeout(() => {
      cameraMoving = false;
      if (autoLevelEnabled) {
        const height = viewer.camera.positionCartographic.height;
        applyAutoLevel(levelFromCameraHeight(height));
      }
      applyOtherUnitVisibility();
    }, LABEL_SETTLE_MS);
    // Update camera height display
    const h = viewer.camera.positionCartographic.height;
  });
  viewer.camera.percentageChanged = 0.1;
}

export function swapHeatmaps()
{
    heatmapSwapTimer = null;
    if (heatmapLayer) heatmapLayer.alpha = 1.0;
    if (oldHeatmap) moduleViewer.imageryLayers.remove(oldHeatmap, false);
    oldHeatmap = null;
}

// --- Keyboard ---

export function handleKeydown(event, viewer) {
  if (event.key === "m" || event.key === "M") {
    if (movementEnabled) {
      stopMoveUnits();
    } else {
      startMoveUnits();
    }
    movementEnabled = !movementEnabled;
    return true;
  }

  if (event.key === "l" || event.key === "L") {
    labelsEnabled = !labelsEnabled;
    // Reset label states so declutter recalculates fresh when re-enabled
    labelStates.clear();
    return true;
  }

  // Number keys 1-7: set floor level (1=individual, 2=squad, ..., 7=brigade)
  const digit = parseInt(event.key, 10);
  if (digit >= 1 && digit <= LEVEL_ORDER.length) {
    floorLevel = digit - 1;
    playFloorClick(floorLevel);
    manuallyExpanded.clear(); updateResetButton();
    // Update slider UI if it exists
    const slider = document.getElementById("floor-level-slider");
    if (slider) {
      slider.value = 6 - floorLevel;
      // Reposition thumb label
      const frac = (6 - floorLevel) / 6;
      const lbl = document.getElementById("val-floor-level");
      if (lbl) {
        lbl.textContent = LEVEL_ORDER[floorLevel];
        lbl.style.top = (frac * (250 - 40) + 20) + "px";
      }
    }
    // Trigger auto level with current camera height
    if (autoLevelEnabled && moduleViewer) {
      const height = moduleViewer.camera.positionCartographic.height;
      autoCurrentLevel = -1; // force update
      applyAutoLevel(levelFromCameraHeight(height));
    }
    return true;
  }

  if (event.key === " ") {
    swapHeatmaps();
    return true;
  }

  if (event.key === "h" || event.key === "H") {
    updateHeatmapLayer();
    return true;
  }

  if (event.key === "t" || event.key === "T") {
    sampleTerrainAltitudes(moduleViewer).then(result => {
      if (result && result.avgDiff) {
        console.log(`\n>>> UPDATE RECOMMENDATION: Set GEOID_UNDULATION to ${result.avgDiff.toFixed(2)}`);
      }
    });
    return true;
  }

  if (event.key === "d" || event.key === "D") {
    DEBUG_LABEL_DECLUTTER = !DEBUG_LABEL_DECLUTTER;
    console.log("DEBUG_LABEL_DECLUTTER:", DEBUG_LABEL_DECLUTTER);
    return true;
  }

  if (event.key === "p" || event.key === "P") {
    const panel = document.getElementById("heatmap-controls");
    if (panel) panel.style.display = panel.style.display === "none" ? "" : "none";
    return true;
  }

  return false;
}

// --- Individual movement ---

const MOVE_INTERVAL_MS = 100;
let moveUnitsIntervalId = null;
let moveUnitsCallCount = 0;
let moveUnitsTime = 0;
let movementEnabled = false;

const MOTION_AMPLITUDE_M = 10;
const MOTION_VELOCITY = 1;

const metersPerDegLat = 111320;

function getUnitDirection(unit) {
  const str = unit.name || unit.id || "";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 181;
}

function getUnitAmplitude(unit) {
  const str = unit.name || unit.id || "";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 3) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 2.5 + (Math.abs(hash) % 8);
}

function getUnitVelocity(unit) {
  const str = unit.name || unit.id || "";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 7) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 0.25 + (Math.abs(hash) % 101) / 400;
}

function getMotionOffset(directionDeg, amplitude, velocity, time) {
  const directionRad = directionDeg * Math.PI / 180;
  const offset = amplitude * Math.sin(velocity * time);
  const dlat = offset * Math.cos(directionRad) / metersPerDegLat;
  const dlon = offset * Math.sin(directionRad) / metersPerDegLat;
  return { dlat, dlon };
}

function moveUnits() {
  moveUnitsCallCount++;
  moveUnitsTime += MOVE_INTERVAL_MS / 1000;
  if (moveUnitsCallCount >= 30) {
    moveUnitsCallCount = 0;
    updateHeatmapLayer();
  }

  for (const node of allNodes) {
    if (node.type === "individual" && node.position) {
      const direction = getUnitDirection(node);
      const amplitude = getUnitAmplitude(node);
      const velocity = getUnitVelocity(node);
      const { dlat, dlon } = getMotionOffset(direction, amplitude, velocity, moveUnitsTime);
      node.position.lat += dlat;
      node.position.lon += dlon;
      const entity = entitiesById[node.id];
      if (entity) {
        entity.position = Cesium.Cartesian3.fromDegrees(
          node.position.lon, node.position.lat, node.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
        );
      }
    }
    if (node.commander && node.commander.position) {
      const direction = getUnitDirection(node.commander);
      const amplitude = getUnitAmplitude(node.commander);
      const velocity = getUnitVelocity(node.commander);
      const { dlat, dlon } = getMotionOffset(direction, amplitude, velocity, moveUnitsTime);
      node.commander.position.lat += dlat;
      node.commander.position.lon += dlon;
      const cmdE = cmdEntitiesById[node.id];
      if (cmdE && cmdE.show) {
        cmdE.position = Cesium.Cartesian3.fromDegrees(
          node.commander.position.lon, node.commander.position.lat,
          node.commander.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
        );
      }
    }
    if (node.staff) {
      for (let i = 0; i < node.staff.length; i++) {
        const staffPos = node.staff[i];
        if (staffPos.position) {
          const direction = getUnitDirection(staffPos);
          const amplitude = getUnitAmplitude(staffPos);
          const velocity = getUnitVelocity(staffPos);
          const { dlat, dlon } = getMotionOffset(direction, amplitude, velocity, moveUnitsTime);
          staffPos.position.lat += dlat;
          staffPos.position.lon += dlon;
          const staffEs = staffEntitiesById[node.id];
          if (staffEs && staffEs[i] && staffEs[i].show) {
            staffEs[i].position = Cesium.Cartesian3.fromDegrees(
              staffPos.position.lon, staffPos.position.lat,
              staffPos.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
            );
          }
        }
      }
    }
  }

  for (const node of allNodes) {
    if (node.commander) {
      node.homePosition = Cesium.Cartesian3.fromDegrees(
        node.position.lon, node.position.lat, node.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
      );
      const entity = entitiesById[node.id];
      if (entity && entity.show) {
        entity.position = node.homePosition;
      }
    }
  }
}

function startMoveUnits() {
  if (moveUnitsIntervalId) return;
  moveUnitsIntervalId = setInterval(moveUnits, MOVE_INTERVAL_MS);
}

function stopMoveUnits() {
  if (moveUnitsIntervalId) {
    clearInterval(moveUnitsIntervalId);
    moveUnitsIntervalId = null;
  }
}

const MOVE_DISTANCE_M = 45;

function perturbPosition(pos) {
  const latRad = pos.lat * Math.PI / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(latRad);
  const dlat = (Math.random() - 0.5) * 2 * MOVE_DISTANCE_M / metersPerDegLat;
  const dlon = (Math.random() - 0.5) * 2 * MOVE_DISTANCE_M / metersPerDegLon;
  pos.lat += dlat;
  pos.lon += dlon;
}

let moveIntervalId = null;

export function startIndividualMovement() {
  if (moveIntervalId) return;
  moveIntervalId = setInterval(() => {
    for (const node of allNodes) {
      if (node.type === "individual") {
        perturbPosition(node.position);
        const entity = entitiesById[node.id];
        if (entity) {
          entity.position = Cesium.Cartesian3.fromDegrees(
            node.position.lon, node.position.lat, node.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
          );
        }
      }
      const cmdE = cmdEntitiesById[node.id];
      if (cmdE && cmdE.show && node.commander) {
        const cmdPos = node.commander.position;
        perturbPosition(cmdPos);
        cmdE.position = Cesium.Cartesian3.fromDegrees(
          cmdPos.lon, cmdPos.lat, cmdPos.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
        );
      }
      const staffEs = staffEntitiesById[node.id];
      if (staffEs && node.staff && node.staffHomePositions) {
        for (let i = 0; i < staffEs.length; i++) {
          if (staffEs[i].show) {
            const staffPos = node.staff[i].position;
            perturbPosition(staffPos);
            staffEs[i].position = Cesium.Cartesian3.fromDegrees(
              staffPos.lon, staffPos.lat, staffPos.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
            );
          }
        }
      }
    }
    // Unit positions follow their commander (node.position === node.commander.position)
    for (const node of allNodes) {
      if (node.commander) {
        node.homePosition = Cesium.Cartesian3.fromDegrees(
          node.position.lon, node.position.lat, node.position.alt + GEOID_UNDULATION + HEIGHT_ABOVE_TERRAIN
        );
        node.cmdHomePosition = node.homePosition;
        const entity = entitiesById[node.id];
        if (entity) {
          entity.position = node.homePosition;
        }
      }
    }
  }, MOVE_INTERVAL_MS);
}

export function stopIndividualMovement() {
  if (moveIntervalId) {
    clearInterval(moveIntervalId);
    moveIntervalId = null;
  }
}

// --- Terrain altitude comparison ---

export async function sampleTerrainAltitudes(viewer) {
  const terrainProvider = viewer.terrainProvider;
  const positions = [];
  for (const node of allNodes) {
    if (node.position) {
      positions.push({
        id: node.id,
        name: node.name,
        type: node.type,
        lat: node.position.lat,
        lon: node.position.lon,
        jsonAlt: node.position.alt,
        cartographic: Cesium.Cartographic.fromDegrees(node.position.lon, node.position.lat),
      });
    }
    if (node.commander && node.commander.position) {
      positions.push({
        id: node.commander.id,
        name: node.commander.name,
        type: "commander",
        lat: node.commander.position.lat,
        lon: node.commander.position.lon,
        jsonAlt: node.commander.position.alt,
        cartographic: Cesium.Cartographic.fromDegrees(node.commander.position.lon, node.commander.position.lat),
      });
    }
    if (node.staff) {
      for (const s of node.staff) {
        positions.push({
          id: s.id,
          name: s.name,
          type: "staff",
          lat: s.position.lat,
          lon: s.position.lon,
          jsonAlt: s.position.alt,
          cartographic: Cesium.Cartographic.fromDegrees(s.position.lon, s.position.lat),
        });
      }
    }
  }

  console.log(`Sampling terrain for ${positions.length} positions...`);
  const cartographics = positions.map(p => p.cartographic);
  const sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, cartographics);

  const results = [];
  const updates = [];
  let totalDiff = 0;
  let count = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const terrainAlt = sampled[i]?.height;
    if (terrainAlt !== undefined) {
      const diff = p.jsonAlt - terrainAlt;
      totalDiff += diff;
      count++;
      results.push({
        id: p.id,
        name: p.name,
        type: p.type,
        lat: p.lat.toFixed(6),
        lon: p.lon.toFixed(6),
        jsonAlt: p.jsonAlt,
        terrainAlt: terrainAlt.toFixed(2),
        diff: diff.toFixed(2),
      });
      updates.push({ id: p.id, newAlt: Math.round(terrainAlt) });
    }
  }

  results.sort((a, b) => parseFloat(b.diff) - parseFloat(a.diff));
  console.log("Altitude comparison (JSON vs Cesium terrain):");
  console.table(results);
  const avgDiff = totalDiff / count;
  console.log(`Average diff (JSON - terrain): ${avgDiff.toFixed(2)}m`);

  // Output JSON patch format for easy file update
  const patch = {};
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const terrainAlt = sampled[i]?.height;
    if (terrainAlt !== undefined) {
      patch[p.id] = Math.round(terrainAlt);
    }
  }
  console.log("\n--- JSON PATCH (replace alt values in military-units.json) ---");
  console.log(JSON.stringify(patch, null, 2));
  console.log("--- END PATCH ---\n");

  return { results, updates, avgDiff };
}

// --- Pre-render hook ---

export function setupPreRender(viewer) {
  viewer.scene.preRender.addEventListener(() => {
    onPreRender();
    // Visual clustering update
    // Label decluttering
    if (!animating && labelsEnabled && militaryVisible) {
      updateLabelDeclutter(viewer);
    }
    // Draw drone arrows on full-opacity canvas
    if (arrowCanvas && arrowCtx) {
      arrowCtx.clearRect(0, 0, arrowCanvas.width, arrowCanvas.height);
      const scene = viewer.scene;
      const camPos = scene.camera.positionWC;
      const isValid = (c) => c && isFinite(c.x) && isFinite(c.y) && isFinite(c.z)
        && (c.x !== 0 || c.y !== 0 || c.z !== 0)
        && Cesium.Cartesian3.distanceSquared(c, camPos) > 1;
      for (let i = 0; i < canvasArrows.length; i++) {
        const a = canvasArrows[i];
        if (a.visible === false) continue;
        if (!isValid(a.base) || !isValid(a.tip)) continue;
        const sBase = scene.cartesianToCanvasCoordinates(a.base);
        const sTip = scene.cartesianToCanvasCoordinates(a.tip);
        if (!sBase || !sTip) continue;
        const dx = sTip.x - sBase.x;
        const dy = sTip.y - sBase.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 2) continue;
        // Draw shaft
        arrowCtx.strokeStyle = a.color;
        arrowCtx.lineWidth = 4;
        arrowCtx.beginPath();
        arrowCtx.moveTo(sBase.x, sBase.y);
        arrowCtx.lineTo(sTip.x, sTip.y);
        arrowCtx.stroke();
        // Draw arrowhead
        const headLen = Math.min(14, len * 0.4);
        const ux = dx / len;
        const uy = dy / len;
        arrowCtx.fillStyle = a.color;
        arrowCtx.beginPath();
        arrowCtx.moveTo(sTip.x, sTip.y);
        arrowCtx.lineTo(sTip.x - headLen * ux + headLen * 0.4 * uy, sTip.y - headLen * uy - headLen * 0.4 * ux);
        arrowCtx.lineTo(sTip.x - headLen * ux - headLen * 0.4 * uy, sTip.y - headLen * uy + headLen * 0.4 * ux);
        arrowCtx.closePath();
        arrowCtx.fill();
      }
      // Draw frustum lines (between arrows and dots), clipped against terrain
      const globe = scene.globe;
      const scratchCarto = new Cesium.Cartographic();
      const scratchLerp = new Cesium.Cartesian3();
      const FRUSTUM_SEGMENTS = 20;
      for (let i = 0; i < canvasFrustumLines.length; i++) {
        const f = canvasFrustumLines[i];
        if (f.visible === false) continue;
        arrowCtx.strokeStyle = f.color;
        arrowCtx.lineWidth = f.width;
        for (let j = 0; j < f.lines.length; j++) {
          const p0 = f.lines[j][0];
          const p1 = f.lines[j][1];
          if (!isValid(p0) || !isValid(p1)) continue;
          // Sample points along the line, draw only above-terrain segments
          let prevScreen = null;
          let prevAbove = false;
          for (let s = 0; s <= FRUSTUM_SEGMENTS; s++) {
            const t = s / FRUSTUM_SEGMENTS;
            Cesium.Cartesian3.lerp(p0, p1, t, scratchLerp);
            Cesium.Cartographic.fromCartesian(scratchLerp, Cesium.Ellipsoid.WGS84, scratchCarto);
            const terrainH = globe.getHeight(scratchCarto);
            const above = terrainH == null || scratchCarto.height >= terrainH - 1;
            const screen = scene.cartesianToCanvasCoordinates(scratchLerp);
            if (screen && prevScreen && above && prevAbove) {
              arrowCtx.beginPath();
              arrowCtx.moveTo(prevScreen.x, prevScreen.y);
              arrowCtx.lineTo(screen.x, screen.y);
              arrowCtx.stroke();
            }
            prevScreen = screen;
            prevAbove = above;
          }
        }
      }
      // Draw indicator dots on top of arrows and frustum lines
      for (let i = 0; i < canvasDots.length; i++) {
        const d = canvasDots[i];
        if (d.visible === false) continue;
        if (!isValid(d.position)) continue;
        const sp = scene.cartesianToCanvasCoordinates(d.position);
        if (!sp) continue;
        const r = d.pixelSize / 2;
        // Outline
        if (d.outlineWidth > 0) {
          arrowCtx.fillStyle = d.outlineColor;
          arrowCtx.beginPath();
          arrowCtx.arc(sp.x, sp.y, r + d.outlineWidth, 0, Math.PI * 2);
          arrowCtx.fill();
        }
        // Fill
        arrowCtx.fillStyle = d.color;
        arrowCtx.beginPath();
        arrowCtx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        arrowCtx.fill();
      }
    }
    // Draw labels on canvas overlay (always on top of billboards)
    if (labelCanvas && labelCtx) {
      labelCtx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
      if (labelsEnabled && !animating) {
        // Debug: draw declutter rects
        if (DEBUG_LABEL_DECLUTTER) {
          labelCtx.lineWidth = 1;
          for (const rect of labelDebugRects) {
            labelCtx.strokeStyle = rect.showing ? "rgba(0,255,0,0.8)" : "rgba(255,0,0,0.8)";
            labelCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
          }
        }
        labelCtx.font = "18px sans-serif";
        labelCtx.textAlign = "center";
        labelCtx.textBaseline = "bottom";
        labelCtx.lineWidth = 3;
        for (const lb of labelDrawList) {
          labelCtx.strokeStyle = "rgba(0,0,0,1)";
          labelCtx.strokeText(lb.text, lb.sx, lb.sy + lb.offsetY);
          labelCtx.fillStyle = nightMode ? "rgb(140,140,140)" : "rgba(255,255,255,1)";
          labelCtx.fillText(lb.text, lb.sx, lb.sy + lb.offsetY);
        }
      }
    }
  });
}
