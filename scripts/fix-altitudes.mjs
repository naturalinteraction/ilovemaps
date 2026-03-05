#!/usr/bin/env node
// Fix altitudes in other-units.json using terrain elevation data.
// Ground units: terrain + 2m, UAVs: terrain + random(100,300)m

import { readFileSync, writeFileSync } from "fs";

const INPUT = "data/other-units.json";
const data = JSON.parse(readFileSync(INPUT, "utf-8"));

// Open-Meteo elevation API accepts max 100 coords per request
async function fetchElevations(units) {
  const batchSize = 100;
  const elevations = [];
  for (let i = 0; i < units.length; i += batchSize) {
    const batch = units.slice(i, i + batchSize);
    const lats = batch.map(u => u.position.lat).join(",");
    const lons = batch.map(u => u.position.lon).join(",");
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) throw new Error(json.reason);
    elevations.push(...json.elevation);
    console.log(`Fetched elevations ${i + 1}-${i + batch.length} of ${units.length}`);
  }
  return elevations;
}

const elevations = await fetchElevations(data);

for (let i = 0; i < data.length; i++) {
  const ground = elevations[i];
  if (data[i].entity === "uav") {
    data[i].position.alt = Math.round(ground + 100 + Math.random() * 200);
  } else {
    data[i].position.alt = Math.round(ground + 2);
  }
}

writeFileSync(INPUT, JSON.stringify(data, null, 2) + "\n");
console.log(`Updated ${data.length} units in ${INPUT}`);
