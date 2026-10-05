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
  try { writeFileSync("output/meshv5__info.json", JSON.stringify(Object.assign({}, report, extra))); log("info written"); }
  catch (e) { log("info fail: " + e.message); }
}

async function fetchFirst(urls) {
  let lastErr = null;
  for (const url of urls) {
    for (let a = 1; a <= 3; a++) {
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

try {
  const text = await fetchFirst([
    "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_1_states_provinces.geojson",
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson",
  ]);
  writeFileSync("admin150.geojson", text);
  log("downloaded " + text.length + " chars");

  execSync("npm install --no-save --no-audit --no-fund mapshaper@0.7.76 2>&1", { timeout: 240000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  log("npm install done");

  const VARIANTS = [
    ["A", "-simplify visvalingam 10% keep-shapes -clean"],
    ["B", "-clean -simplify visvalingam 10% keep-shapes"],
    ["C", "-clean"],
  ];

  function analyze(topoText) {
    const topo = JSON.parse(topoText);
    const key = Object.keys(topo.objects)[0];
    const feats = topo.objects[key].geometries;
    const tf = topo.transform;
    const arcsLL = topo.arcs.map((arc) => {
      let x = 0, y = 0;
      return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * tf.scale[0] + tf.translate[0], y * tf.scale[1] + tf.translate[1]]; });
    });
    const users = new Map();
    const area = [];
    const adminOf = [];
    feats.forEach((f, fi) => {
      const geom = f.geometry || f;
      const props = (f && f.properties) || (geom && geom.properties) || {};
      adminOf.push(props.admin || "?");
      let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      const walk = (rings) => {
        for (const refs of rings) {
          if (!refs) continue;
          for (const ref of refs) {
            if (ref === null || ref === undefined) continue;
            const idx = ref < 0 ? ~ref : ref;
            if (!users.has(idx)) users.set(idx, []);
            users.get(idx).push(fi);
            const a = arcsLL[idx];
            if (a) for (const pair of a) {
              const x = qx(pair[0]), y = qy(pair[1]);
              if (x < bx0) bx0 = x;
              if (x > bx1) bx1 = x;
              if (y < by0) by0 = y;
              if (y > by1) by1 = y;
            }
          }
        }
      };
      if (geom.type === "Polygon") walk(geom.arcs);
      else if (geom.type === "MultiPolygon") { for (const poly of geom.arcs) walk(poly); }
      area.push(Math.max(0, (bx1 - bx0) * (by1 - by0)));
    });
    return { feats: feats, arcsLL: arcsLL, users: users, area: area, adminOf: adminOf };
  }

  const WATCH = ["France","Germany","Spain","Italy","Poland","India","United Kingdom","Ivory Coast","Côte d'Ivoire","Nigeria","Ghana","Senegal","Mali","Cameroon","Mexico","Indonesia","Japan","United States of America","Brazil","Australia","China","Ukraine","Russia","Canada","Turkey","Egypt","South Africa","Kenya","Morocco","Algeria","Madagascar","Peru","Colombia","Argentina","Chile"];

  const MIN_AREA = 50;
  const variants = [];
  let best = null;
  for (const v of VARIANTS) {
    const name = v[0], args = v[1];
    let topoText = null;
    try {
      execSync("node_modules/.bin/mapshaper admin150.geojson " + args + " -o " + name + ".topo.json format=topojson quantization=1e5 2>&1", { timeout: 300000, encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
      topoText = readFileSync(name + ".topo.json", "utf8");
    } catch (e) {
      const msg = String((e && e.stdout ? e.stdout : "") + " " + ((e && e.message) || e)).slice(0, 250);
      log("variant " + name + " failed: " + msg);
      variants.push({ name: name, error: msg });
      continue;
    }
    const an = analyze(topoText);
    const cand = [];
    const keptByAdmin = new Map();
    for (const entry of an.users) {
      const idx = entry[0], us = entry[1];
      const uniq = Array.from(new Set(us));
      if (uniq.length !== 2) continue;
      const a1 = an.adminOf[uniq[0]];
      const a2 = an.adminOf[uniq[1]];
      if (!a1 || a1 !== a2) continue;
      if (an.area[uniq[0]] < MIN_AREA || an.area[uniq[1]] < MIN_AREA) continue;
      keptByAdmin.set(a1, (keptByAdmin.get(a1) || 0) + 1);
      cand.push({ idx: idx, admin: a1 });
    }
    const info = { name: name, feats: an.feats.length, arcs: an.arcsLL.length, countries: keptByAdmin.size, kept: cand.length, watch: {} };
    for (const c of WATCH) info.watch[c] = keptByAdmin.get(c) || 0;
    variants.push(info);
    log("variant " + name + ": kept=" + cand.length + " countries=" + keptByAdmin.size);
    if (!best || cand.length > best.cand.length) best = { name: name, an: an, cand: cand };
  }

  if (!best) { writeInfo({ error: "all variants failed", variants: variants }); process.exit(0); }
  log("chosen variant: " + best.name);

  const adminIndex = new Map();
  const adminNames = [];
  for (const c of best.cand) {
    if (!adminIndex.has(c.admin)) { adminIndex.set(c.admin, adminNames.length); adminNames.push(c.admin); }
  }

  function deltaEncode(abs) {
    if (abs.length < 4) return abs;
    const out = [abs[0], abs[1]];
    for (let i = 2; i < abs.length; i += 2) out.push(abs[i] - abs[i - 2], abs[i + 1] - abs[i - 1]);
    return out;
  }

  function buildMesh(minStep) {
    const out = [];
    for (const c of best.cand) {
      const abs = [];
      let lx = -99999, ly = -99999;
      for (const pair of best.an.arcsLL[c.idx]) {
        const x = qx(pair[0]), y = qy(pair[1]);
        const dx = x - lx, dy = y - ly;
        if (abs.length >= 2 && dx * dx + dy * dy < minStep * minStep) continue;
        abs.push(x, y); lx = x; ly = y;
      }
      if (abs.length >= 4) out.push({ a: adminIndex.get(c.admin), d: deltaEncode(abs) });
    }
    return out;
  }

  let mesh = [], step = 1.0, str = "";
  for (const t of [0.9, 1.3, 1.7, 2.2, 2.8, 3.5, 4.5]) {
    mesh = buildMesh(t);
    step = t;
    str = JSON.stringify({ step: step, admins: adminNames, count: mesh.length, lines: mesh });
    log("step=" + t + " lines=" + mesh.length + " chars=" + str.length);
    if (str.length <= 60000) break;
  }

  const n = Math.ceil(str.length / CHUNK);
  for (let i = 0; i < n; i++) writeFileSync("output/meshv5__" + String(i).padStart(3, "0") + ".txt", str.slice(i * CHUNK, (i + 1) * CHUNK));
  writeFileSync("output/meshv5__diag.json", JSON.stringify({ variants: variants, chosen: best.name, step: step, lines: mesh.length, admins: adminNames.length, chars: str.length }));
  writeInfo({ ok: true, chunks: n, length: str.length, step: step, lines: mesh.length, chosen: best.name });
  log("DONE meshv5: " + n + " chunks lines=" + mesh.length);
} catch (e) {
  log("FATAL: " + (e && e.stack || e));
  writeInfo({ error: String((e && e.message) || e) });
  process.exit(0);
}
