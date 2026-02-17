import * as Cesium from "cesium";

// --- Symbol rendering ---

const SYMBOL_SIZE = 64;
const BLUE = "#2040FF";

function drawMilitarySymbol(type) {
  const canvas = document.createElement("canvas");
  canvas.width = SYMBOL_SIZE;
  canvas.height = SYMBOL_SIZE;
  const ctx = canvas.getContext("2d");

  // Rectangle body
  const rx = 10, ry = 20, rw = 44, rh = 24;
  ctx.strokeStyle = BLUE;
  ctx.fillStyle = "rgba(30,60,255,0.6)";
  ctx.lineWidth = 2;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeRect(rx, ry, rw, rh);

  // Echelon marker above rectangle
  const cx = SYMBOL_SIZE / 2;
  ctx.fillStyle = BLUE;
  ctx.strokeStyle = BLUE;
  ctx.lineWidth = 2;

  if (type === "squad") {
    // × (cross)
    const y = ry - 4;
    ctx.beginPath();
    ctx.moveTo(cx - 5, y - 5); ctx.lineTo(cx + 5, y + 5);
    ctx.moveTo(cx + 5, y - 5); ctx.lineTo(cx - 5, y + 5);
    ctx.stroke();
  } else if (type === "platoon") {
    // • • •
    const y = ry - 6;
    for (const dx of [-8, 0, 8]) {
      ctx.beginPath();
      ctx.arc(cx + dx, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (type === "company") {
    // |
    ctx.beginPath();
    ctx.moveTo(cx, ry - 2); ctx.lineTo(cx, ry - 12);
    ctx.stroke();
  } else if (type === "battalion") {
    // | |
    ctx.beginPath();
    ctx.moveTo(cx - 5, ry - 2); ctx.lineTo(cx - 5, ry - 12);
    ctx.moveTo(cx + 5, ry - 2); ctx.lineTo(cx + 5, ry - 12);
    ctx.stroke();
  }

  return canvas;
}

// Cache billboard images
const symbolImages = {};
function getSymbolImage(type) {
  if (!symbolImages[type]) {
    symbolImages[type] = drawMilitarySymbol(type);
  }
  return symbolImages[type];
}

// --- Data structures ---

const LEVEL_ORDER = ["squad", "platoon", "company", "battalion"];

// All nodes indexed by id
const nodesById = {};
// Flat list of all nodes
let allNodes = [];
// Root node
let rootNode = null;

// Cesium entities indexed by node id
const entitiesById = {};
// Polyline entities connecting each node to its parent
const linesById = {};
// Scratch variables for polyline position computation
const scratchDir = new Cesium.Cartesian3();
const scratchOffset = new Cesium.Cartesian3();
const scratchStart = new Cesium.Cartesian3();
const scratchEnd = new Cesium.Cartesian3();
const ARC_SEGMENTS = 16;
const ARC_BOW = 0.15; // perpendicular offset as fraction of distance

// Current visible level index (0=squad, 3=battalion)
let currentLevel = 0;
let militaryVisible = true;
let manualMode = false; // disables zoom-based auto-leveling after click merge/unmerge

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
    node.position.lon, node.position.lat, node.position.alt + 50
  );
  for (const child of node.children) {
    flattenTree(child, node);
  }
}

export async function loadMilitaryUnits(viewer) {
  const response = await fetch("/data/military-units.json");
  const tree = await response.json();
  allNodes = [];
  rootNode = tree;
  flattenTree(tree, null);

  for (const node of allNodes) {
    const levelIdx = LEVEL_ORDER.indexOf(node.type);
    const image = getSymbolImage(node.type);

    const entity = viewer.entities.add({
      name: node.name,
      position: node.homePosition,
      billboard: {
        image,
        width: SYMBOL_SIZE,
        height: SYMBOL_SIZE,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: node.name,
        font: "20px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.TOP,
        pixelOffset: new Cesium.Cartesian2(0, SYMBOL_SIZE / 2 + 4),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      show: levelIdx === currentLevel,
    });

    entity._milNode = node;
    entitiesById[node.id] = entity;
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
        material: Cesium.Color.fromCssColorString(BLUE).withAlpha(0.5),
        clampToGround: true,
      },
      show: entity.show,
    });
    linesById[node.id] = lineEntity;
  }

  return { entitiesById, nodesById, allNodes };
}

// --- Zoom-based level ---

const ZOOM_THRESHOLDS = [9000, 32000, 60000]; // meters

function levelForHeight(height) {
  for (let i = 0; i < ZOOM_THRESHOLDS.length; i++) {
    if (height < ZOOM_THRESHOLDS[i]) return i;
  }
  return ZOOM_THRESHOLDS.length; // battalion
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

  // Animate nodes at fromLevel → their ancestor at toLevel
  const fromNodes = getNodesAtLevel(fromLevel);
  for (const node of fromNodes) {
    const entity = entitiesById[node.id];
    // Find ancestor at toLevel
    let ancestor = node;
    while (ancestor && LEVEL_ORDER.indexOf(ancestor.type) < toLevel) {
      ancestor = ancestor.parent;
    }
    if (!ancestor) continue;

    const fromPos = node.homePosition;
    const toPos = ancestor.homePosition;

    anims.push({
      entity,
      from: fromPos,
      to: toPos,
      duration: ANIM_DURATION,
      fade: "out",
      onComplete: () => {
        entity.show = false;
        entity.position = node.homePosition; // reset
      },
    });
  }

  // Also animate intermediate levels if jumping multiple levels
  for (let lvl = fromLevel + 1; lvl < toLevel; lvl++) {
    for (const node of getNodesAtLevel(lvl)) {
      entitiesById[node.id].show = false;
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

  if (anims.length > 0) {
    playBeep(MERGE_BEEP_FREQ);
    startAnimations(anims);
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

  // Animate nodes at toLevel from their ancestor at fromLevel
  const toNodes = getNodesAtLevel(toLevel);
  for (const node of toNodes) {
    const entity = entitiesById[node.id];
    // Find ancestor at fromLevel
    let ancestor = node;
    while (ancestor && LEVEL_ORDER.indexOf(ancestor.type) < fromLevel) {
      ancestor = ancestor.parent;
    }
    if (!ancestor) continue;

    const fromPos = ancestor.homePosition;
    const toPos = node.homePosition;

    anims.push({
      entity,
      from: fromPos,
      to: toPos,
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

  if (anims.length > 0) {
    playBeep(UNMERGE_BEEP_FREQ);
    startAnimations(anims);
  } else {
    showLevel(toLevel);
  }
}

function showLevel(levelIdx) {
  const type = LEVEL_ORDER[levelIdx];
  for (const node of allNodes) {
    const entity = entitiesById[node.id];
    entity.show = militaryVisible && node.type === type;
    entity.position = node.homePosition;
  }
}

// --- Click toggle ---

function pickMilNode(viewer, click) {
  if (animating) return null;
  const picked = viewer.scene.pick(click.position);
  if (!picked || !(picked.id instanceof Cesium.Entity)) return null;
  const entity = picked.id;
  const node = entity._milNode;
  if (!node || node.children.length === 0) return null;
  const childType = LEVEL_ORDER[LEVEL_ORDER.indexOf(node.type) - 1];
  if (!childType) return null;
  return { entity, node, childType };
}

export function handleRightClick(viewer, click) {
  if (animating) return false;
  const picked = viewer.scene.pick(click.position);
  if (!picked || !(picked.id instanceof Cesium.Entity)) return false;
  const entity = picked.id;
  const node = entity._milNode;
  if (!node || !node.parent) return false; // need a parent to merge into

  const parent = node.parent;
  const parentEntity = entitiesById[parent.id];
  const childType = node.type;

  const anims = [];
  forEachDescendantAtLevel(parent, childType, (desc) => {
    const e = entitiesById[desc.id];
    anims.push({
      entity: e,
      from: desc.homePosition,
      to: parent.homePosition,
      duration: ANIM_DURATION,
      fade: "out",
      onComplete: () => {
        e.show = false;
        e.position = desc.homePosition;
      },
    });
  });
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
  if (anims.length > 0) { manualMode = true; playBeep(MERGE_BEEP_FREQ); startAnimations(anims); }
  return true;
}

export function handleLeftClick(viewer, click) {
  const hit = pickMilNode(viewer, click);
  if (!hit) return false;
  const { entity, node, childType } = hit;

  const firstChild = node.children[0];
  const childEntity = entitiesById[firstChild.id];
  if (childEntity.show) return false; // children already visible, nothing to unmerge

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
      from: node.homePosition,
      to: desc.homePosition,
      duration: ANIM_DURATION,
      fade: "in",
      onComplete: () => {
        e.position = desc.homePosition;
      },
    });
  });
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

// --- Zoom listener ---

let zoomDebounceTimer = null;

export function setupZoomListener(viewer) {
  viewer.camera.changed.addEventListener(() => {
    if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
    zoomDebounceTimer = setTimeout(() => {
      if (!militaryVisible || manualMode) return;
      const height = viewer.camera.positionCartographic.height;
      const newLevel = levelForHeight(height);
      if (newLevel !== currentLevel) {
        setLevel(newLevel, viewer);
      }
    }, 50);
  });
  viewer.camera.percentageChanged = 0.1;
}

// --- Keyboard ---

export function handleKeydown(event, viewer) {
  if (event.key === "m" || event.key === "M") {
    militaryVisible = !militaryVisible;
    if (!animating) {
      for (const node of allNodes) {
        const entity = entitiesById[node.id];
        if (militaryVisible) {
          entity.show = node.type === LEVEL_ORDER[currentLevel];
        } else {
          entity.show = false;
        }
      }
    }
    return true;
  }

  if (event.key >= "1" && event.key <= "4") {
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
    // Sync line visibility with entity visibility
    for (const node of allNodes) {
      const line = linesById[node.id];
      if (line) line.show = entitiesById[node.id].show;
    }
  });
}
