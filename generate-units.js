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

const P0 = { lat: 46.51, lon: 8.10 };   // SE end
const P2 = { lat: 46.65, lon: 7.88 };   // NW end
// Control point south of midpoint for concave shape
const P1 = { lat: 46.46, lon: 7.99 };   // pulls the center south (3x curvature)

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

// --- Bumpy front line ---
// Multiple harmonics for an irregular, natural-looking front line
const BUMPS = [
  { freq: 9,   amp: 280, phase: 0 },
  { freq: 15,  amp: 150, phase: 1.3 },
  { freq: 23,  amp: 90,  phase: 2.7 },
  { freq: 37,  amp: 50,  phase: 0.8 },
  { freq: 53,  amp: 30,  phase: 4.1 },
].map(b => ({ ...b, amp: b.amp * (1 + Math.random() * 2) }));

function frontLine(t) {
  const base = bezier(t);
  const tang = bezierTangent(t);
  const tx = tang.dlon * M_PER_DEG_LON;
  const ty = tang.dlat * M_PER_DEG_LAT;
  const len = Math.sqrt(tx * tx + ty * ty);
  // Perpendicular direction (consistent side)
  const nx = -ty / len;
  const ny = tx / len;
  let bumpOffset = 0;
  for (const b of BUMPS) {
    bumpOffset += Math.sin(b.freq * Math.PI * t + b.phase) * b.amp;
  }
  return {
    lat: base.lat + (ny * bumpOffset) / M_PER_DEG_LAT,
    lon: base.lon + (nx * bumpOffset) / M_PER_DEG_LON,
  };
}

function frontLineTangent(t) {
  const dt = 0.00005;
  const a = frontLine(Math.max(0, t - dt));
  const b = frontLine(Math.min(1, t + dt));
  return {
    dlat: (b.lat - a.lat) / (2 * dt),
    dlon: (b.lon - a.lon) / (2 * dt),
  };
}

// Measure total arc length
function arcLength(nSamples) {
  let len = 0;
  let prev = frontLine(0);
  for (let i = 1; i <= nSamples; i++) {
    const cur = frontLine(i / nSamples);
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
  let prev = frontLine(0);
  const steps = 10000;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cur = frontLine(t);
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
  const tang = frontLineTangent(t);
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
  const tang = frontLineTangent(t);
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

// --- Elevation lookup via Open-Meteo API ---
// Batch-query real terrain elevation for all positions
const ELEVATION_BATCH_SIZE = 100;

async function fetchElevations(coords) {
  // coords: array of { lat, lon }
  // Uses Open Topo Data with SRTM 90m dataset
  const results = new Array(coords.length);
  for (let i = 0; i < coords.length; i += ELEVATION_BATCH_SIZE) {
    const batch = coords.slice(i, i + ELEVATION_BATCH_SIZE);
    const locations = batch.map(c => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`).join("|");
    const url = `https://api.opentopodata.org/v1/srtm90m?locations=${locations}`;
    // Retry with backoff
    let resp, data;
    for (let attempt = 0; attempt < 5; attempt++) {
      resp = await fetch(url);
      if (resp.ok) {
        data = await resp.json();
        break;
      }
      if (resp.status === 429) {
        const wait = (attempt + 1) * 2000;
        console.error(`  Rate limited, waiting ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw new Error(`Elevation API error: ${resp.status}`);
      }
    }
    if (!data) throw new Error("Elevation API: too many retries");
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = Math.round(data.results[j].elevation || 0);
    }
    console.error(`  ${Math.min(i + ELEVATION_BATCH_SIZE, coords.length)}/${coords.length} elevations fetched`);
    // 1 request per second limit for opentopodata
    await new Promise(r => setTimeout(r, 1100));
  }
  return results;
}

// Placeholder during generation — real altitude filled in later
function getAltitude() {
  return 0; // will be replaced by real elevation
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
const INDIVIDUALS_PER_SQUAD = 11;

const TOTAL_SQUADS = REGIMENTS_PER_BRIGADE * BATTALIONS_PER_REGIMENT *
  COMPANIES_PER_BATTALION * PLATOONS_PER_COMPANY * SQUADS_PER_PLATOON; // 243

const SQUAD_FRONTAGE = TOTAL_ARC / TOTAL_SQUADS; // ~100m per squad
console.error(`Squad frontage: ${SQUAD_FRONTAGE.toFixed(1)} m (${TOTAL_SQUADS} squads)`);

// Pre-compute front line positions for each squad
const squadFrontPositions = [];
for (let i = 0; i < TOTAL_SQUADS; i++) {
  const centerDist = (i + 0.5) * SQUAD_FRONTAGE;
  const t = distanceToT(centerDist);
  const pos = frontLine(t);
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
function makeIndividuals(squadIdx, squadDepthOffset) {
  const front = squadFrontPositions[squadIdx];
  const individuals = [];
  const squadSpread = randRange(50, 90); // meters, leaves gaps between squads
  for (let i = 0; i < INDIVIDUALS_PER_SQUAD; i++) {
    // Spread along a random portion of the squad's frontage
    const alongOffset = (i / (INDIVIDUALS_PER_SQUAD - 1) - 0.5) * squadSpread;
    // Individual jitter within the squad (±15m) plus squad-level offset
    const depthOffset = squadDepthOffset + randRange(-15, 15);
    const pos = offsetPoint(front.lat, front.lon, front.t, depthOffset, alongOffset);
    const alt = getAltitude(pos.lat, pos.lon);
    individuals.push({
      id: nextId("ind"),
      name: `${nextCallsign()}`,
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

// --- Global "behind" and "along" directions based on overall front (P0→P2) ---
// This avoids local bumps flipping the direction
const FRONT_DX = (P2.lon - P0.lon) * M_PER_DEG_LON; // overall front line in meters (x)
const FRONT_DY = (P2.lat - P0.lat) * M_PER_DEG_LAT; // overall front line in meters (y)
const FRONT_LEN = Math.sqrt(FRONT_DX * FRONT_DX + FRONT_DY * FRONT_DY);
// Unit vectors along the front line
const ALONG_X = FRONT_DX / FRONT_LEN;
const ALONG_Y = FRONT_DY / FRONT_LEN;
// Perpendicular "behind" direction (away from enemy)
// Rotate 90° clockwise: (y, -x), then pick the one pointing south (negative lat)
let BEHIND_X = FRONT_DY / FRONT_LEN;
let BEHIND_Y = -FRONT_DX / FRONT_LEN;
if (BEHIND_Y > 0) { BEHIND_X = -BEHIND_X; BEHIND_Y = -BEHIND_Y; }

// Place commander behind the front line midpoint for this unit
// Uses global behind/along directions so bumps can't flip the offset
function makeCommander(behindM, t, lateralM) {
  const ref = frontLine(t);
  const lat = ref.lat + (BEHIND_Y * behindM + ALONG_Y * (lateralM || 0)) / M_PER_DEG_LAT;
  const lon = ref.lon + (BEHIND_X * behindM + ALONG_X * (lateralM || 0)) / M_PER_DEG_LON;
  const alt = getAltitude(lat, lon);
  return {
    id: nextId("cmd"),
    name: `Cmd. ${nextCallsign()}`,
    position: {
      lat: parseFloat(lat.toFixed(6)),
      lon: parseFloat(lon.toFixed(6)),
      alt,
    },
  };
}

// --- Generate the full tree ---

let squadGlobalIdx = 0;

function generateSquad() {
  const idx = squadGlobalIdx++;
  // Each squad is randomly offset ±50m from the front line
  const squadDepthOffset = randRange(-50, 150);
  const individuals = makeIndividuals(idx, squadDepthOffset);
  const front = squadFrontPositions[idx];
  const commander = makeCommander(randRange(50, 100), front.t, randRange(-40, 40));   // squad: 50-100m

  return {
    id: nextId("sq"),
    name: `${squadGlobalIdx} Sqd`,
    type: "squad",
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
  const commander = makeCommander(randRange(250, 400), t, randRange(-100, 100));    // platoon: 250-400m

  return {
    id: nextId("pl"),
    name: `${platoonNum} Plt`,
    type: "platoon",
    children: squads,
    commander,
    staff: makeStaff(null, commander.position.lat, commander.position.lon, commander.position.alt),
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
  const commander = makeCommander(randRange(500, 700), t, randRange(-250, 250));    // company: 500-700m

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return {
    id: nextId("co"),
    name: `${letters[companyNum % 26]} Co`,
    type: "company",
    children: platoons,
    commander,
    staff: makeStaff(null, commander.position.lat, commander.position.lon, commander.position.alt),
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
  const commander = makeCommander(randRange(800, 1100), t, randRange(-500, 500));   // battalion: 800-1100m

  return {
    id: nextId("bn"),
    name: `${bnNum + 1} Bn`,
    type: "battalion",
    children: companies,
    commander,
    staff: makeStaff(null, commander.position.lat, commander.position.lon, commander.position.alt),
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
  const commander = makeCommander(randRange(1200, 1600), t, randRange(-800, 800));  // regiment: 1200-1600m

  return {
    id: nextId("rgt"),
    name: `${rgtNum + 1} Rgt`,
    type: "regiment",
    children: battalions,
    commander,
    staff: makeStaff(null, commander.position.lat, commander.position.lon, commander.position.alt),
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
  const commander = makeCommander(randRange(1800, 2400), t, randRange(-1500, 1500)); // brigade: 1800-2400m

  return {
    id: nextId("bde"),
    name: "1 Bde",
    type: "brigade",
    children: regiments,
    commander,
    staff: makeStaff(null, commander.position.lat, commander.position.lon, commander.position.alt),
  };
}

// --- Collect all positioned entities and patch real elevations ---

function collectPositions(node) {
  const positions = [];
  // Individuals have their own position
  if (node.type === "individual") {
    positions.push(node.position);
  }
  // Commander
  if (node.commander && node.commander.position) {
    positions.push(node.commander.position);
  }
  // Staff
  if (node.staff) {
    for (const s of node.staff) {
      positions.push(s.position);
    }
  }
  // Recurse
  for (const child of node.children) {
    positions.push(...collectPositions(child));
  }
  return positions;
}

function countNodes(node) {
  let count = 1;
  for (const c of node.children) count += countNodes(c);
  return count;
}

// --- Main ---
async function main() {
  const brigade = generateBrigade();

  // Collect all positions that need real elevation
  const allPositions = collectPositions(brigade);
  console.error(`Fetching elevation for ${allPositions.length} positions...`);

  const elevations = await fetchElevations(allPositions.map(p => ({ lat: p.lat, lon: p.lon })));
  for (let i = 0; i < allPositions.length; i++) {
    allPositions[i].alt = elevations[i];
  }

  fs.writeFileSync("data/military-units.json", JSON.stringify(brigade, null, 2) + "\n");

  console.error(`Total nodes: ${countNodes(brigade)}`);
  console.error(`Total squads: ${TOTAL_SQUADS}`);
  console.error(`Total individuals: ${TOTAL_SQUADS * INDIVIDUALS_PER_SQUAD}`);
  console.error(`Written to data/military-units.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
