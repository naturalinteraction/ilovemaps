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
const HEIGHT_ABOVE_TERRAIN = 1; // meters above terrain surface

// Current visible level index (0=squad, 3=battalion)
let currentLevel = 6; // start at brigade level
let militaryVisible = true;
let labelsEnabled = true; // when true, text labels are shown on military entities
let blobsVisible = false; // when true, convex hull blobs are shown
let heatmapVisible = true; // when true, show heatmap; when false, show circles

// Dot overlay state (replaces heatmap)
const DOT_RADIUS_M = 100;  // meters semi-axis for terrain-clamped ellipse
const DOT_ALPHA = 0.15;   // alpha per dot; overlapping dots sum alphas
let moduleViewer = null;          // viewer reference for dot updates
const dotEntities = [];           // pool of Cesium ellipse entities for dots

// Heatmap state (imported from clu)
let heatmapLayer = null;          // Cesium.ImageryLayer
let heatmapCanvas = null;         // offscreen canvas (reused)
const HEATMAP_CANVAS_SIZE = 512;
let heatmapUrlCounter = 0;        // cache-busting counter
let heatmapLayerLastUpdate = 0;   // last time layer was rebuilt
const HEATMAP_LAYER_UPDATE_MS = 5000; // only rebuild layer every 5 seconds


// Canvas overlay for drone arrows (full opacity, drawn on top of post-process stages)
let arrowCanvas = null;
let arrowCtx = null;
// Each entry: { base: Cartesian3, tip: Cartesian3, color: string }
export const canvasArrows = [];
// Each entry: { lines: [[Cartesian3,Cartesian3],...], color: string, width: number }
export const canvasFrustumLines = [];
// Each entry: { position: Cartesian3, color: string, outlineColor: string, pixelSize: number, outlineWidth: number }
export const canvasDots = [];

// Visual clustering state
const CLUSTER_PIXEL_RANGE = 80;
const clusterProxies = [];        // pool of proxy entities
let clusterDirty = true;          // flag to recalculate
const clusteredEntities = new Set(); // entities hidden by clustering (not by merge/unmerge)

// Blob overlay state — terrain-clamped polygon entities
let blobGroups = []; // array of { boundary: [Cartesian3...] } for each visible unit with children
const blobEntities = []; // pool of Cesium polygon entities for blobs

// --- Blob geometry: padded convex hull ---

const BLOB_RADIUS = DOT_RADIUS_M * 1.2; // meters of clearance around each point
const BLOB_CIRCLE_SAMPLES = 12;

function collectDescendantLeafPositions(node) {
  const positions = [];
  function recurse(n) {
    if (n.children.length === 0) {
      positions.push(n.position);
    } else {
      for (const child of n.children) recurse(child);
    }
  }
  for (const child of node.children) recurse(child);
  return positions;
}

function toLocal2D(positions) {
  if (positions.length === 0) return { pts: [], refLat: 0, refLon: 0 };
  let sumLat = 0, sumLon = 0;
  for (const p of positions) { sumLat += p.lat; sumLon += p.lon; }
  const refLat = sumLat / positions.length;
  const refLon = sumLon / positions.length;
  const cosLat = Math.cos(refLat * Math.PI / 180);
  const M_PER_DEG_LAT = 111320;
  const M_PER_DEG_LON = 111320 * cosLat;
  const pts = positions.map(p => ({
    x: (p.lon - refLon) * M_PER_DEG_LON,
    y: (p.lat - refLat) * M_PER_DEG_LAT,
  }));
  return { pts, refLat, refLon, cosLat, M_PER_DEG_LAT, M_PER_DEG_LON };
}

function fromLocal2D(pts, refLat, refLon, cosLat) {
  const M_PER_DEG_LAT = 111320;
  const M_PER_DEG_LON = 111320 * (cosLat || 1);
  return pts.map(p => {
    if (!isFinite(p.x) || !isFinite(p.y)) return null;
    const lon = refLon + p.x / M_PER_DEG_LON;
    const lat = refLat + p.y / M_PER_DEG_LAT;
    if (!isFinite(lon) || !isFinite(lat)) return null;
    return Cesium.Cartesian3.fromDegrees(lon, lat, HEIGHT_ABOVE_TERRAIN);
  }).filter(p => p !== null);
}

function chaikinSmooth(loop, iterations) {
  let pts = loop;
  for (let iter = 0; iter < iterations; iter++) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const j = i + 1;
      next.push({ x: 0.75 * pts[i].x + 0.25 * pts[j].x, y: 0.75 * pts[i].y + 0.25 * pts[j].y });
      next.push({ x: 0.25 * pts[i].x + 0.75 * pts[j].x, y: 0.25 * pts[i].y + 0.75 * pts[j].y });
    }
    pts = next;
  }
  return pts;
}

function computeBlobBoundaries(positions) {
  const local = toLocal2D(positions);
  const { pts, refLat, refLon, cosLat } = local;

  // For any number of points: place circle samples around each, then convex hull.
  const padded = [];
  for (const p of pts) {
    for (let i = 0; i < BLOB_CIRCLE_SAMPLES; i++) {
      const a = (2 * Math.PI * i) / BLOB_CIRCLE_SAMPLES;
      padded.push({ x: p.x + BLOB_RADIUS * Math.cos(a), y: p.y + BLOB_RADIUS * Math.sin(a) });
    }
  }
  const hull = convexHull(padded);
  if (hull.length >= 3) {
    hull.push(hull[0]); // close the loop
    const smoothed = chaikinSmooth(hull, 2);
    const converted = fromLocal2D(smoothed, refLat, refLon, cosLat);
    if (converted.length >= 3) return [converted];
  }

  return [];
}

function convexHull(points) {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
    upper.push(pts[i]);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

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

function setEntityAlpha(entity, alpha, labelAlpha) {
  // Use small epsilon for billboard to prevent Cesium from skipping fully-transparent billboards
  entity.billboard.color = new Cesium.Color(1, 1, 1, Math.max(alpha, 0.005));
  const la = labelAlpha !== undefined ? labelAlpha : alpha;
  entity.label.fillColor = new Cesium.Color(1, 1, 1, la);
  entity.label.outlineColor = new Cesium.Color(0, 0, 0, la);
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
    pos.lon, pos.lat, pos.alt + HEIGHT_ABOVE_TERRAIN
  );
  // Commander position (own position if available, otherwise same as unit)
  if (node.commander && node.commander.position) {
    node.cmdHomePosition = Cesium.Cartesian3.fromDegrees(
      node.commander.position.lon, node.commander.position.lat,
      node.commander.position.alt + HEIGHT_ABOVE_TERRAIN
    );
  } else {
    node.cmdHomePosition = node.homePosition;
  }
  // Staff positions from JSON data
  if (node.staff && node.staff.length >= 2) {
    node.staffHomePositions = node.staff.map(s =>
      Cesium.Cartesian3.fromDegrees(s.position.lon, s.position.lat, s.position.alt + HEIGHT_ABOVE_TERRAIN)
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
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: node.name,
        font: isIndividual ? "14px sans-serif" : "20px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -(size / 2 + 4)),
        eyeOffset: new Cesium.Cartesian3(0, 0, -50),
        show: labelsEnabled,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      show: levelIdx === currentLevel,
    });

    entity._milNode = node;
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
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: cmdLabel,
        font: "18px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -(SYMBOL_SIZE / 2 + 4)),
        eyeOffset: new Cesium.Cartesian3(0, 0, -50),
        show: labelsEnabled,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      show: false,
    });
    cmdEntity._milCmdOf = node;
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
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
          label: {
            text: s.name,
            font: "14px sans-serif",
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineWidth: 2,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -28),
            eyeOffset: new Cesium.Cartesian3(0, 0, -50),
            show: labelsEnabled,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
          show: false,
        });
        staffEntity._milStaffOf = node;
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

  const syncCanvasSize = () => {
    const cw = viewer.canvas.clientWidth;
    const ch = viewer.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    arrowCanvas.style.width = cw + "px";
    arrowCanvas.style.height = ch + "px";
    arrowCanvas.width = cw * dpr;
    arrowCanvas.height = ch * dpr;
    arrowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function computeControlPoint(from, to) {
  // Midpoint
  const mid = Cesium.Cartesian3.midpoint(from, to, new Cesium.Cartesian3());
  // Direction from→to
  const dir = Cesium.Cartesian3.subtract(to, from, new Cesium.Cartesian3());
  const dist = Cesium.Cartesian3.magnitude(dir);
  // Surface normal at midpoint (points "up" from globe)
  const normal = Cesium.Cartesian3.normalize(mid, new Cesium.Cartesian3());
  // Perpendicular in the plane: cross(dir, normal)
  const perp = Cesium.Cartesian3.cross(dir, normal, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(perp, perp);
  // Offset midpoint sideways by 20% of distance
  const offset = Cesium.Cartesian3.multiplyByScalar(perp, dist * 0.2, new Cesium.Cartesian3());
  return Cesium.Cartesian3.add(mid, offset, new Cesium.Cartesian3());
}

function quadraticBezier(from, control, to, t, result) {
  // B(t) = (1-t)²·from + 2(1-t)t·control + t²·to
  const omt = 1 - t;
  const a = omt * omt;
  const b = 2 * omt * t;
  const c = t * t;
  result.x = a * from.x + b * control.x + c * to.x;
  result.y = a * from.y + b * control.y + c * to.y;
  result.z = a * from.z + b * control.z + c * to.z;
  return result;
}

function startAnimations(anims) {
  const now = performance.now();
  for (const a of anims) {
    a.startTime = now;
    a.entity.show = true;
    if (a.fade === "in") {
      setEntityAlpha(a.entity, 0, 0);
      if (a.popScale) setEntityScale(a.entity, PARENT_POP_SCALE);
    } else if (a.fade === "out") {
      setEntityAlpha(a.entity, 1, 1);
      if (a.popScale) setEntityScale(a.entity, 1);
    }
    const stationary = Cesium.Cartesian3.equals(a.from, a.to);
    if (!stationary) {
      a.control = computeControlPoint(a.from, a.to);
      const anim = a;
      a.entity.position = new Cesium.CallbackProperty(() => {
        const t = Math.min(1, (performance.now() - anim.startTime) / anim.duration);
        const eased = easeInOutCubic(t);
        return quadraticBezier(anim.from, anim.control, anim.to, eased, new Cesium.Cartesian3());
      }, false);
    } else {
      // Force Cesium to treat entity as dynamic for re-render every frame
      const pos = a.from;
      a.entity.position = new Cesium.CallbackProperty(() => pos, false);
    }
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
      // Animation complete — reset alpha/scale, run callback, swap position
      if (a.fade) setEntityAlpha(a.entity, 1);
      if (a.popScale) setEntityScale(a.entity, 1);
      if (a.onComplete) a.onComplete();
      a.entity.position = a.to;
      animations.splice(i, 1);
    } else {
      if (a.fade) {
        const fadeDelay = a.fadeDelay || 0;
        const fadeDur = a.fadeDuration || a.duration;
        const elapsed = now - a.startTime - fadeDelay;
        const ft = Math.max(0, Math.min(1, elapsed / fadeDur));
        const eased = easeInOutCubic(ft);
        const alpha = a.fade === "in" ? eased : 1 - eased;
        // Labels: fade out during delay period, fade in only after delay
        const labelDelay = a.duration * (1 - PARENT_FADE_RELATIVE_DURATION);
        const labelDur = a.duration * PARENT_FADE_RELATIVE_DURATION;
        let labelAlpha;
        if (a.fade === "out") {
          const lt = labelDelay > 0 ? easeInOutCubic(Math.min(1, (now - a.startTime) / labelDelay)) : 1;
          labelAlpha = 1 - lt;
        } else {
          const labelElapsed = now - a.startTime - labelDelay;
          const lt = Math.max(0, Math.min(1, labelElapsed / labelDur));
          labelAlpha = easeInOutCubic(lt);
        }
        setEntityAlpha(a.entity, alpha, labelAlpha);
        if (a.popScale) {
          const scale = a.fade === "in"
            ? PARENT_POP_SCALE + (1 - PARENT_POP_SCALE) * eased
            : 1 + (PARENT_POP_SCALE - 1) * eased;
          setEntityScale(a.entity, scale);
        }
      }
      allDone = false;
    }
  }

  if (allDone) {
    animating = false;
    updateHeatmapLayer();
    clusterDirty = true;
  }
}

// --- Merge / Unmerge ---

const ANIM_DURATION = 400;
const PARENT_POP_SCALE = 1.2; // max scale factor for parent appear/disappear effect
const PARENT_FADE_RELATIVE_DURATION = 0.5; // parent fade duration relative to ANIM_DURATION (also used as delay for fade-in)


function setCmdStaffShow(node, show) {
  const cmdE = cmdEntitiesById[node.id];
  if (cmdE) {
    cmdE.show = show;
    cmdE.position = node.cmdHomePosition;
    if (show) setEntityAlpha(cmdE, 1, 1);
  }
  const staffEs = staffEntitiesById[node.id];
  if (staffEs) {
    for (const se of staffEs) {
      se.show = show;
      if (show) setEntityAlpha(se, 1, 1);
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
  }
}

// --- Visual Clustering ---

function entityRank(entity) {
  if (entity._milNode) return LEVEL_ORDER.indexOf(entity._milNode.type);
  if (entity._milCmdOf) return LEVEL_ORDER.indexOf(entity._milCmdOf.type) + 0.5;
  if (entity._milStaffOf) return 0;
  return -1;
}

function clearVisualClusters() {
  // Restore entities hidden by clustering
  for (const entity of clusteredEntities) {
    entity.show = true;
  }
  clusteredEntities.clear();
  // Hide all proxy entities
  for (const proxy of clusterProxies) {
    proxy.show = false;
  }
}

function getOrCreateProxy(viewer, index) {
  if (index < clusterProxies.length) return clusterProxies[index];
  const proxy = viewer.entities.add({
    position: Cesium.Cartesian3.ZERO,
    billboard: {
      image: getSymbolImage("battalion"),
      width: SYMBOL_SIZE,
      height: SYMBOL_SIZE,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: "",
      font: "bold 18px sans-serif",
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineWidth: 2,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -(SYMBOL_SIZE / 2 + 4)),
      eyeOffset: new Cesium.Cartesian3(0, 0, -50),
      show: labelsEnabled,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    show: false,
  });
  proxy._isClusterProxy = true;
  clusterProxies.push(proxy);
  return proxy;
}

function updateVisualClusters(viewer) {
  if (animating) return;
  if (!militaryVisible) return;

  // First restore anything previously hidden by clustering
  clearVisualClusters();

  // Collect visible entities with their positions
  const visible = [];
  for (const node of allNodes) {
    const entity = entitiesById[node.id];
    if (entity.show) {
      visible.push({ entity, position: node.homePosition, name: node.name });
    }
    const cmdE = cmdEntitiesById[node.id];
    if (cmdE && cmdE.show) {
      visible.push({ entity: cmdE, position: node.cmdHomePosition, name: node.name });
    }
    const staffEs = staffEntitiesById[node.id];
    if (staffEs) {
      for (let si = 0; si < staffEs.length; si++) {
        if (staffEs[si].show) {
          visible.push({ entity: staffEs[si], position: node.staffHomePositions[si], name: node.staff[si].name });
        }
      }
    }
  }

  if (visible.length === 0) return;

  // Project to screen space
  const scene = viewer.scene;
  const projected = [];
  for (const v of visible) {
    const screen = scene.cartesianToCanvasCoordinates(v.position);
    if (!screen) continue; // behind camera or off-screen
    projected.push({ ...v, screenX: screen.x, screenY: screen.y });
  }

  // Grid-based grouping
  const cells = new Map();
  for (const p of projected) {
    const key = Math.floor(p.screenX / CLUSTER_PIXEL_RANGE) + "," + Math.floor(p.screenY / CLUSTER_PIXEL_RANGE);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }

  // Process cells, create proxies where needed
  let proxyIdx = 0;
  for (const [, members] of cells) {
    if (members.length <= 1) continue;

    // Sort by rank descending to pick representative
    members.sort((a, b) => entityRank(b.entity) - entityRank(a.entity));
    const rep = members[0];

    // Hide all entities in this cell
    for (const m of members) {
      m.entity.show = false;
      clusteredEntities.add(m.entity);
    }

    // Create/reuse proxy
    const proxy = getOrCreateProxy(viewer, proxyIdx++);
    proxy.position = rep.position;
    const now = Cesium.JulianDate.now();
    const repBb = rep.entity.billboard;
    proxy.billboard.image = repBb.image ? repBb.image.getValue(now) : getSymbolImage("battalion");
    proxy.billboard.width = repBb.width ? repBb.width.getValue(now) : SYMBOL_SIZE;
    proxy.billboard.height = repBb.height ? repBb.height.getValue(now) : SYMBOL_SIZE;
    proxy.label.text = rep.name + " +" + (members.length - 1);
    proxy._clusterRepEntity = rep.entity;
    proxy.show = true;
  }

  // Hide unused proxies
  for (let i = proxyIdx; i < clusterProxies.length; i++) {
    clusterProxies[i].show = false;
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

// Heatmap canvas rendering (imported from clu)
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
  const ALPHA_CENTER_MIN = 0.08;  // dense areas (many individuals)
  const ALPHA_CENTER_MAX = 0.35;  // sparse areas (isolated commanders)

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
      return;
    } catch (e) {
      // If update fails, remove and recreate
      viewer.imageryLayers.remove(heatmapLayer, false);
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
  heatmapLayer = viewer.imageryLayers.addImageryProvider(provider);
  heatmapLayer.alpha = 1.0;
}

function updateHeatmapLayer() {
  const viewer = moduleViewer;
  if (!viewer) return;

  updateDotEntities();
  updateCesiumHeatmapLayer();
}

function updateDotEntities() {
  const viewer = moduleViewer;
  if (!viewer) return;
  if (!militaryVisible) return;

  blobGroups = [];

  if (!blobsVisible) {
    for (let i = 0; i < blobEntities.length; i++) blobEntities[i].show = false;
  } else {
    for (const node of allNodes) {
      if (node.children.length === 0) continue;
      const entity = entitiesById[node.id];
      if (!entity || !entity.show) continue;
      const positions = collectDescendantLeafPositions(node);
      positions.push(node.position);
      if (positions.length < 1) continue;
      const boundaries = computeBlobBoundaries(positions);
      for (const boundary of boundaries) {
        blobGroups.push({ boundary });
      }
    }

    for (let i = 0; i < blobGroups.length; i++) {
      let blobE = blobEntities[i];
      if (!blobE) {
        blobE = viewer.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(blobGroups[i].boundary),
            material: Cesium.Color.fromCssColorString("#2040FF").withAlpha(0.25),
            classificationType: Cesium.ClassificationType.BOTH,
          },
          show: true,
        });
        blobE._isBlob = true;
        blobEntities.push(blobE);
      } else {
        blobE.polygon.hierarchy = new Cesium.PolygonHierarchy(blobGroups[i].boundary);
        blobE.show = true;
      }
    }
  }
  for (let i = blobGroups.length; i < blobEntities.length; i++) {
    blobEntities[i].show = false;
  }

  const entries = getHeatmapPositions();

  if (!heatmapVisible) {
    for (let i = 0; i < entries.length; i++) {
      const { position: p } = entries[i];
      const childPos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, HEIGHT_ABOVE_TERRAIN);

      let dotE = dotEntities[i];
      if (!dotE) {
        dotE = viewer.entities.add({
          position: childPos,
          ellipse: {
            semiMinorAxis: DOT_RADIUS_M,
            semiMajorAxis: DOT_RADIUS_M,
            material: Cesium.Color.BLUE.withAlpha(DOT_ALPHA),
            classificationType: Cesium.ClassificationType.BOTH,
          },
          show: true,
        });
        dotE._isDot = true;
        dotEntities.push(dotE);
      } else {
        dotE.position = childPos;
        dotE.show = true;
      }
    }
    for (let i = entries.length; i < dotEntities.length; i++) {
      dotEntities[i].show = false;
    }
    if (heatmapLayer) {
      heatmapLayer.show = false;
    }
  } else {
    for (let i = 0; i < dotEntities.length; i++) {
      dotEntities[i].show = false;
    }
    if (heatmapLayer) {
      heatmapLayer.show = true;
    }
  }
}

function showLevel(levelIdx) {
  const type = LEVEL_ORDER[levelIdx];
  for (const node of allNodes) {
    const entity = entitiesById[node.id];
    entity.show = militaryVisible && node.type === type;
    entity.position = node.homePosition;
  }
  // Commander/staff: visible for units one level ABOVE the visible level
  // (those units are "unmerged" — their symbol is hidden, children are visible)
  hideAllCmdStaff();
  if (militaryVisible && levelIdx + 1 < LEVEL_ORDER.length) {
    const parentType = LEVEL_ORDER[levelIdx + 1];
    for (const node of allNodes) {
      if (node.type === parentType) {
        setCmdStaffShow(node, true);
      }
    }
  }
  updateHeatmapLayer();
  clusterDirty = true;
}

// --- Click toggle ---

function resolvePickedEntity(viewer, click) {
  if (animating) return null;
  // Use drillPick to see through non-pickable overlay entities (dots, dot-lines)
  const picks = viewer.scene.drillPick(click.position);
  for (const picked of picks) {
    if (!(picked.id instanceof Cesium.Entity)) continue;
    let entity = picked.id;
    if (entity._isDot || entity._isDotLine || entity._isBlob) continue; // skip overlay entities
    // Resolve proxy to its representative entity
    if (entity._isClusterProxy) {
      entity = entity._clusterRepEntity;
      if (!entity) continue;
      // Clear clusters so the representative and its siblings become visible for animation
      clearVisualClusters();
    }
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
    // Clear visual clusters so all entities have their real visibility state
    clearVisualClusters();
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
      duration: ANIM_DURATION,
      fade: "in",
      popScale: true,
      fadeDelay: ANIM_DURATION * (1 - PARENT_FADE_RELATIVE_DURATION),
      fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
      onComplete: () => { parentEntity.position = parentNode.homePosition; },
    });

    // Fade OUT merge target's own commander/staff
    const cmdE = cmdEntitiesById[parentNode.id];
    if (cmdE && cmdE.show) {
      anims.push({
        entity: cmdE,
        from: parentNode.cmdHomePosition,
        to: parentNode.cmdHomePosition,
        duration: ANIM_DURATION,
        fade: "out",
        fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
        onComplete: () => { cmdE.show = false; },
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
            duration: ANIM_DURATION,
            fade: "out",
            fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
            onComplete: () => { se.show = false; },
          });
        }
      }
    }

    if (anims.length > 0) { playBeep(MERGE_BEEP_FREQ); startAnimations(anims); }
    return true;
  }

  if (!node || !node.parent) return true; // can't merge, but still eat event

  // Clear visual clusters so all entities have their real visibility state
  clearVisualClusters();

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
    duration: ANIM_DURATION,
    fade: "in",
    popScale: true,
    fadeDelay: ANIM_DURATION * (1 - PARENT_FADE_RELATIVE_DURATION),
    fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
    onComplete: () => { parentEntity.position = parent.homePosition; },
  });

  // Fade OUT parent's own commander/staff (commander disappears, unit symbol returns)
  const cmdE = cmdEntitiesById[parent.id];
  if (cmdE && cmdE.show) {
    anims.push({
      entity: cmdE,
      from: parent.cmdHomePosition,
      to: parent.cmdHomePosition,
      duration: ANIM_DURATION,
      fade: "out",
      fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
      onComplete: () => { cmdE.show = false; },
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
          duration: ANIM_DURATION,
          fade: "out",
          fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
          onComplete: () => { se.show = false; },
        });
      }
    }
  }

  if (anims.length > 0) { playBeep(MERGE_BEEP_FREQ); startAnimations(anims); }
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

  // Clear visual clusters so all entities have their real visibility state
  clearVisualClusters();

  const anims = [];
  anims.push({
    entity,
    from: node.homePosition,
    to: node.homePosition,
    duration: ANIM_DURATION,
    fade: "out",
    popScale: true,
    fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
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
      duration: ANIM_DURATION,
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
      duration: ANIM_DURATION,
      fade: "in",
      fadeDelay: ANIM_DURATION * (1 - PARENT_FADE_RELATIVE_DURATION),
      fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
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
        duration: ANIM_DURATION,
        fade: "in",
        fadeDelay: ANIM_DURATION * (1 - PARENT_FADE_RELATIVE_DURATION),
        fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
        onComplete: () => { se.position = node.staffHomePositions[si]; },
      });
    }
  }

  if (anims.length > 0) { playBeep(UNMERGE_BEEP_FREQ); startAnimations(anims); }
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
        duration: ANIM_DURATION,
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
        duration: ANIM_DURATION,
        fade: "out",
        fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
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
            duration: ANIM_DURATION,
            fade: "out",
            fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
            onComplete: () => { se.show = false; },
          });
        }
      }
    }
    animateMergeAllDescendants(child, targetPos, anims);
  }
}

// --- Zoom listener ---

let clusterDebounceTimer = null;

export function setupZoomListener(viewer) {
  viewer.camera.changed.addEventListener(() => {
    // Debounced visual clustering update
    if (clusterDebounceTimer) clearTimeout(clusterDebounceTimer);
    clusterDebounceTimer = setTimeout(() => {
      clusterDirty = true;
    }, 100);
  });
  viewer.camera.percentageChanged = 0.1;
}

// --- Keyboard ---

export function handleKeydown(event, viewer) {
  if (event.key === "m" || event.key === "M") {
    militaryVisible = !militaryVisible;
    if (!animating) {
      if (militaryVisible) {
        showLevel(currentLevel);
      } else {
        clearVisualClusters();
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
    for (const node of allNodes) {
      entitiesById[node.id].label.show = labelsEnabled;
      const cmdE = cmdEntitiesById[node.id];
      if (cmdE) cmdE.label.show = labelsEnabled;
      const staffEs = staffEntitiesById[node.id];
      if (staffEs) for (const se of staffEs) se.label.show = labelsEnabled;
    }
    for (const proxy of clusterProxies) proxy.label.show = labelsEnabled;
    return true;
  }

  if (event.key === "b" || event.key === "B") {
    blobsVisible = !blobsVisible;
    updateHeatmapLayer();
    return true;
  }

  if (event.key === "h" || event.key === "H") {
    heatmapVisible = !heatmapVisible;
    updateHeatmapLayer();
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
    updateHeatmapLayer();
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
            node.position.lon, node.position.lat, node.position.alt + HEIGHT_ABOVE_TERRAIN
          );
        }
      }
      const cmdE = cmdEntitiesById[node.id];
      if (cmdE && cmdE.show && node.commander) {
        const cmdPos = node.commander.position;
        perturbPosition(cmdPos);
        cmdE.position = Cesium.Cartesian3.fromDegrees(
          cmdPos.lon, cmdPos.lat, cmdPos.alt + HEIGHT_ABOVE_TERRAIN
        );
      }
      const staffEs = staffEntitiesById[node.id];
      if (staffEs && node.staff && node.staffHomePositions) {
        for (let i = 0; i < staffEs.length; i++) {
          if (staffEs[i].show) {
            const staffPos = node.staff[i].position;
            perturbPosition(staffPos);
            staffEs[i].position = Cesium.Cartesian3.fromDegrees(
              staffPos.lon, staffPos.lat, staffPos.alt + HEIGHT_ABOVE_TERRAIN
            );
          }
        }
      }
    }
    // Unit positions follow their commander (node.position === node.commander.position)
    for (const node of allNodes) {
      if (node.commander) {
        node.homePosition = Cesium.Cartesian3.fromDegrees(
          node.position.lon, node.position.lat, node.position.alt + HEIGHT_ABOVE_TERRAIN
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

// --- Pre-render hook ---

export function setupPreRender(viewer) {
  viewer.scene.preRender.addEventListener(() => {
    onPreRender();
    // Visual clustering update
    if (clusterDirty && !animating) {
      clusterDirty = false;
      // updateVisualClusters(viewer); // temporarily disabled
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
  });
}
