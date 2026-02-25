#!/usr/bin/env node
// Generates military-units.json with a brigade deployed along a curved front line.
// Run: node generate-units.js > data/military-units.json

const fs = require("fs");

// --- Constants ---
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const M_PER_DEG_LAT = 111320;
const REF_LAT = 46.575; // reference latitude for lon scaling
const COS_LAT = Math.cos(REF_LAT * DEG_TO_RAD);
const M_PER_DEG_LON = M_PER_DEG_LAT * COS_LAT;

// --- Front line definition ---
// Concave arc (curving south) from SE to NW, ~25km
// Enemy is NORTH. "Behind" = south = decreasing lat.
// Define the curve as a quadratic bezier: SE endpoint, control point (south), NW endpoint.

const P0 = { lat: 46.51, lon: 8.11 };   // SE end
const P2 = { lat: 46.65, lon: 7.87 };   // NW end
// Control point south of midpoint for concave shape
const P1 = { lat: 46.54, lon: 7.99 };   // pulls the center south

function bezier(t) {
  const u = 1 - t;
  return {
    lat: u * u * P0.lat + 2 * u * t * P1.lat + t * t * P2.lat,
    lon: u * u * P0.lon + 2 * u * t * P1.lon + t * t * P2.lon,
  };
}

function bezierTangent(t) {
  const u = 1 - t;
  return {
    dlat: 2 * (u * (P1.lat - P0.lat) + t * (P2.lat - P1.lat)),
    dlon: 2 * (u * (P1.lon - P0.lon) + t * (P2.lon - P1.lon)),
  };
}

// Measure total arc length
function arcLength(nSamples) {
  let len = 0;
  let prev = bezier(0);
  for (let i = 1; i <= nSamples; i++) {
    const cur = bezier(i / nSamples);
    const dlat = (cur.lat - prev.lat) * M_PER_DEG_LAT;
    const dlon = (cur.lon - prev.lon) * M_PER_DEG_LON;
    len += Math.sqrt(dlat * dlat + dlon * dlon);
    prev = cur;
  }
  return len;
}

const TOTAL_ARC = arcLength(10000);
console.error(`Front line arc length: ${(TOTAL_ARC / 1000).toFixed(2)} km`);

// Map distance along arc to parameter t
function distanceToT(targetDist) {
  let accum = 0;
  let prev = bezier(0);
  const steps = 10000;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cur = bezier(t);
    const dlat = (cur.lat - prev.lat) * M_PER_DEG_LAT;
    const dlon = (cur.lon - prev.lon) * M_PER_DEG_LON;
    accum += Math.sqrt(dlat * dlat + dlon * dlon);
    if (accum >= targetDist) return t;
    prev = cur;
  }
  return 1;
}

// Get the "behind" direction (perpendicular to tangent, pointing south/away from enemy)
// Enemy is north, so "behind" is the direction with negative lat component of the normal
function getBehindDir(t) {
  const tang = bezierTangent(t);
  // tangent in meters
  const tx = tang.dlon * M_PER_DEG_LON;
  const ty = tang.dlat * M_PER_DEG_LAT;
  const len = Math.sqrt(tx * tx + ty * ty);
  // perpendicular: rotate 90° clockwise = (ty, -tx), or counter-clockwise = (-ty, tx)
  // We want the one pointing south (negative lat = negative ty direction in meters)
  let nx = -ty / len;
  let ny = tx / len;
  // If ny > 0 (pointing north), flip
  if (ny > 0) { nx = -nx; ny = -ny; }
  return { nx, ny }; // in meters per unit
}

// Offset a point by meters along front line normal ("behind") and along front line
function offsetPoint(baseLat, baseLon, t, behindM, alongM) {
  const behind = getBehindDir(t);
  const tang = bezierTangent(t);
  const tx = tang.dlon * M_PER_DEG_LON;
  const ty = tang.dlat * M_PER_DEG_LAT;
  const tlen = Math.sqrt(tx * tx + ty * ty);
  const tangNx = tx / tlen;
  const tangNy = ty / tlen;

  const totalDx = behind.nx * behindM + tangNx * alongM;
  const totalDy = behind.ny * behindM + tangNy * alongM;

  return {
    lat: baseLat + totalDy / M_PER_DEG_LAT,
    lon: baseLon + totalDx / M_PER_DEG_LON,
  };
}

// Random helpers
function randRange(min, max) {
  return min + Math.random() * (max - min);
}
function randSign() {
  return Math.random() < 0.5 ? -1 : 1;
}

// Altitude: use a base altitude that varies gently along the front
function getAltitude(lat, lon) {
  // Simple terrain model: higher in the south, lower in the north
  // Range roughly 1500-3000m
  const latNorm = (lat - 46.50) / 0.20; // 0 at south, 1 at north
  const lonNorm = (lon - 7.85) / 0.30;
  const base = 2800 - latNorm * 800 + Math.sin(lonNorm * Math.PI * 2) * 300;
  return Math.round(base + randRange(-50, 50));
}

// --- ID counters ---
let idCounter = 0;
function nextId(prefix) {
  return `${prefix}${++idCounter}`;
}

// --- Name pools ---
const CALLSIGNS = [
  "Viper", "Falcon", "Raptor", "Ghost", "Shadow", "Phoenix", "Thunder", "Eagle",
  "Wolf", "Cobra", "Frost", "Delta", "Romeo", "Ember", "Marshal", "Nitro",
  "Onyx", "Panther", "Bolt", "Kraken", "Trident", "Forge", "Interceptor",
  "Jackal", "Longbow", "Mongoose", "Nighthawk", "Papa", "Quebec", "Sierra",
  "Whiskey", "Flint", "Warden", "Inferno", "Razor", "Sentinel", "Vanguard",
  "Gladius", "Outlaw", "Arsenal", "Icarus", "Nemesis", "Corsair", "Kestrel",
  "Scorpion", "Ace", "Revenant", "Praetor", "Centurion", "Condor", "Harrier",
  "Monarch", "Sovereign", "Sledgehammer", "Tomahawk", "Warlock", "Ares",
  "Raptor", "Bulldog", "Striker", "Overlord", "Sabre", "Talon", "Bravo",
  "Spartan", "Titan", "Nomad", "Blaze", "Hammer", "Iron", "Javelin",
  "Knight", "Lancer", "Storm", "Tempest", "Valkyrie", "Apex", "Fury",
  "Grizzly", "Hornet", "Inferno", "Neptune", "Odin", "Patriot", "Cipher",
  "Drake", "Legion", "Mirage", "Spectre", "Torque", "Dynamo", "Eclipse",
  "Goliath", "Hydra", "Leopard", "Mustang", "Nova", "Orion", "Phantom",
  "Viking", "Wolverine", "Zenith", "Atlas", "Bandit", "Dagger", "Enforcer",
  "Foxhound", "Gunner", "Hercules", "Juggernaut", "Kodiak", "Lynx", "Mantis",
  "Bishop", "Castle", "Draco", "Enigma", "Firestorm", "Quicksilver", "Ronin",
  "Umbra", "Vertex", "Wildfire", "Xenon", "Yeti", "Breaker", "Dominator",
  "Impulse", "Jester", "Rogue", "Maverick", "Echo", "Foxtrot", "Kilo",
  "Lima", "Oscar", "Tango", "Zulu", "Archer", "Hawk", "Reaper", "Phalanx",
  "Rampart", "Stalker", "Tigershark", "Vandal", "Wraith", "Brimstone",
  "Cutlass", "Deacon", "Falcon", "Griffin", "Havoc", "Ironside", "Jaguar",
  "Katana", "Loki", "Magnum", "Northstar", "Paladin", "Rapier", "Sable",
  "Templar", "Uppercut", "Vigil", "Warpath", "Yellowjacket", "Zero",
  "Anvil", "Barrage", "Claymore", "Dire", "Epoch", "Frostbite", "Galahad",
  "Hellfire", "Ibex", "Joker", "Krieg", "Locust", "Mace", "Nightfall",
  "Ogre", "Pyre", "Quake", "Reckoner", "Scythe", "Typhon", "Undertow",
  "Vortex", "Wyvern", "Crossbow", "Bastion", "Caliber", "Detonate",
  "Exarch", "Flare", "Gale", "Hoplite", "Invictus", "Jolt",
];
let callsignIdx = 0;
function nextCallsign() {
  const name = CALLSIGNS[callsignIdx % CALLSIGNS.length];
  callsignIdx++;
  return name;
}

// --- Build hierarchy ---

// Structure counts
const REGIMENTS_PER_BRIGADE = 3;
const BATTALIONS_PER_REGIMENT = 3;
const COMPANIES_PER_BATTALION = 3;
const PLATOONS_PER_COMPANY = 3;
const SQUADS_PER_PLATOON = 3;
const INDIVIDUALS_PER_SQUAD = 12;

const TOTAL_SQUADS = REGIMENTS_PER_BRIGADE * BATTALIONS_PER_REGIMENT *
  COMPANIES_PER_BATTALION * PLATOONS_PER_COMPANY * SQUADS_PER_PLATOON; // 243

const SQUAD_FRONTAGE = TOTAL_ARC / TOTAL_SQUADS; // ~100m per squad
console.error(`Squad frontage: ${SQUAD_FRONTAGE.toFixed(1)} m (${TOTAL_SQUADS} squads)`);

// Pre-compute front line positions for each squad
const squadFrontPositions = [];
for (let i = 0; i < TOTAL_SQUADS; i++) {
  const centerDist = (i + 0.5) * SQUAD_FRONTAGE;
  const t = distanceToT(centerDist);
  const pos = bezier(t);
  squadFrontPositions.push({ ...pos, t, dist: centerDist });
}

// Build a staff pair near a commander position
function makeStaff(parentId, cmdLat, cmdLon, cmdAlt) {
  const staff = [];
  for (let s = 0; s < 2; s++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = randRange(8, 20);
    const sLat = cmdLat + (dist * Math.sin(angle)) / M_PER_DEG_LAT;
    const sLon = cmdLon + (dist * Math.cos(angle)) / M_PER_DEG_LON;
    staff.push({
      id: nextId("staff"),
      name: `Stf. ${nextCallsign()}`,
      position: {
        lat: parseFloat(sLat.toFixed(6)),
        lon: parseFloat(sLon.toFixed(6)),
        alt: cmdAlt,
      },
    });
  }
  return staff;
}

// Create individuals for a squad
function makeIndividuals(squadIdx) {
  const front = squadFrontPositions[squadIdx];
  const individuals = [];
  for (let i = 0; i < INDIVIDUALS_PER_SQUAD; i++) {
    // Spread along the squad's frontage
    const alongOffset = (i / (INDIVIDUALS_PER_SQUAD - 1) - 0.5) * SQUAD_FRONTAGE * 0.9;
    // Random depth: ±50m from front line (positive = behind/south, negative = forward/north)
    const depthOffset = randRange(-50, 50);
    const pos = offsetPoint(front.lat, front.lon, front.t, depthOffset, alongOffset);
    const alt = getAltitude(pos.lat, pos.lon);
    individuals.push({
      id: nextId("ind"),
      name: `Ind. ${nextCallsign()}`,
      type: "individual",
      position: {
        lat: parseFloat(pos.lat.toFixed(6)),
        lon: parseFloat(pos.lon.toFixed(6)),
        alt,
      },
      children: [],
    });
  }
  return individuals;
}

// Compute centroid of children positions
function centroid(children) {
  let sLat = 0, sLon = 0, sAlt = 0;
  for (const c of children) {
    sLat += c.position.lat;
    sLon += c.position.lon;
    sAlt += c.position.alt;
  }
  const n = children.length;
  return { lat: sLat / n, lon: sLon / n, alt: Math.round(sAlt / n) };
}

// Place commander behind (south of) children centroid
function makeCommander(children, behindM, prefix, t) {
  const cent = centroid(children);
  // Use the t parameter of the first child's squad region for direction
  const pos = offsetPoint(cent.lat, cent.lon, t, behindM, 0);
  const alt = getAltitude(pos.lat, pos.lon);
  return {
    commander: {
      id: nextId("cmd"),
      name: `Cmd. ${nextCallsign()}`,
    },
    position: {
      lat: parseFloat(pos.lat.toFixed(6)),
      lon: parseFloat(pos.lon.toFixed(6)),
      alt,
    },
  };
}

// --- Generate the full tree ---

let squadGlobalIdx = 0;

function generateSquad() {
  const idx = squadGlobalIdx++;
  const individuals = makeIndividuals(idx);
  const front = squadFrontPositions[idx];
  const { commander, position } = makeCommander(individuals, randRange(50, 100), "cmd", front.t);

  return {
    id: nextId("sq"),
    name: `${squadGlobalIdx} Sqd`,
    type: "squad",
    position,
    children: individuals,
    commander,
  };
}

function generatePlatoon(platoonNum) {
  const squads = [];
  // Average t for direction
  const firstIdx = squadGlobalIdx;
  for (let i = 0; i < SQUADS_PER_PLATOON; i++) {
    squads.push(generateSquad());
  }
  const midIdx = Math.floor((firstIdx + squadGlobalIdx - 1) / 2);
  const t = squadFrontPositions[Math.min(midIdx, TOTAL_SQUADS - 1)].t;
  const { commander, position } = makeCommander(squads, randRange(80, 150), "cmd", t);

  return {
    id: nextId("pl"),
    name: `${platoonNum} Plt`,
    type: "platoon",
    position,
    children: squads,
    commander,
    staff: makeStaff(null, position.lat, position.lon, position.alt),
  };
}

function generateCompany(companyNum) {
  const platoons = [];
  const firstIdx = squadGlobalIdx;
  for (let i = 0; i < PLATOONS_PER_COMPANY; i++) {
    platoons.push(generatePlatoon(companyNum * 10 + i + 1));
  }
  const midIdx = Math.floor((firstIdx + squadGlobalIdx - 1) / 2);
  const t = squadFrontPositions[Math.min(midIdx, TOTAL_SQUADS - 1)].t;
  const { commander, position } = makeCommander(platoons, randRange(150, 250), "cmd", t);

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return {
    id: nextId("co"),
    name: `${letters[companyNum % 26]} Co`,
    type: "company",
    position,
    children: platoons,
    commander,
    staff: makeStaff(null, position.lat, position.lon, position.alt),
  };
}

function generateBattalion(bnNum) {
  const companies = [];
  const firstIdx = squadGlobalIdx;
  for (let i = 0; i < COMPANIES_PER_BATTALION; i++) {
    companies.push(generateCompany(bnNum * COMPANIES_PER_BATTALION + i));
  }
  const midIdx = Math.floor((firstIdx + squadGlobalIdx - 1) / 2);
  const t = squadFrontPositions[Math.min(midIdx, TOTAL_SQUADS - 1)].t;
  const { commander, position } = makeCommander(companies, randRange(300, 500), "cmd", t);

  return {
    id: nextId("bn"),
    name: `${bnNum + 1} Bn`,
    type: "battalion",
    position,
    children: companies,
    commander,
    staff: makeStaff(null, position.lat, position.lon, position.alt),
  };
}

function generateRegiment(rgtNum) {
  const battalions = [];
  const firstIdx = squadGlobalIdx;
  for (let i = 0; i < BATTALIONS_PER_REGIMENT; i++) {
    battalions.push(generateBattalion(rgtNum * BATTALIONS_PER_REGIMENT + i));
  }
  const midIdx = Math.floor((firstIdx + squadGlobalIdx - 1) / 2);
  const t = squadFrontPositions[Math.min(midIdx, TOTAL_SQUADS - 1)].t;
  const { commander, position } = makeCommander(battalions, randRange(500, 800), "cmd", t);

  return {
    id: nextId("rgt"),
    name: `${rgtNum + 1} Rgt`,
    type: "regiment",
    position,
    children: battalions,
    commander,
    staff: makeStaff(null, position.lat, position.lon, position.alt),
  };
}

function generateBrigade() {
  const regiments = [];
  const firstIdx = squadGlobalIdx;
  for (let i = 0; i < REGIMENTS_PER_BRIGADE; i++) {
    regiments.push(generateRegiment(i));
  }
  const midIdx = Math.floor((firstIdx + squadGlobalIdx - 1) / 2);
  const t = squadFrontPositions[Math.min(midIdx, TOTAL_SQUADS - 1)].t;
  const { commander, position } = makeCommander(regiments, randRange(800, 1200), "cmd", t);

  return {
    id: nextId("bde"),
    name: "1 Bde",
    type: "brigade",
    position,
    children: regiments,
    commander,
    staff: makeStaff(null, position.lat, position.lon, position.alt),
  };
}

// --- Main ---
const brigade = generateBrigade();
fs.writeFileSync("data/military-units.json", JSON.stringify(brigade, null, 2) + "\n");

// Stats
function countNodes(node) {
  let count = 1;
  for (const c of node.children) count += countNodes(c);
  return count;
}
console.error(`Total nodes: ${countNodes(brigade)}`);
console.error(`Total squads: ${TOTAL_SQUADS}`);
console.error(`Total individuals: ${TOTAL_SQUADS * INDIVIDUALS_PER_SQUAD}`);
console.error(`Written to data/military-units.json`);
