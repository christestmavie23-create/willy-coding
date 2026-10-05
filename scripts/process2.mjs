import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const CHUNK = 26000;
const W = 4000, H = 2000;
const qx = (lon) => Math.round((lon + 180) / 360 * W);
const qy = (lat) => Math.round((90 - lat) / 180 * H);

mkdirSync("output", { recursive: true });
const log = (m) => console.log("[mesh] " + m);
const report = { started: new Date().toISOString() };

function writeInfo(extra) {
  try { writeFileSync("output/meshv4__info.json", JSON.stringify({ ...report, ...extra })); log("info written"); } catch (e) { log("info write failed: " + e.message); }
}

try {
  async function fetchFirst(urls) {
    let lastErr = null;
    for (const url of urls) {
      for (let a = 1; a <= 2; a++) {
        try {
          const res = await fetch(url, { redirect: "follow" });
          if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
          const text = await res.text();
          if (text.length < 100) throw new Error("too short");
          return text;
        } catch (e) { lastErr = e; log("retry " + a + " failed: " + e.message); await new Promise((r) => setTimeout(r, 2000)); }
      }
    }
    throw lastErr;
  }

  const text = await fetchFirst([
    "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_1_states_provinces.geojson",
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson",
  ]);
  writeFileSync("admin150.geojson", text);
  log("downloaded " + text.length + " chars");

  execSync("npm install --no-save --no-audit --no-fund mapshaper@0.7.76 2>&1", { timeout: 240000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  log("npm install done");

  let topoText = null;
  try {
    const out = execSync("node_modules/.bin/mapshaper admin150.geojson -simplify visvalingam 10% keep-shapes -clean -o admin150.topo.json format=topojson quantization=1e5 2>&1", { timeout: 300000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    log("mapshaper said: " + String(out).slice(0, 400));
    topoText = readFileSync("admin150.topo.json", "utf8");
    log("mapshaper ok: " + topoText.length + " chars");
  } catch (e) {
    const errText = ((e && e.stdout ? String(e.stdout) : "") + " || " + (e && e.stderr ? String(e.stderr) : "") + " || " + (e && e.message || e)).slice(0, 800);
    log("mapshaper failed: " + errText);
    writeInfo({ error: "mapshaper: " + errText });
    process.exit(0);
  }

  const topo = JSON.parse(topoText);
  const key = Object.keys(topo.objects)[0];
  const feats = topo.objects[key].geometries;
  const { scale, translate } = topo.transform;
  const arcsLL = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
  });
  log("feats=" + feats.length + " arcs=" + arcsLL.length);

  const users = new Map();
  const area = [];
  feats.forEach((f, fi) => {
    const geom = f.geometry || f;
    const bx = { x: 1e9, y: 1e9, X: -1e9, Y: -1e9 };
    const walk = (rings) => {
      for (const refs of rings) {
        if (!refs) continue;
        for (const ref of refs) {
          if (ref === null || ref === undefined) continue;
          const idx = ref < 0 ? ~ref : ref;
          if (!users.has(idx)) users.set(idx, []);
          users.get(idx).push(fi);
          const a = arcsLL[idx];
          if (a) for (const [lon, lat] of a) {
            const x = qx(lon), y = qy(lat);
            if (x < bx.x) bx.x = x;
            if (x > bx.X) bx.X = x;
            if (y < bx.y) bx.y = y;
            if (y > bx.Y) bx.Y = y;
          }
        }
      }
    };
    if (geom.type === "Polygon") walk(geom.arcs);
    else if (geom.type === "MultiPolygon") for (const poly of geom.arcs) walk(poly);
    area.push(Math.max(0, (bx.X - bx.x) * (bx.Y - bx.y)));
  });
  log("arcsWithUsers=" + users.size);

  const MIN_AREA = 50;
  const meshIdx = [];
  for (const [idx, us] of users) {
    const uniq = Array.from(new Set(us));
    if (uniq.length !== 2) continue;
    const [u1, u2] = uniq;
    const p1 = feats[u1].properties || (feats[u1].geometry && feats[u1].geometry.properties);
    const p2 = feats[u2].properties || (feats[u2].geometry && feats[u2].geometry.properties);
    const a1 = p1 && p1.admin;
    const a2 = p2 && p2.admin;
    if (!a1 || a1 !== a2) continue;
    if (area[u1] < MIN_AREA || area[u2] < MIN_AREA) continue;
    meshIdx.push(idx);
  }
  log("mesh candidates=" + meshIdx.length);

  function deltaEncode(abs) {
    if (abs.length < 4) return abs;
    const out = [abs[0], abs[1]];
    for (let i = 2; i < abs.length; i += 2) out.push(abs[i] - abs[i - 2], abs[i + 1] - abs[i - 1]);
    return out;
  }
  function buildMesh(minStep) {
    const out = [];
    for (const idx of meshIdx) {
      const abs = [];
      let lx = -9999, ly = -9999;
      for (const [lon, lat] of arcsLL[idx]) {
        const x = qx(lon), y = qy(lat);
        if ((x - lx) * (x - lx) + (y - ly) * (y - ly) < minStep * minStep) continue;
        abs.push(x, y); lx = x; ly = y;
      }
      if (abs.length >= 4) out.push(deltaEncode(abs));
    }
    return out;
  }

  let mesh = [], step = 1.0, chars = 0;
  for (const t of [0.9, 1.3, 1.7, 2.2, 2.8, 3.5]) {
    mesh = buildMesh(t);
    step = t;
    chars = JSON.stringify(mesh).length;
    log("step=" + t + " lines=" + mesh.length + " chars=" + chars);
    if (chars <= 105000) break;
  }

  const meshStr = JSON.stringify({ step: step, count: mesh.length, lines: mesh });
  const n = Math.ceil(meshStr.length / CHUNK);
  for (let i = 0; i < n; i++) {
    writeFileSync("output/meshv4__" + String(i).padStart(3, "0") + ".txt", meshStr.slice(i * CHUNK, (i + 1) * CHUNK));
  }
  writeInfo({ ok: true, chunks: n, length: meshStr.length, step: step, lines: mesh.length });
  log("DONE mesh: " + n + " chunks");
} catch (e) {
  log("FATAL: " + (e && e.stack || e));
  writeInfo({ error: String(e && e.message || e) });
  process.exit(0);
}
