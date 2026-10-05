import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const CHUNK = 26000;
const OUT = "output";
mkdirSync(OUT, { recursive: true });

const log = (m) => console.log("[prep] " + m);
const status = { started: new Date().toISOString(), sources: {} };

function chunkString(name, text) {
  const n = Math.ceil(text.length / CHUNK);
  for (let i = 0; i < n; i++) {
    writeFileSync(OUT + "/" + name + "__" + String(i).padStart(3, "0") + ".txt", text.slice(i * CHUNK, (i + 1) * CHUNK));
  }
  writeFileSync(OUT + "/" + name + "__manifest.json", JSON.stringify({ name: name, chunks: n, length: text.length }));
  log(name + ": " + n + " chunks, " + text.length + " chars");
}

async function fetchFirst(urls) {
  let lastErr = null;
  for (const url of urls) {
    for (let a = 1; a <= 2; a++) {
      try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
        const text = await res.text();
        if (text.length < 100) throw new Error("too short: " + text.slice(0, 80));
        return text;
      } catch (e) {
        lastErr = e;
        log("retry " + a + " failed: " + e.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastErr;
}

const SOURCES = [
  { name: "countries110", urls: [
      "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
      "https://unpkg.com/world-atlas@2.0.2/countries-110m.json",
  ]},
  { name: "rivers110", urls: [
      "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_rivers_lake_centerlines.geojson",
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_rivers_lake_centerlines.geojson",
  ]},
  { name: "lakes110", urls: [
      "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_lakes.geojson",
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_lakes.geojson",
  ]},
  { name: "admin150", urls: [
      "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_1_states_provinces.geojson",
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson",
  ], simplify: true },
];

for (const s of SOURCES) {
  try {
    let text = await fetchFirst(s.urls);
    if (s.simplify) {
      const inFile = s.name + ".geojson";
      const outFile = s.name + ".topo.json";
      writeFileSync(inFile, text);
      try {
        execSync("npx -y mapshaper@1.0.1 " + inFile + " -simplify visvalingam 10% keep-shapes -clean -o format=topojson quantization=1e5 " + outFile, { stdio: "inherit", timeout: 300000 });
        text = readFileSync(outFile, "utf8");
      } catch (e) {
        log("mapshaper failed for " + s.name + "; chunking raw geojson instead: " + (e && e.message));
      }
    }
    chunkString(s.name, text);
    status.sources[s.name] = "ok";
  } catch (e) {
    status.sources[s.name] = "error: " + (e && e.message);
    try {
      writeFileSync(OUT + "/" + s.name + "__manifest.json", JSON.stringify({ name: s.name, error: String(e && e.message || e) }));
    } catch (e2) {}
  }
}

status.finished = new Date().toISOString();
writeFileSync(OUT + "/status.json", JSON.stringify(status, null, 1));
log("DONE");
