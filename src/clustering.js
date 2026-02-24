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

const LEVEL_ORDER = ["individual", "squad", "platoon", "company", "battalion"];

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
// Polyline entities connecting each node to its parent
const linesById = {};
// Scratch variables for polyline position computation
const scratchDir = new Cesium.Cartesian3();
const scratchOffset = new Cesium.Cartesian3();
const scratchStart = new Cesium.Cartesian3();
const scratchEnd = new Cesium.Cartesian3();
const ARC_SEGMENTS = 16;
const ARC_BOW = 0.15; // perpendicular offset as fraction of distance
const HEIGHT_ABOVE_TERRAIN = 1; // meters above terrain surface

// Current visible level index (0=squad, 3=battalion)
let currentLevel = 4; // start at battalion level
let militaryVisible = true;
let manualMode = false; // disables zoom-based auto-leveling after click merge/unmerge
let zoomLevelingDisabled = true; // when true, zoom/camera movement never triggers merge/unmerge
let parentLinesEnabled = false; // when true, polylines connect units to their parent
let labelsEnabled = true; // when true, text labels are shown on military entities

// Dot overlay state (replaces heatmap)
const DOT_USE_ELLIPSE = false; // false: pixel-sized point; true: 9m semi-transparent circle
let moduleViewer = null;          // viewer reference for dot updates

// Canvas overlay for dots (avoids alpha accumulation on overlap)
let dotCanvas = null;
let dotCtx = null;
let dotWorldPositions = [];       // array of Cartesian3 positions for canvas dots
let dotWorldLines = [];           // array of [Cartesian3, Cartesian3] pairs for canvas lines

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

// --- Blob geometry: Alpha Shape + Chaikin Smoothing ---

// Collect all descendant leaf (individual) positions as {lon, lat, alt} from a node
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

// Convert lat/lon positions to local 2D metric coordinates (meters) using cosine projection
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

// Convert local 2D back to Cartesian3
function fromLocal2D(pts, refLat, refLon, cosLat) {
  const M_PER_DEG_LAT = 111320;
  const M_PER_DEG_LON = 111320 * cosLat;
  return pts.map(p => {
    const lon = refLon + p.x / M_PER_DEG_LON;
    const lat = refLat + p.y / M_PER_DEG_LAT;
    return Cesium.Cartesian3.fromDegrees(lon, lat, HEIGHT_ABOVE_TERRAIN);
  });
}

// Bowyer-Watson Delaunay triangulation on 2D points
// Returns { triangles: [[i,j,k],...], points: [{x,y},...] }
function delaunayTriangulation(points) {
  const n = points.length;
  if (n < 3) return { triangles: [], points };

  // Find bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const dmax = Math.max(dx, dy);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // Super-triangle vertices (indices n, n+1, n+2)
  const st0 = { x: midX - 20 * dmax, y: midY - dmax };
  const st1 = { x: midX, y: midY + 20 * dmax };
  const st2 = { x: midX + 20 * dmax, y: midY - dmax };
  const allPts = [...points, st0, st1, st2];

  // Each triangle: { v: [i,j,k], cx, cy, rSq }
  function circumcircle(i, j, k) {
    const ax = allPts[i].x, ay = allPts[i].y;
    const bx = allPts[j].x, by = allPts[j].y;
    const cx = allPts[k].x, cy = allPts[k].y;
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-12) return null;
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    const rSq = (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy);
    return { v: [i, j, k], cx: ux, cy: uy, rSq };
  }

  let triangles = [];
  const st = circumcircle(n, n + 1, n + 2);
  if (st) triangles.push(st);

  for (let i = 0; i < n; i++) {
    const px = allPts[i].x, py = allPts[i].y;
    const bad = [];
    const good = [];
    for (const tri of triangles) {
      const dx = px - tri.cx;
      const dy = py - tri.cy;
      if (dx * dx + dy * dy < tri.rSq) {
        bad.push(tri);
      } else {
        good.push(tri);
      }
    }

    // Find boundary edges of the "bad" polygon hole
    const edgeCount = new Map();
    const edgeKey = (a, b) => a < b ? a + "," + b : b + "," + a;
    for (const tri of bad) {
      const edges = [[tri.v[0], tri.v[1]], [tri.v[1], tri.v[2]], [tri.v[2], tri.v[0]]];
      for (const [a, b] of edges) {
        const key = edgeKey(a, b);
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      }
    }

    // Boundary edges: appear exactly once
    const boundary = [];
    for (const tri of bad) {
      const edges = [[tri.v[0], tri.v[1]], [tri.v[1], tri.v[2]], [tri.v[2], tri.v[0]]];
      for (const [a, b] of edges) {
        if (edgeCount.get(edgeKey(a, b)) === 1) {
          boundary.push([a, b]);
        }
      }
    }

    triangles = good;
    for (const [a, b] of boundary) {
      const tri = circumcircle(a, b, i);
      if (tri) triangles.push(tri);
    }
  }

  // Remove triangles using super-triangle vertices
  const result = [];
  for (const tri of triangles) {
    if (tri.v[0] >= n || tri.v[1] >= n || tri.v[2] >= n) continue;
    result.push(tri);
  }

  return { triangles: result, points };
}

// Extract alpha shape boundary from Delaunay triangulation
// Returns array of closed loops: [[{x,y},...], ...]
function alphaShape(delaunay, alpha) {
  const { triangles, points } = delaunay;
  if (triangles.length === 0) return [];

  // Filter triangles by circumradius
  const kept = [];
  for (const tri of triangles) {
    if (Math.sqrt(tri.rSq) <= alpha) {
      kept.push(tri);
    }
  }

  if (kept.length === 0) return [];

  // Count edge occurrences among kept triangles
  const edgeCount = new Map();
  const edgeKey = (a, b) => a < b ? a + "," + b : b + "," + a;
  for (const tri of kept) {
    const edges = [[tri.v[0], tri.v[1]], [tri.v[1], tri.v[2]], [tri.v[2], tri.v[0]]];
    for (const [a, b] of edges) {
      const key = edgeKey(a, b);
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    }
  }

  // Boundary edges: appear in exactly one kept triangle
  const boundaryEdges = [];
  for (const tri of kept) {
    const edges = [[tri.v[0], tri.v[1]], [tri.v[1], tri.v[2]], [tri.v[2], tri.v[0]]];
    for (const [a, b] of edges) {
      if (edgeCount.get(edgeKey(a, b)) === 1) {
        boundaryEdges.push([a, b]);
      }
    }
  }

  if (boundaryEdges.length === 0) return [];

  // Build adjacency: for each vertex, list of connected vertices in boundary edges
  const adj = new Map();
  for (const [a, b] of boundaryEdges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }

  // Walk closed loops
  const visited = new Set();
  const loops = [];
  for (const [start] of adj) {
    if (visited.has(start)) continue;
    const loop = [];
    let current = start;
    let prev = -1;
    let steps = 0;
    while (steps < boundaryEdges.length * 2) {
      visited.add(current);
      loop.push(points[current]);
      const neighbors = adj.get(current);
      let next = -1;
      for (const nb of neighbors) {
        if (nb !== prev && !visited.has(nb)) { next = nb; break; }
      }
      if (next === -1) {
        // Try to close the loop back to start
        for (const nb of neighbors) {
          if (nb === start && loop.length > 2) { next = start; break; }
        }
        if (next === -1) break;
      }
      if (next === start) break;
      prev = current;
      current = next;
      steps++;
    }
    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

// Compute auto alpha value: generous enough to keep the shape connected
// Uses max of (median NN × 3) and (90th percentile NN × 2)
function autoAlpha(points) {
  if (points.length < 2) return Infinity;
  const dists = [];
  for (let i = 0; i < points.length; i++) {
    let minD = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minD) minD = d;
    }
    dists.push(minD);
  }
  dists.sort((a, b) => a - b);
  const median = dists[Math.floor(dists.length / 2)];
  const p90 = dists[Math.floor(dists.length * 0.9)];
  return Math.max(median * 3, p90 * 2);
}

// Pad boundary outward along average edge normals
function padBoundary(loop, distance) {
  const n = loop.length;
  if (n < 3) return loop;
  const result = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];
    // Edge normals (pointing outward for CCW loop)
    const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
    // Outward normal: rotate edge 90° CW (for CCW polygon, this points outward)
    let nx = (dy1 / len1 + dy2 / len2) / 2;
    let ny = (-dx1 / len1 + -dx2 / len2) / 2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nlen;
    ny /= nlen;
    result.push({ x: curr.x + nx * distance, y: curr.y + ny * distance });
  }

  // Check winding: if padding inverted the polygon, flip normals
  const area = polygonArea(result);
  const origArea = polygonArea(loop);
  if ((origArea > 0 && area < 0) || (origArea < 0 && area > 0)) {
    // Normals went inward, flip
    for (let i = 0; i < n; i++) {
      const prev = loop[(i - 1 + n) % n];
      const curr = loop[i];
      const next = loop[(i + 1) % n];
      const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
      const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
      let nx = (-dy1 / len1 + -dy2 / len2) / 2;
      let ny = (dx1 / len1 + dx2 / len2) / 2;
      const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= nlen;
      ny /= nlen;
      result[i] = { x: curr.x + nx * distance, y: curr.y + ny * distance };
    }
  }

  return result;
}

function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return area / 2;
}

// Chaikin corner-cutting smoothing
function chaikinSmooth(loop, iterations) {
  let pts = loop;
  for (let iter = 0; iter < iterations; iter++) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      next.push({ x: 0.75 * pts[i].x + 0.25 * pts[j].x, y: 0.75 * pts[i].y + 0.25 * pts[j].y });
      next.push({ x: 0.25 * pts[i].x + 0.75 * pts[j].x, y: 0.25 * pts[i].y + 0.75 * pts[j].y });
    }
    pts = next;
  }
  return pts;
}

// For nodes with only 1-2 leaf positions, generate an ellipse blob
function generateEllipseBlob(positions, padDist) {
  if (positions.length === 1) {
    // Circle around single point
    const pts = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const angle = (2 * Math.PI * i) / N;
      pts.push({ x: positions[0].x + padDist * Math.cos(angle), y: positions[0].y + padDist * Math.sin(angle) });
    }
    return pts;
  }
  // 2 positions: ellipse between them
  const cx = (positions[0].x + positions[1].x) / 2;
  const cy = (positions[0].y + positions[1].y) / 2;
  const dx = positions[1].x - positions[0].x;
  const dy = positions[1].y - positions[0].y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const rx = dist / 2 + padDist;
  const ry = padDist;
  const pts = [];
  const N = 32;
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    const lx = rx * Math.cos(a);
    const ly = ry * Math.sin(a);
    pts.push({
      x: cx + lx * Math.cos(angle) - ly * Math.sin(angle),
      y: cy + lx * Math.sin(angle) + ly * Math.cos(angle),
    });
  }
  return pts;
}

// Compute blob boundary for a set of lat/lon positions
// Returns array of Cartesian3 closed loops
function computeBlobBoundaries(positions) {
  const PAD_DIST = 150; // meters
  const local = toLocal2D(positions);
  const { pts, refLat, refLon, cosLat } = local;

  if (pts.length < 3) {
    // Use ellipse fallback for 1-2 points
    const ellipse = generateEllipseBlob(pts, PAD_DIST);
    return [fromLocal2D(ellipse, refLat, refLon, cosLat)];
  }

  // Deduplicate points that are very close (within 1m)
  const unique = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let dup = false;
    for (let j = 0; j < unique.length; j++) {
      const dx = pts[i].x - unique[j].x;
      const dy = pts[i].y - unique[j].y;
      if (dx * dx + dy * dy < 1) { dup = true; break; }
    }
    if (!dup) unique.push(pts[i]);
  }

  if (unique.length < 3) {
    const ellipse = generateEllipseBlob(unique, PAD_DIST);
    return [fromLocal2D(ellipse, refLat, refLon, cosLat)];
  }

  // Always use convex hull → guaranteed single blob
  const hull = convexHull2D(unique);
  if (hull.length < 3) return [];
  const padded = padBoundary(hull, PAD_DIST);
  const smoothed = chaikinSmooth(padded, 3);
  return [fromLocal2D(smoothed, refLat, refLon, cosLat)];
}

// Simple convex hull (Graham scan) as fallback
function convexHull2D(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
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
  node.homePosition = Cesium.Cartesian3.fromDegrees(
    node.position.lon, node.position.lat, node.position.alt + HEIGHT_ABOVE_TERRAIN
  );
  // Commander uses same position as unit
  node.cmdHomePosition = node.homePosition;
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

  // Create polylines connecting each node to its parent
  for (const node of allNodes) {
    if (!node.parent) continue;
    const entity = entitiesById[node.id];
    const parentNode = node.parent;
    const lineEntity = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          let currentPos = node.homePosition;
          try {
            const val = entity.position.getValue(Cesium.JulianDate.now());
            if (val) currentPos = val;
          } catch (e) { /* use homePosition */ }
          const parentPos = parentNode.homePosition;
          // Direction and distance
          const dir = Cesium.Cartesian3.subtract(parentPos, currentPos, scratchDir);
          const dist = Cesium.Cartesian3.magnitude(dir);
          if (dist < 1) return [currentPos, parentPos];
          Cesium.Cartesian3.divideByScalar(dir, dist, dir);
          // Compute symbol radius in world-space meters
          const camDist = Cesium.Cartesian3.distance(viewer.camera.position, currentPos);
          const fov = viewer.camera.frustum.fovy || 1.0;
          const metersPerPx = 2 * camDist * Math.tan(fov / 2) / viewer.canvas.height;
          const symbolRadius = metersPerPx * SYMBOL_SIZE * 0.6;
          const trimStart = Math.min(symbolRadius, dist * 0.4);
          const trimEnd = trimStart / 3;
          // Perpendicular vector for arc bow (cross dir with surface normal at midpoint)
          const mid = Cesium.Cartesian3.midpoint(currentPos, parentPos, new Cesium.Cartesian3());
          const normal = Cesium.Cartesian3.normalize(mid, new Cesium.Cartesian3());
          const perp = Cesium.Cartesian3.cross(dir, normal, new Cesium.Cartesian3());
          Cesium.Cartesian3.normalize(perp, perp);
          const bowDist = dist * ARC_BOW;
          // Control point for quadratic bezier
          const control = Cesium.Cartesian3.add(mid,
            Cesium.Cartesian3.multiplyByScalar(perp, bowDist, new Cesium.Cartesian3()),
            new Cesium.Cartesian3());
          // Parameter range trimmed to stay outside symbols
          const tStart = trimStart / dist;
          const tEnd = 1 - trimEnd / dist;
          // Sample arc points
          const points = [];
          for (let i = 0; i <= ARC_SEGMENTS; i++) {
            const t = tStart + (tEnd - tStart) * (i / ARC_SEGMENTS);
            const omt = 1 - t;
            const p = new Cesium.Cartesian3(
              omt * omt * currentPos.x + 2 * omt * t * control.x + t * t * parentPos.x,
              omt * omt * currentPos.y + 2 * omt * t * control.y + t * t * parentPos.y,
              omt * omt * currentPos.z + 2 * omt * t * control.z + t * t * parentPos.z,
            );
            points.push(p);
          }
          return points;
        }, false),
        width: 8,
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() => {
            try {
              const c = entity.billboard.color.getValue(Cesium.JulianDate.now());
              return Cesium.Color.fromCssColorString(BLUE).withAlpha(0.35 * c.alpha);
            } catch (e) {
              return Cesium.Color.fromCssColorString(BLUE).withAlpha(0.35);
            }
          }, false)
        ),
        clampToGround: true,
      },
      show: parentLinesEnabled && entity.show,
    });
    linesById[node.id] = lineEntity;
  }

  // Create canvas overlay for dots
  const container = document.getElementById("cesiumContainer");
  dotCanvas = document.createElement("canvas");
  dotCanvas.style.position = "absolute";
  dotCanvas.style.top = "0";
  dotCanvas.style.left = "0";
  dotCanvas.style.pointerEvents = "none";
  dotCanvas.style.opacity = "0.3";
  const syncCanvasSize = () => {
    const cw = viewer.canvas.clientWidth;
    const ch = viewer.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    dotCanvas.style.width = cw + "px";
    dotCanvas.style.height = ch + "px";
    dotCanvas.width = cw * dpr;
    dotCanvas.height = ch * dpr;
    dotCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  container.appendChild(dotCanvas);
  dotCtx = dotCanvas.getContext("2d");

  // Arrow canvas (full opacity, renders on top of everything)
  arrowCanvas = document.createElement("canvas");
  arrowCanvas.style.position = "absolute";
  arrowCanvas.style.top = "0";
  arrowCanvas.style.left = "0";
  arrowCanvas.style.pointerEvents = "none";
  container.appendChild(arrowCanvas);
  arrowCtx = arrowCanvas.getContext("2d");

  const syncCanvasSizes = () => {
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
  syncCanvasSizes();

  // Keep canvas size in sync with Cesium canvas
  const ro = new ResizeObserver(() => { syncCanvasSize(); syncCanvasSizes(); });
  ro.observe(viewer.canvas);

  updateHeatmapLayer();
  return { entitiesById, nodesById, allNodes };
}

// --- Zoom-based level ---

const ZOOM_THRESHOLDS = [3000, 10000, 30000, 70000]; // meters (distance to look-at point)

function levelForDist(dist) {
  for (let i = 0; i < ZOOM_THRESHOLDS.length; i++) {
    if (dist < ZOOM_THRESHOLDS[i]) return i;
  }
  return ZOOM_THRESHOLDS.length; // battalion
}

function cameraZoomDist(viewer) {
  // H / sin(-pitch) is the camera-to-focal-point distance.
  // It stays constant during orbit (tilt/rotate) and panning — only zoom changes it.
  const H = viewer.camera.positionCartographic.height;
  const sinDown = Math.sin(-viewer.camera.pitch); // 1 = straight down, 0 = horizon
  if (sinDown < 0.05) return null; // near-horizontal view, skip
  return H / sinDown;
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

export function onPreRender() {
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

function getNodesAtLevel(levelIdx) {
  const type = LEVEL_ORDER[levelIdx];
  return allNodes.filter(n => n.type === type);
}

function setLevel(newLevel, viewer) {
  if (newLevel === currentLevel || animating) return;
  if (newLevel < 0 || newLevel > LEVEL_ORDER.length - 1) return;

  const oldLevel = currentLevel;
  currentLevel = newLevel;

  if (newLevel > oldLevel) {
    // Merging: children converge to parent
    // For each step up, animate children → parent
    mergeStep(oldLevel, newLevel);
  } else {
    // Unmerging: parent expands to children
    unmergeStep(oldLevel, newLevel);
  }
}

function mergeStep(fromLevel, toLevel) {
  const anims = [];

  // Hide all levels except what's animating
  for (const node of allNodes) {
    const lvl = LEVEL_ORDER.indexOf(node.type);
    if (lvl < fromLevel || lvl > toLevel) {
      entitiesById[node.id].show = false;
    }
  }

  // Hide all commander/staff initially
  hideAllCmdStaff();

  // Fade out nodes at fromLevel in place
  const fromNodes = getNodesAtLevel(fromLevel);
  for (const node of fromNodes) {
    const entity = entitiesById[node.id];

    anims.push({
      entity,
      from: node.homePosition,
      to: node.homePosition,
      duration: ANIM_DURATION,
      fade: "out",
      onComplete: () => {
        entity.show = false;
        entity.position = node.homePosition;
      },
    });
  }

  // Also animate intermediate levels if jumping multiple levels
  for (let lvl = fromLevel + 1; lvl < toLevel; lvl++) {
    for (const node of getNodesAtLevel(lvl)) {
      entitiesById[node.id].show = false;
    }
  }

  // Fade OUT commander/staff of toLevel nodes (unit symbol replacing commander)
  for (const node of getNodesAtLevel(toLevel)) {
    const cmdE = cmdEntitiesById[node.id];
    if (cmdE) {
      cmdE.show = true;
      cmdE.position = node.cmdHomePosition;
      anims.push({
        entity: cmdE,
        from: node.cmdHomePosition,
        to: node.cmdHomePosition,
        duration: ANIM_DURATION,
        fade: "out",
        fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
        onComplete: () => { cmdE.show = false; },
      });
    }
    const staffEs = staffEntitiesById[node.id];
    if (staffEs && node.staffHomePositions) {
      for (let si = 0; si < staffEs.length; si++) {
        const se = staffEs[si];
        se.show = true;
        se.position = node.staffHomePositions[si];
        anims.push({
          entity: se,
          from: node.staffHomePositions[si],
          to: node.staffHomePositions[si],
          duration: ANIM_DURATION,
          fade: "out",
          fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
          onComplete: () => { se.show = false; },
        });
      }
    }
  }

  // Fade in parent entities at toLevel (twice as fast, delayed by half)
  for (const node of getNodesAtLevel(toLevel)) {
    const pe = entitiesById[node.id];
    pe.position = node.homePosition;
    anims.push({
      entity: pe,
      from: node.homePosition,
      to: node.homePosition,
      duration: ANIM_DURATION,
      fade: "in",
      popScale: true,
      fadeDelay: ANIM_DURATION * (1 - PARENT_FADE_RELATIVE_DURATION),
      fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
      onComplete: () => {
        pe.position = node.homePosition;
      },
    });
  }

  // After merge, show cmd/staff for the NEW parent level (toLevel+1) if exists
  if (toLevel + 1 < LEVEL_ORDER.length) {
    const newParentType = LEVEL_ORDER[toLevel + 1];
    for (const node of allNodes) {
      if (node.type === newParentType) {
        // Fade IN these cmd/staff
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
      }
    }
  }

  if (anims.length > 0) {
    playBeep(MERGE_BEEP_FREQ);
    startAnimations(anims);
    updateHeatmapLayer();
  } else {
    // No animations needed, just show correct level
    showLevel(toLevel);
  }
}

function unmergeStep(fromLevel, toLevel) {
  const anims = [];

  // Hide levels not involved in the animation
  for (const node of allNodes) {
    const lvl = LEVEL_ORDER.indexOf(node.type);
    if (lvl !== fromLevel && lvl !== toLevel) {
      entitiesById[node.id].show = false;
    }
  }

  // Hide all commander/staff initially
  hideAllCmdStaff();

  // Fade in nodes at toLevel in place
  const toNodes = getNodesAtLevel(toLevel);
  for (const node of toNodes) {
    const entity = entitiesById[node.id];

    anims.push({
      entity,
      from: node.homePosition,
      to: node.homePosition,
      duration: ANIM_DURATION,
      fade: "in",
      onComplete: () => {
        entity.position = node.homePosition;
      },
    });
  }

  // Fade out the old parent entities (twice as fast)
  for (const node of getNodesAtLevel(fromLevel)) {
    const pe = entitiesById[node.id];
    pe.position = node.homePosition;
    anims.push({
      entity: pe,
      from: node.homePosition,
      to: node.homePosition,
      duration: ANIM_DURATION,
      fade: "out",
      popScale: true,
      fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
      onComplete: () => {
        pe.show = false;
        pe.position = node.homePosition;
      },
    });
  }

  // Fade OUT commander/staff of the old parent level (fromLevel+1) — those units no longer have visible children at fromLevel
  if (fromLevel + 1 < LEVEL_ORDER.length) {
    const oldParentType = LEVEL_ORDER[fromLevel + 1];
    for (const node of allNodes) {
      if (node.type === oldParentType) {
        const cmdE = cmdEntitiesById[node.id];
        if (cmdE) {
          cmdE.show = true;
          cmdE.position = node.cmdHomePosition;
          anims.push({
            entity: cmdE,
            from: node.cmdHomePosition,
            to: node.cmdHomePosition,
            duration: ANIM_DURATION,
            fade: "out",
            fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
            onComplete: () => { cmdE.show = false; },
          });
        }
        const staffEs = staffEntitiesById[node.id];
        if (staffEs && node.staffHomePositions) {
          for (let si = 0; si < staffEs.length; si++) {
            const se = staffEs[si];
            se.show = true;
            se.position = node.staffHomePositions[si];
            anims.push({
              entity: se,
              from: node.staffHomePositions[si],
              to: node.staffHomePositions[si],
              duration: ANIM_DURATION,
              fade: "out",
              fadeDuration: ANIM_DURATION * PARENT_FADE_RELATIVE_DURATION,
              onComplete: () => { se.show = false; },
            });
          }
        }
      }
    }
  }

  // Fade IN commander/staff of fromLevel nodes (commander replacing unit symbol)
  for (const node of getNodesAtLevel(fromLevel)) {
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
  }

  if (anims.length > 0) {
    playBeep(UNMERGE_BEEP_FREQ);
    startAnimations(anims);
    updateHeatmapLayer();
  } else {
    showLevel(toLevel);
  }
}

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

const DOTS_DIRECT_CHILDREN_ONLY = false; // true: dots only for direct child level; false: all hidden people

function getHeatmapPositions() {
  // Returns array of { position, parentPosition } for each dot
  if (DOTS_DIRECT_CHILDREN_ONLY) {
    const results = [];
    for (const node of allNodes) {
      if (node.children.length === 0) continue; // leaf nodes don't have children to dot
      const entity = entitiesById[node.id];
      if (!entity || !entity.show) continue; // only visible units spawn child dots
      for (const child of node.children) {
        const childEntity = entitiesById[child.id];
        if (!childEntity || childEntity.show) continue; // child visible as unit billboard — no dot
        // Skip if child's commander is visible (child is unmerged, not collapsed)
        const cmdE = cmdEntitiesById[child.id];
        if (cmdE && cmdE.show) continue;
        results.push({ position: child.position, parentPosition: node.position });
      }
    }
    return results;
  }

  const results = [];
  for (const node of allNodes) {
    const parentPos = node.parent ? node.parent.position : node.position;
    // Individuals: include if their entity is hidden (but not by clustering)
    if (node.type === "individual") {
      const entity = entitiesById[node.id];
      if (entity && !entity.show && !clusteredEntities.has(entity)) results.push({ position: node.position, parentPosition: parentPos });
      continue;
    }
    // Commander: include if its entity is hidden (but not by clustering) and the unit billboard isn't shown
    const unitE = entitiesById[node.id];
    const cmdE = cmdEntitiesById[node.id];
    if (cmdE && !cmdE.show && !clusteredEntities.has(cmdE) && !(unitE && unitE.show)) results.push({ position: node.position, parentPosition: parentPos });
    // Staff: include each hidden staff member (but not by clustering)
    const staffEs = staffEntitiesById[node.id];
    if (staffEs && node.staff) {
      for (let i = 0; i < staffEs.length; i++) {
        if (!staffEs[i].show && !clusteredEntities.has(staffEs[i])) results.push({ position: node.staff[i].position, parentPosition: node.position });
      }
    }
  }
  return results;
}

//const DOT_SIZE  = 10;  // 10
//const DOT_ALPHA = 0.3;  // 1.0
const DOT_SIZE  = 100;  // 10
const DOT_ALPHA = 0.3;  // 1.0

function updateHeatmapLayer() {
  const viewer = moduleViewer;
  if (!viewer) return;

  dotWorldPositions = [];
  dotWorldLines = [];
  blobGroups = [];

  if (!militaryVisible) {
    // Hide all blob entities when military layer is off
    for (let i = 0; i < blobEntities.length; i++) blobEntities[i].show = false;
    return;
  }

  // Compute blob boundaries for each visible unit with children
  for (const node of allNodes) {
    const entity = entitiesById[node.id];
    if (!entity || !entity.show) continue;
    if (node.children.length === 0) continue;
    const leafPositions = collectDescendantLeafPositions(node);
    if (leafPositions.length < 1) continue;
    const boundaries = computeBlobBoundaries(leafPositions);
    for (const boundary of boundaries) {
      blobGroups.push({ boundary });
    }
  }

  // Update terrain-clamped polygon entities for blobs
  for (let i = 0; i < blobGroups.length; i++) {
    let blobE = blobEntities[i];
    if (!blobE) {
      blobE = viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(blobGroups[i].boundary),
          material: Cesium.Color.fromCssColorString("#2040FF").withAlpha(0.12),
          classificationType: Cesium.ClassificationType.BOTH,
        },
        polyline: {
          positions: [...blobGroups[i].boundary, blobGroups[i].boundary[0]],
          width: 2,
          material: Cesium.Color.fromCssColorString("#2040FF").withAlpha(0.3),
          clampToGround: true,
        },
        show: true,
      });
      blobE._isBlob = true;
      blobEntities.push(blobE);
    } else {
      blobE.polygon.hierarchy = new Cesium.PolygonHierarchy(blobGroups[i].boundary);
      blobE.polyline.positions = [...blobGroups[i].boundary, blobGroups[i].boundary[0]];
      blobE.show = true;
    }
  }
  // Hide unused blob entities
  for (let i = blobGroups.length; i < blobEntities.length; i++) {
    blobEntities[i].show = false;
  }

  const entries = getHeatmapPositions();

  for (let i = 0; i < entries.length; i++) {
    const { position: p, parentPosition: pp } = entries[i];
    const childPos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt + HEIGHT_ABOVE_TERRAIN);
    const parentPos = Cesium.Cartesian3.fromDegrees(pp.lon, pp.lat, pp.alt + HEIGHT_ABOVE_TERRAIN);

    // Store position for canvas drawing
    dotWorldPositions.push(childPos);
    dotWorldLines.push([parentPos, childPos]);
  }

  // Lines connecting visible billboards (or unmerged commanders) to their parent's position
  for (const node of allNodes) {
    if (!node.parent) continue;
    const entity = entitiesById[node.id];
    const cmdE = cmdEntitiesById[node.id];
    const visible = (entity && entity.show) || (cmdE && cmdE.show);
    if (!visible) continue;
    dotWorldLines.push([node.parent.homePosition, node.homePosition]);
  }

  // Lines connecting visible commander/staff to their unit's position
  for (const node of allNodes) {
    const cmdE = cmdEntitiesById[node.id];
    if (cmdE && cmdE.show) {
      dotWorldLines.push([node.homePosition, node.cmdHomePosition]);
    }
    const staffEs = staffEntitiesById[node.id];
    if (staffEs && node.staffHomePositions) {
      for (let si = 0; si < staffEs.length; si++) {
        if (staffEs[si].show) {
          dotWorldLines.push([node.homePosition, node.staffHomePositions[si]]);
        }
      }
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

    if (anims.length > 0) { manualMode = true; playBeep(MERGE_BEEP_FREQ); startAnimations(anims); }
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

  if (anims.length > 0) { manualMode = true; playBeep(MERGE_BEEP_FREQ); startAnimations(anims); }
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

  if (anims.length > 0) { manualMode = true; playBeep(UNMERGE_BEEP_FREQ); startAnimations(anims); }
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

let zoomDebounceTimer = null;
let clusterDebounceTimer = null;

export function setupZoomListener(viewer) {
  viewer.camera.changed.addEventListener(() => {
    if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
    zoomDebounceTimer = setTimeout(() => {
      if (!militaryVisible || manualMode || zoomLevelingDisabled) return;
      const dist = cameraZoomDist(viewer);
      if (dist === null) return;
      const newLevel = levelForDist(dist);
      if (newLevel !== currentLevel) {
        setLevel(newLevel, viewer);
      }
    }, 50);

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
    if (dotCanvas) dotCanvas.style.display = militaryVisible ? "" : "none";
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

  if (event.key >= "1" && event.key <= "5") {
    manualMode = false;
    const level = parseInt(event.key) - 1;
    setLevel(level, viewer);
    return true;
  }

  return false;
}

// --- Pre-render hook ---

export function setupPreRender(viewer) {
  viewer.scene.preRender.addEventListener(() => {
    onPreRender();
    // Visual clustering update
    if (clusterDirty && !animating) {
      clusterDirty = false;
      updateVisualClusters(viewer);
    }
    // Sync line visibility with entity visibility
    for (const node of allNodes) {
      const line = linesById[node.id];
      if (line) line.show = parentLinesEnabled && entitiesById[node.id].show;
    }
    // Draw dots on canvas overlay
    if (dotCanvas && dotCtx) {
      dotCtx.clearRect(0, 0, dotCanvas.width, dotCanvas.height);
      if (militaryVisible) {
        const scene = viewer.scene;
        // Draw lines
        if (dotWorldLines.length > 0) {
          dotCtx.strokeStyle = "#2040FF";
          dotCtx.lineWidth = 2;
          dotCtx.beginPath();
          for (let i = 0; i < dotWorldLines.length; i++) {
            const a = scene.cartesianToCanvasCoordinates(dotWorldLines[i][0]);
            const b = scene.cartesianToCanvasCoordinates(dotWorldLines[i][1]);
            if (!a || !b) continue;
            dotCtx.moveTo(a.x, a.y);
            dotCtx.lineTo(b.x, b.y);
          }
          dotCtx.stroke();
        }
        // Draw dots with heatmap density coloring
        if (dotWorldPositions.length > 0) {
          const DENSITY_RADIUS_M = 60; // 30m radius per dot, overlap at 60m
          const DENSITY_RADIUS_M_SQ = DENSITY_RADIUS_M * DENSITY_RADIUS_M;
          // Project all dots to screen coordinates
          const screenPts = [];
          for (let i = 0; i < dotWorldPositions.length; i++) {
            const s = scene.cartesianToCanvasCoordinates(dotWorldPositions[i]);
            screenPts.push(s); // null if off-screen
          }
          // Compute per-dot neighbor count using world-space (meters) distances
          const counts = new Uint16Array(dotWorldPositions.length);
          let maxCount = 0;
          for (let i = 0; i < dotWorldPositions.length; i++) {
            if (!screenPts[i]) continue;
            for (let j = i + 1; j < dotWorldPositions.length; j++) {
              if (!screenPts[j]) continue;
              const distSq = Cesium.Cartesian3.distanceSquared(dotWorldPositions[i], dotWorldPositions[j]);
              if (distSq <= DENSITY_RADIUS_M_SQ) {
                counts[i]++;
                counts[j]++;
              }
            }
            if (counts[i] > maxCount) maxCount = counts[i];
          }
          // Final pass for maxCount (j>i increments may update later)
          if (maxCount === 0) maxCount = 1;
          for (let i = 0; i < counts.length; i++) {
            if (counts[i] > maxCount) maxCount = counts[i];
          }
          // Compute meters-per-pixel for perspective projection
          const camPos = scene.camera.positionWC;
          const fov = scene.camera.frustum.fovy || scene.camera.frustum.fov;
          const canvasHeight = scene.canvas.height;
          const DOT_RADIUS_M = 30; // 30m radius
          // Light blue (min) -> deep blue (max)
          // min: rgb(140, 200, 255), max: rgb(32, 64, 255)
          for (let i = 0; i < screenPts.length; i++) {
            if (!screenPts[i]) continue;
            const dist = Cesium.Cartesian3.distance(camPos, dotWorldPositions[i]);
            const metersPerPixel = 2 * dist * Math.tan(fov * 0.5) / canvasHeight;
            const pixelRadius = DOT_RADIUS_M / metersPerPixel;
            if (pixelRadius < 0.5) continue; // too small to see
            const t = counts[i] / maxCount;
            const r = Math.round(140 + (32 - 140) * t);
            const g = Math.round(200 + (64 - 200) * t);
            const b = 255;
            dotCtx.fillStyle = `rgb(${r},${g},${b})`;
            dotCtx.beginPath();
            dotCtx.arc(screenPts[i].x, screenPts[i].y, pixelRadius, 0, Math.PI * 2);
            dotCtx.fill();
          }
        }
      }
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
