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
  try { writeFileSync("output/meshv6__info.json", JSON.stringify(Object.assign({}, report, extra))); log("info written"); }
  catch (e) { log("info fail: " + e.message); }
}

try {
  log("downloading 10m admin-1 ...");
  const res = await fetch("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson", { redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  writeFileSync("admin10.geojson", text);
  log("downloaded " + text.length + " chars");
  const parsed = JSON.parse(text);
  log("raw feats=" + parsed.features.length);

  execSync("npm install --no-save --no-audit --no-fund mapshaper@0.7.76 2>&1", { timeout: 240000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  log("npm install done");

  const out = execSync("node_modules/.bin/mapshaper admin10.geojson -simplify visvalingam 7% keep-shapes -clean -o admin10.topo.json format=topojson quantization=1e5 2>&1", { timeout: 900000, encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
  log("mapshaper said: " + String(out).slice(0, 300));
  const topoText = readFileSync("admin10.topo.json", "utf8");
  log("topo ok: " + topoText.length + " chars");

  const topo = JSON.parse(topoText);
  const key = Object.keys(topo.objects)[0];
  const feats = topo.objects[key].geometries;
  const tf = topo.transform;
  const arcsLL = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * tf.scale[0] + tf.translate[0], y * tf.scale[1] + tf.translate[1]]; });
  });
  log("feats=" + feats.length + " arcs=" + arcsLL.length);

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
  log("arcsWithUsers=" + users.size);

  const cand = [];
  const keptByAdmin = new Map();
  for (const entry of users) {
    const idx = entry[0], us = entry[1];
    const uniq = Array.from(new Set(us));
    if (uniq.length !== 2) continue;
    const a1 = adminOf[uniq[0]];
    const a2 = adminOf[uniq[1]];
    if (!a1 || a1 !== a2) continue;
    const minA = Math.min(area[uniq[0]], area[uniq[1]]);
    if (minA < 50) continue;
    cand.push({ idx: idx, admin: a1, minA: minA });
    keptByAdmin.set(a1, (keptByAdmin.get(a1) || 0) + 1);
  }
  log("candidates=" + cand.length + " countries=" + keptByAdmin.size);

  const adminIndex = new Map();
  const adminNames = [];
  for (const c of cand) {
    if (!adminIndex.has(c.admin)) { adminIndex.set(c.admin, adminNames.length); adminNames.push(c.admin); }
  }

  function deltaEncode(abs) {
    if (abs.length < 4) return abs;
    const out = [abs[0], abs[1]];
    for (let i = 2; i < abs.length; i += 2) out.push(abs[i] - abs[i - 2], abs[i + 1] - abs[i - 1]);
    return out;
  }
  function buildMesh(sub, minStep) {
    const out = [];
    for (const c of sub) {
      const abs = [];
      let lx = -99999, ly = -99999;
      for (const pair of arcsLL[c.idx]) {
        const x = qx(pair[0]), y = qy(pair[1]);
        const dx = x - lx, dy = y - ly;
        if (abs.length >= 2 && dx * dx + dy * dy < minStep * minStep) continue;
        abs.push(x, y); lx = x; ly = y;
      }
      if (abs.length >= 4) out.push({ a: adminIndex.get(c.admin), d: deltaEncode(abs) });
    }
    return out;
  }

  let mesh = [], step = 0.9, minArea = 50, str = "";
  const done = false;
  outer:
  for (const mA of [50, 80, 120, 180, 260, 400, 600, 900]) {
    const sub = cand.filter((c) => c.minA >= mA);
    for (const t of [0.9, 1.3, 1.7, 2.2, 2.8, 3.5, 4.5]) {
      mesh = buildMesh(sub, t);
      step = t; minArea = mA;
      str = JSON.stringify({ step: step, admins: adminNames, count: mesh.length, lines: mesh });
      log("minA=" + mA + " step=" + t + " lines=" + mesh.length + " chars=" + str.length);
      if (str.length <= 60000) break outer;
    }
  }

  const n = Math.ceil(str.length / CHUNK);
  for (let i = 0; i < n; i++) writeFileSync("output/meshv6__" + String(i).padStart(3, "0") + ".txt", str.slice(i * CHUNK, (i + 1) * CHUNK));
  const WATCH = ["France","Germany","Spain","Italy","Poland","India","United Kingdom","Ivory Coast","Côte d'Ivoire","Nigeria","Ghana","Senegal","Mali","Cameroon","Mexico","Indonesia","Japan","United States of America","Brazil","Australia","China","Ukraine","Russia","Canada","Turkey","Egypt","South Africa","Kenya","Morocco","Algeria","Madagascar","Peru","Colombia","Argentina","Chile"];
  const watch = {};
  for (const c of WATCH) watch[c] = keptByAdmin.get(c) || 0;
  const top = Array.from(keptByAdmin).map((e) => ({ a: e[0], n: e[1] })).sort((x, y) => y.n - x.n).slice(0, 25);
  writeFileSync("output/meshv6__diag.json", JSON.stringify({ feats: feats.length, arcs: arcsLL.length, candidates: cand.length, countries: keptByAdmin.size, step: step, minArea: minArea, lines: mesh.length, admins: adminNames.length, chars: str.length, watch: watch, top: top }));
  writeInfo({ ok: true, chunks: n, length: str.length, step: step, minArea: minArea, lines: mesh.length });
  log("DONE meshv6: " + n + " chunks lines=" + mesh.length);
} catch (e) {
  log("FATAL: " + (e && e.stack || e));
  writeInfo({ error: String((e && e.message) || e).slice(0, 500) });
  process.exit(0);
}
