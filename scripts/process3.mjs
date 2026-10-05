import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const CHUNK = 26000;
const W = 4000, H = 2000;
const qx = (lon) => Math.round((lon + 180) / 360 * W);
const qy = (lat) => Math.round((90 - lat) / 180 * H);

mkdirSync("output", { recursive: true });
const log = (m) => console.log("[meshv8] " + m);
function writeInfo(extra) {
  try { writeFileSync("output/meshv8__info.json", JSON.stringify(extra)); log("info written"); }
  catch (e) { log("info fail: " + e.message); }
}

try {
  log("downloading NE 10m admin-2 counties ...");
  const NEB = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/10m_cultural/ne_10m_admin_2_counties";
  for (const ext of ["shp", "dbf", "shx", "prj", "cpg"]) {
    execSync("curl -sL -o adm2." + ext + " " + NEB + "." + ext, { timeout: 300000, encoding: "utf8" });
  }
  log("shp size = " + readFileSync("adm2.shp").length);

  execSync("npm install --no-save --no-audit --no-fund mapshaper@0.7.76 2>&1", { timeout: 240000, encoding: "utf8" });
  log("npm install done");

  execSync("node_modules/.bin/mapshaper adm2.shp -simplify visvalingam 6% keep-shapes -clean -o adm2.topo.json format=topojson quantization=1e5 2>&1", { timeout: 1200000, encoding: "utf8", maxBuffer: 40 * 1024 * 1024 });
  const topoText = readFileSync("adm2.topo.json", "utf8");
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

  const sample = feats[0];
  const sprops = ((sample && sample.properties) || {});
  log("prop keys: " + Object.keys(sprops).slice(0, 20).join(","));
  const CAND = ["admin", "ADMIN", "sovereignt", "SOVEREIGNT", "country", "COUNTRY", "gn_name"];
  let ckey = null;
  for (const k of Object.keys(sprops)) if (!ckey && CAND.includes(k)) ckey = k;
  if (!ckey) ckey = Object.keys(sprops)[0];
  log("country key = " + ckey);

  function arcPts(ref) {
    const idx = ref < 0 ? ~ref : ref;
    const a = arcsLL[idx] || [];
    return ref < 0 ? a.slice().reverse() : a;
  }
  const units = [];
  feats.forEach((f) => {
    const geom = f.geometry || f;
    const props = f.properties || {};
    const admin = props[ckey] || "?";
    if (geom.type === "Polygon") {
      const ring = geom.arcs && geom.arcs[0];
      if (ring) units.push({ admin: admin, refs: ring });
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.arcs) {
        const ring = poly && poly[0];
        if (ring) units.push({ admin: admin, refs: ring });
      }
    }
  });
  log("units (outer rings)=" + units.length);

  for (const u of units) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const ref of u.refs) {
      for (const p of arcPts(ref)) {
        const X = qx(p[0]), Y = qy(p[1]);
        if (X < x0) x0 = X; if (X > x1) x1 = X;
        if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      }
    }
    u.area = Math.max(0, (x1 - x0) * (y1 - y0));
  }

  const byAdmin = new Map();
  for (const u of units) {
    if (u.area < 140) continue;
    if (!byAdmin.has(u.admin)) byAdmin.set(u.admin, []);
    byAdmin.get(u.admin).push(u);
  }
  for (const arr of byAdmin.values()) arr.sort((x, y) => y.area - x.area);
  log("admins=" + byAdmin.size);

  const adminIndex = new Map();
  const adminNames = [];
  const idxOf = (nm) => {
    if (!adminIndex.has(nm)) { adminIndex.set(nm, adminNames.length); adminNames.push(nm); }
    return adminIndex.get(nm);
  };

  function buildRing(u, minStep) {
    const abs = [];
    let lx = -99999, ly = -99999;
    const push = (X, Y) => {
      const dx = X - lx, dy = Y - ly;
      if (abs.length >= 2 && dx * dx + dy * dy < minStep * minStep) return;
      abs.push(X, Y); lx = X; ly = Y;
    };
    for (const ref of u.refs) for (const p of arcPts(ref)) push(qx(p[0]), qy(p[1]));
    if (abs.length >= 4) {
      const fx = abs[0], fy = abs[1];
      const lx2 = abs[abs.length - 2], ly2 = abs[abs.length - 1];
      if (Math.abs(fx - lx2) + Math.abs(fy - ly2) > 2) abs.push(fx, fy);
    }
    return abs;
  }
  function deltaEncode(abs) {
    const out = [abs[0], abs[1]];
    for (let i = 2; i < abs.length; i += 2) out.push(abs[i] - abs[i - 2], abs[i + 1] - abs[i - 1]);
    return out;
  }
  function buildMesh(quota, minStep) {
    const out = [];
    for (const arr of byAdmin.values()) {
      for (let i = 0; i < Math.min(quota, arr.length); i++) {
        const abs = buildRing(arr[i], minStep);
        if (abs.length >= 8) out.push({ a: idxOf(arr[i].admin), d: deltaEncode(abs) });
      }
    }
    return out;
  }

  let mesh = [], step = 2, quota = 10, str = "";
  outer:
  for (const N of [18, 14, 12, 10, 8, 6, 4]) {
    for (const t of [1.6, 2.0, 2.6, 3.2, 4.0, 5.0]) {
      mesh = buildMesh(N, t);
      step = t; quota = N;
      str = JSON.stringify({ step: step, admins: adminNames, count: mesh.length, lines: mesh });
      log("quota=" + N + " step=" + t + " lines=" + mesh.length + " chars=" + str.length);
      if (str.length <= 105000) break outer;
    }
  }
  adminNames.length = 0; adminIndex.clear();
  mesh = buildMesh(quota, step);
  str = JSON.stringify({ step: step, admins: adminNames, count: mesh.length, lines: mesh });
  log("FINAL quota=" + quota + " step=" + step + " lines=" + mesh.length + " chars=" + str.length);

  const n = Math.ceil(str.length / CHUNK);
  for (let i = 0; i < n; i++) writeFileSync("output/meshv8__" + String(i).padStart(3, "0") + ".txt", str.slice(i * CHUNK, (i + 1) * CHUNK));
  const WATCH = ["France","Germany","United States of America","Ivory Coast","Cameroon","Nigeria","Ghana","India","Brazil","Kenya","Mexico","Spain","Poland","China","Australia"];
  const per = new Map();
  for (const L of mesh) per.set(adminNames[L.a], (per.get(adminNames[L.a]) || 0) + 1);
  const watch = {};
  for (const c of WATCH) watch[c] = per.get(c) || 0;
  writeFileSync("output/meshv8__diag.json", JSON.stringify({ feats: feats.length, units: units.length, admins: byAdmin.size, lines: mesh.length, chars: str.length, step: step, quota: quota, covered: per.size, watch: watch }));
  writeInfo({ ok: true, chunks: n, length: str.length, step: step, quota: quota, lines: mesh.length, covered: per.size });
  log("DONE meshv8: " + n + " chunks");
} catch (e) {
  log("FATAL: " + (e && e.stack || e));
  writeInfo({ error: String((e && e.message) || e).slice(0, 500) });
  process.exit(0);
}