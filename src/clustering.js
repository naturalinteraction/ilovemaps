import * as Cesium from "cesium";

// --- Symbol rendering ---

const SYMBOL_SIZE = 64;
const BLUE = "#2040FF";

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
      ctx.moveTo(cx, ry + rh);
      ctx.lineTo(cx, ry + rh + 14);
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

// --- Data structures ---

const LEVEL_ORDER = ["individual", "squad", "platoon", "company", "battalion", "regiment", "brigade"];

// All nodes indexed by id
const nodesById = {};
// Flat list of all nodes
let allNodes = [];
// Root node
let rootNode = null;

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
let moduleViewer = null;          // viewer reference for dot updates

// Heatmap state
let oldHeatmap = null;
let heatmapLayer = null;          // Cesium.ImageryLayer
let heatmapCanvas = null;         // offscreen canvas (reused)
const HEATMAP_CANVAS_SIZE = 512;
let heatmapUrlCounter = 0;        // cache-busting counter


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
const LABEL_CELL_W = 8;
const LABEL_CELL_H = 8;
const LABEL_HYSTERESIS = 0.6;

// Label state tracking for hysteresis
const labelStates = new Map(); // entity id -> { showing: bool }

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

// Animation state
const animations = []; // { entity, from, to, startTime, duration, fade, onComplete }
let animating = false;
const WHITE = Cesium.Color.WHITE;

function setEntityAlpha(entity, alpha) {
  // Use small epsilon for billboard to prevent Cesium from skipping fully-transparent billboards
  entity.billboard.color = new Cesium.Color(1, 1, 1, Math.max(alpha, 0.005));
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
    const size = isIndividual ? 40 : SYMBOL_SIZE;

    const entity = viewer.entities.add({
      name: node.name,
      position: node.homePosition,
      billboard: {
        image,
        width: size,
        height: size,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,

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
            width: 48,
            height: 48,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    
          },
          label: {
            text: s.name,
            font: "18px sans-serif",
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineWidth: 2,
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

  updateHeatmapLayer();
  // startIndividualMovement(); // temporarily disabled
  return { entitiesById, nodesById, allNodes };
}

// --- Animation ---



function startAnimations(anims) {
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
      const cellsX = Math.ceil((c.estW * hyst) / LABEL_CELL_W);
      const cx = Math.floor(c.sx / LABEL_CELL_W);
      const cy = Math.floor(c.sy / LABEL_CELL_H);

      // Check if any cell is occupied
      let blocked = false;
      for (let dx = 0; dx < cellsX && !blocked; dx++) {
        for (let dy = -1; dy <= 1 && !blocked; dy++) {
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
          for (let dy = -1; dy <= 1; dy++) {
            grid.set((cx + dx) + "," + (cy + dy), true);
          }
        }
      }

      // Only update state when it changes
      if (show !== state.showing) {
        state.showing = show;
      }

      if (state.showing) {
        const text = c.entity.label.text;
        const str = (text && text.getValue) ? text.getValue(Cesium.JulianDate.now()) : text;
        if (str) labelDrawList.push({ text: str, sx: c.sx, sy: c.sy, offsetY: c.entity._labelPixelOffsetY || 0 });
      }
    }
  }
}

// --- Heatmap ---

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
  ctx.globalCompositeOperation = "color";

  // Pre-compute canvas coordinates
  const lonRange = maxLon - minLon;
  const latRange = maxLat - minLat;
  const pts = positions.map(p => ({
    x: ((p.lon - minLon) / lonRange) * W,
    y: ((maxLat - p.lat) / latRange) * W,
  }));

  // Grid-based local density: count neighbors in each cell
  const GRID_SIZE = 32;
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
  const MIN_RADIUS = 3;
  const MAX_RADIUS = 50;
  const ALPHA_CENTER_MIN = 0.09;  // dense areas (many individuals)
  const ALPHA_CENTER_MAX = 0.5;  // sparse areas (isolated commanders)

  for (const pt of pts) {
    const density = localDensity(pt.x, pt.y);
    const densityFactor = 1 / Math.sqrt(Math.max(1, density));
    const radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, MAX_RADIUS * densityFactor));
    const alphaCenter = ALPHA_CENTER_MIN + (ALPHA_CENTER_MAX - ALPHA_CENTER_MIN) * densityFactor;
    const alphaMid = alphaCenter * 0.4;
    const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radius);
    grad.addColorStop(0, `rgba(30, 80, 255, ${alphaCenter})`);
    grad.addColorStop(0.3, `rgba(30, 80, 255, ${alphaMid})`);
    grad.addColorStop(1, "rgba(30, 80, 255, 0)");
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

  // If layer exists, try to update it in place
  if (heatmapLayer) {
    try {
      heatmapLayer.imageryProvider.url = heatmapCanvas.toDataURL() + "?v=" + (++heatmapUrlCounter);
      console.log("fatto update in place");
      return;
    } catch (e) {
      // If update fails, remove and recreate
      // viewer.imageryLayers.remove(heatmapLayer, false);
      console.log("non possibile fare update in place");
    }
  }

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

  setTimeout(swapHeatmaps, 500);
}

function updateHeatmapLayer() {
  const viewer = moduleViewer;
  if (!viewer) return;

  updateCesiumHeatmapLayer();
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
            from: parentNode.staffHomePosition[si],
            to: parentNode.staffHomePosition[si],
            duration: 400,
            fade: "out",
            onComplete: () => { se.show = false; },
          });
        }
      }
    }

    if (anims.length > 0) { playBeep(MERGE_BEEP_FREQ); startAnimations(anims); }
    updateHeatmapLayer();
    return true;
  }

  if (!node || !node.parent) return true; // can't merge, but still eat event

  const parent = node.parent;
  const parentEntity = entitiesById[parent.id];

  const anims = [];
  // Animate ALL visible descendants (handles exploded sub-levels too)
  animateMergeAllDescendants(parent, parent.homePosition, anims);

  parentEntity.position = parent.homePosition;
  anims.push({
    entity: parentEntity,
    from: parent.homePosition,
    to: parent.homePosition,
    duration: 400,
    fade: "in",
    onComplete: () => { parentEntity.position = parent.homePosition; },
  });

  // Fade OUT parent's own commander/staff (commander disappears, unit symbol returns)
  const cmdE = cmdEntitiesById[parent.id];
  if (cmdE && cmdE.show) {
    anims.push({
      entity: cmdE,
      from: parent.cmdHomePosition,
      to: parent.cmdHomePosition,
      duration: 400,
      fade: "out",
      onComplete: () => { cmdE.show = false; parentEntity._labelHidden = false; },
    });
  }
  const staffEs = staffEntitiesById[parent.id];
  if (staffEs && parent.staffHomePositions) {
    for (let si = 0; si < staffEs.length; si++) {
      const se = staffEs[si];
      if (se.show) {
        anims.push({
          entity: se,
          from: parent.staffHomePositions[si],
          to: parent.staffHomePositions[si],
          duration: 400,
          fade: "out",
          onComplete: () => { se.show = false; },
        });
      }
    }
  }

  if (anims.length > 0) { playBeep(MERGE_BEEP_FREQ); startAnimations(anims); }
  updateHeatmapLayer();
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
  if (staffEs && node.staffHomePositions) {
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

  if (anims.length > 0) { playBeep(UNMERGE_BEEP_FREQ); startAnimations(anims); }
  updateHeatmapLayer();
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
    if (cameraSettleTimer) clearTimeout(cameraSettleTimer);
    cameraSettleTimer = setTimeout(() => { cameraMoving = false; }, 500);
  });
  viewer.camera.percentageChanged = 0.1;
}

export function swapHeatmaps()
{
    heatmapLayer.alpha = 1.0;
    moduleViewer.imageryLayers.remove(oldHeatmap, false);
    oldHeatmap = null;
}

// --- Keyboard ---

export function handleKeydown(event, viewer) {
  if (event.key === "m" || event.key === "M") {
    militaryVisible = !militaryVisible;
    if (!animating) {
      if (militaryVisible) {
        showLevel(currentLevel);
      } else {
        for (const node of allNodes) {
          entitiesById[node.id].show = false;
        }
        hideAllCmdStaff();
      }
      updateHeatmapLayer();
    }
    return true;
  }

  if (event.key === "l" || event.key === "L") {
    labelsEnabled = !labelsEnabled;
    // Reset label states so declutter recalculates fresh when re-enabled
    labelStates.clear();
    return true;
  }

  // Number keys 1-7: jump to level (1=individual, 2=squad, ..., 7=brigade)
  const digit = parseInt(event.key, 10);
  if (digit >= 1 && digit <= LEVEL_ORDER.length) {
    currentLevel = digit - 1;
    showLevel(currentLevel);
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

  return false;
}

// --- Individual movement ---

const MOVE_INTERVAL_MS = 1000;
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
    updateDotEntities();
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
        labelCtx.font = "18px sans-serif";
        labelCtx.textAlign = "center";
        labelCtx.textBaseline = "bottom";
        labelCtx.lineWidth = 3;
        for (const lb of labelDrawList) {
          labelCtx.strokeStyle = "rgba(0,0,0,1)";
          labelCtx.strokeText(lb.text, lb.sx, lb.sy + lb.offsetY);
          labelCtx.fillStyle = "rgba(255,255,255,1)";
          labelCtx.fillText(lb.text, lb.sx, lb.sy + lb.offsetY);
        }
      }
    }
  });
}
