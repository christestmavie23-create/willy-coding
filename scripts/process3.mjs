import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const CHUNK = 26000;
const W = 4000, H = 2000;
const qx = (lon) => Math.round((lon + 180) / 360 * W);
const qy = (lat) => Math.round((90 - lat) / 180 * H);

mkdirSync("output", { recursive: true });
mkdirSync("gadm", { recursive: true });
const log = (m) => console.log("[meshv8] " + m);
function writeInfo(extra) {
  try { writeFileSync("output/meshv8__info.json", JSON.stringify(extra)); log("info written"); }
  catch (e) { log("info fail: " + e.message); }
}

try {
  log("fetching GADM index ...");
  execSync("curl -sL -o idx.html https://geodata.ucdavis.edu/gadm/gadm4.1/json/", { timeout: 120000, encoding: "utf8" });
  const idx = readFileSync("idx.html", "utf8");
  const codes = [];
  const seen = new Set();
  for (const m of idx.matchAll(/gadm41_([A-Z]{3})_2\.json\.zip/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); codes.push(m[1]); }
  }
  log("countries with level-2: " + codes.length);

  const units = [];
  const admins = new Map();
  let done = 0;
  for (const code of codes) {
    const zip = "gadm/" + code + ".zip";
    const jsonPath = "gadm/gadm41_" + code + "_2.json";
    try {
      execSync("curl -sL -o " + zip + " https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_" + code + "_2.json.zip", { timeout: 180000, encoding: "utf8" });
      execSync("unzip -o -q " + zip + " -d gadm", { timeout: 60000, encoding: "utf8" });
      if (!existsSync(jsonPath)) { log("no json for " + code); continue; }
      const gj = JSON.parse(readFileSync(jsonPath, "utf8"));
      let country = null;
      for (const f of gj.features || []) {
        const props = f.properties || {};
        if (!country) country = props.COUNTRY || props.country || props.NAME_0 || code;
        const geom = f.geometry;
        if (!geom) continue;
        const rings = geom.type === "Polygon" ? [geom.coordinates[0]] : (geom.type === "MultiPolygon" ? geom.coordinates.map(p => p[0]) : []);
        for (const ring of rings) if (ring && ring.length > 3) units.push({ admin: country, ring: ring });
      }
      if (country) admins.set(country, true);
      done++;
      if (done % 40 === 0) log("processed " + done + "/" + codes.length + " units=" + units.length);
    } catch (e) { log("fail " + code + ": " + String(e.message).slice(0, 80)); }
  }
  log("units=" + units.length + " countries=" + admins.size);

  // aire bbox (coordonnees quantifiees)
  for (const u of units) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of u.ring) {
      const X = qx(p[0]), Y = qy(p[1]);
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    u.area = Math.max(0, (x1 - x0) * (y1 - y0));
  }

  const byAdmin = new Map();
  for (const u of units) {
    if (u.area < 12) continue;
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
    for (const p of u.ring) push(qx(p[0]), qy(p[1]));
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

  let mesh = [], step = 3, quota = 8, str = "";
  outer:
  for (const N of [16, 14, 12, 10, 8, 6]) {
    for (const t of [1.8, 2.2, 2.6, 3.0, 3.6, 4.2, 5.0]) {
      mesh = buildMesh(N, t);
      step = t; quota = N;
      str = JSON.stringify({ step: step, admins: adminNames, count: mesh.length, lines: mesh });
      log("quota=" + N + " step=" + t + " lines=" + mesh.length + " chars=" + str.length);
      if (str.length <= 115000) break outer;
    }
  }
  adminNames.length = 0; adminIndex.clear();
  mesh = buildMesh(quota, step);
  str = JSON.stringify({ step: step, admins: adminNames, count: mesh.length, lines: mesh });
  log("FINAL quota=" + quota + " step=" + step + " lines=" + mesh.length + " chars=" + str.length);

  const n = Math.ceil(str.length / CHUNK);
  for (let i = 0; i < n; i++) writeFileSync("output/meshv8__" + String(i).padStart(3, "0") + ".txt", str.slice(i * CHUNK, (i + 1) * CHUNK));
  const WATCH = ["France","Germany","United States","Ivory Coast","CÃ´te d'Ivoire","Cameroon","Nigeria","Ghana","India","Brazil","Kenya","Mexico","Spain","Poland","China","Australia","United Kingdom","Canada","Turkey"];
  const per = new Map();
  for (const L of mesh) per.set(adminNames[L.a], (per.get(adminNames[L.a]) || 0) + 1);
  const watch = {};
  for (const c of WATCH) watch[c] = per.get(c) || 0;
  writeFileSync("output/meshv8__diag.json", JSON.stringify({ codes: codes.length, units: units.length, admins: byAdmin.size, lines: mesh.length, chars: str.length, step: step, quota: quota, covered: per.size, watch: watch }));
  writeInfo({ ok: true, chunks: n, length: str.length, step: step, quota: quota, lines: mesh.length, covered: per.size });
  log("DONE meshv8: " + n + " chunks");
} catch (e) {
  log("FATAL: " + (e && e.stack || e));
  writeInfo({ error: String((e && e.message) || e).slice(0, 500) });
  process.exit(0);
}