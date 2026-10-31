// TANGOBEE // DEEP SPACE LINK
// One live SVG, rendered fresh on every profile view from:
//   - real planet positions (JPL Keplerian elements, computed for this exact moment)
//   - NOAA SWPC real-time space weather (solar wind, Kp index, GOES X-ray flux)
//   - TangoBee's public GitHub contribution graph

const USER = "TangoBeee";
const W = 880, H = 420;
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const CYAN = "#3EE6FF", PINK = "#FF3D8B", LIME = "#9BFF5C", AMBER = "#FFB020", RED = "#FF4D4D", DIM = "#5E6B8C", INK = "#E8EEFF";
const AU_KM = 149597870.7, C_KMS = 299792.458;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const hms = (d) => d.toISOString().slice(11, 19);

// ======================================================================================
// planets: JPL "Approximate Positions of the Planets", table 1 (valid 1800–2050)
//            a, e, I, L, long.peri, long.node  +  rates per century
// ======================================================================================
const PLANETS = {
  mercury: { el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593], rt: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081], color: "#A9A39A", r: 2.5 },
  venus: { el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255], rt: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418], color: "#E8C27A", r: 3.5 },
  earth: { el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0], rt: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0], color: "#4DA3FF", r: 4 },
  mars: { el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891], rt: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343], color: "#FF6B4A", r: 3 },
  jupiter: { el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], rt: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106], color: "#E3B27A", r: 8 },
  saturn: { el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], rt: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794], color: "#D9C38C", r: 6 },
};

function position(p, date) {
  const T = (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
  const [a, e, I, L, wbar, O] = p.el.map((v, i) => v + p.rt[i] * T);
  const rad = Math.PI / 180;
  const w = (wbar - O) * rad, Om = O * rad, inc = I * rad;
  let M = ((L - wbar) % 360) * rad;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(inc), sI = Math.sin(inc);
  return {
    x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    z: sw * sI * xp + cw * sI * yp,
    a,
  };
}

// ======================================================================================
// live data (each upstream cached at the edge for a few minutes)
// ======================================================================================
async function getJSON(url, ttl) {
  const r = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true }, headers: { "user-agent": "tangobee-deep-space-link" } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function spaceWeather() {
  const [wind, kp, xray] = await Promise.allSettled([
    getJSON("https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json", 120),
    getJSON("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", 120),
    getJSON("https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json", 120),
  ]);
  const out = {};
  if (wind.status === "fulfilled") {
    // ACE and DSCOVR both report; one row per minute, newest reading from either spacecraft
    const byMinute = {};
    for (const d of wind.value) if (d.proton_speed != null && (!byMinute[d.time_tag] || d.active)) byMinute[d.time_tag] = d;
    const rows = Object.values(byMinute);
    rows.sort((a, b) => (a.time_tag < b.time_tag ? 1 : -1));
    if (rows.length) {
      out.speed = rows[0].proton_speed;
      out.density = rows[0].proton_density;
      out.windAt = new Date(rows[0].time_tag + "Z");
      out.series = rows.slice(0, 120).reverse().map((d) => d.proton_speed);
    }
  }
  if (kp.status === "fulfilled" && kp.value.length) {
    const k = kp.value[kp.value.length - 1];
    out.kp = k.estimated_kp ?? k.kp_index;
  }
  if (xray.status === "fulfilled") {
    const long = xray.value.filter((d) => d.energy === "0.1-0.8nm" && d.flux > 0);
    if (long.length) out.flux = long[long.length - 1].flux;
  }
  return out;
}

async function contributions() {
  const r = await fetch(`https://github.com/users/${USER}/contributions`, {
    cf: { cacheTtl: 600, cacheEverything: true },
    headers: { "user-agent": "Mozilla/5.0 (tangobee-deep-space-link)" },
  });
  if (!r.ok) throw new Error(`contributions ${r.status}`);
  const html = await r.text();
  const dateOf = {};
  for (const m of html.matchAll(/data-date="(\d{4}-\d\d-\d\d)"[^>]*?id="([^"]+)"/g)) dateOf[m[2]] = m[1];
  const days = [];
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>\s*(No|\d+) contributions? on/g)) {
    if (dateOf[m[1]]) days.push({ date: dateOf[m[1]], n: m[2] === "No" ? 0 : +m[2] });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!days.length) throw new Error("no contribution data");
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].n) streak++;
    else if (i !== days.length - 1) break;
  }
  return { days, total: days.reduce((s, d) => s + d.n, 0), today: days[days.length - 1].n, streak };
}

// ======================================================================================
// render
// ======================================================================================
function stars() {
  let s = "", seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    const x = rnd() * W, y = rnd() * H, r = rnd() < 0.85 ? 0.6 : 1.1, o = 0.2 + rnd() * 0.6;
    s += rnd() < 0.25
      ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="#fff" opacity="${o.toFixed(2)}"><animate attributeName="opacity" values="${o.toFixed(2)};.05;${o.toFixed(2)}" dur="${(2 + rnd() * 4).toFixed(1)}s" repeatCount="indefinite"/></circle>`
      : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="#fff" opacity="${o.toFixed(2)}"/>`;
  }
  return s;
}

function distanceKm(t) {
  const e = position(PLANETS.earth, t), j = position(PLANETS.jupiter, t);
  return Math.hypot(j.x - e.x, j.y - e.y, j.z - e.z) * AU_KM;
}

// the image can't run code, so precompute the next TICKS seconds and flip one frame per second
const TICKS = 120;
function ticking(now, draw) {
  let out = "";
  for (let k = 0; k < TICKS; k++) {
    const t = new Date(now.getTime() + k * 1000);
    const timing = k === TICKS - 1 ? `begin="${k}s" fill="freeze"` : `begin="${k}s" dur="1s"`;
    out += `<g visibility="hidden"><set attributeName="visibility" to="visible" ${timing}/>${draw(t)}</g>`;
  }
  return out;
}

function orrery(now) {
  const cx = 214, cy = 240, k = 162 / Math.sqrt(9.6);
  const pos = Object.fromEntries(Object.entries(PLANETS).map(([n, p]) => [n, position(p, now)]));
  const place = (q) => {
    const r = Math.hypot(q.x, q.y), s = (k * Math.sqrt(r)) / r;
    return [cx + q.x * s, cy - q.y * s];
  };
  let g = "";
  for (const [n, p] of Object.entries(PLANETS)) {
    const R = k * Math.sqrt(pos[n].a);
    g += `<circle cx="${cx}" cy="${cy}" r="${R.toFixed(1)}" fill="none" stroke="${n === "jupiter" ? AMBER : "#22305A"}" stroke-opacity="${n === "jupiter" ? 0.45 : 0.8}" stroke-dasharray="${n === "jupiter" ? "none" : "2 4"}"/>`;
  }
  // radar sweep
  g += `<g><animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="8s" repeatCount="indefinite"/>
    <path d="M${cx} ${cy}L${cx + 170} ${cy}A170 170 0 0 0 ${cx + 170 * Math.cos(0.5)} ${cy - 170 * Math.sin(0.5)}Z" fill="url(#sweep)"/></g>`;
  g += `<circle cx="${cx}" cy="${cy}" r="26" fill="url(#sunglow)"><animate attributeName="r" values="24;30;24" dur="4s" repeatCount="indefinite"/></circle>
    <circle cx="${cx}" cy="${cy}" r="8" fill="#FFF3C4"/>`;

  const [ex, ey] = place(pos.earth), [jx, jy] = place(pos.jupiter);
  // transmissions travelling Jupiter -> Earth
  g += `<path id="beam" d="M${jx.toFixed(1)} ${jy.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="${CYAN}" stroke-opacity=".35" stroke-dasharray="3 5"/>`;
  for (let i = 0; i < 3; i++) {
    g += `<circle r="2.6" fill="${CYAN}" filter="url(#glow)"><animateMotion dur="3s" begin="${i}s" repeatCount="indefinite"><mpath href="#beam"/></animateMotion></circle>`;
  }
  for (const [n, p] of Object.entries(PLANETS)) {
    const [x, y] = place(pos[n]);
    if (n === "jupiter") {
      g += `<circle cx="${x}" cy="${y}" r="16" fill="none" stroke="${AMBER}" stroke-opacity=".6"><animate attributeName="r" values="10;22" dur="2s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values=".7;0" dur="2s" repeatCount="indefinite"/></circle>
        <circle cx="${x}" cy="${y}" r="${p.r}" fill="url(#jup)"/>`;
    } else {
      g += `<circle cx="${x}" cy="${y}" r="${p.r}" fill="${p.color}"${n === "earth" ? ' filter="url(#glow)"' : ""}/>`;
    }
    if (!["jupiter", "earth", "saturn"].includes(n)) continue;
    const label = n === "jupiter" ? "JUPITER · HQ" : n === "earth" ? "EARTH · YOU" : n.toUpperCase();
    const hot = n === "jupiter" || n === "earth";
    const right = x < cx + 60;
    if (n === "saturn") {
      g += `<text x="${x}" y="${y - p.r - 5}" font-size="8" fill="${DIM}" text-anchor="middle">SATURN</text>`;
      continue;
    }
    g += `<text x="${x + (right ? p.r + 5 : -p.r - 5)}" y="${y + 3}" font-size="${hot ? 10 : 8}" fill="${n === "jupiter" ? AMBER : n === "earth" ? CYAN : DIM}" text-anchor="${right ? "start" : "end"}"${hot ? ' font-weight="700"' : ""}>${label}</text>`;
  }
  return { svg: g, km: distanceKm(now), lightSec: distanceKm(now) / C_KMS };
}

function sparkline(series, x, y, w, h) {
  if (!series || series.length < 2) return "";
  const lo = Math.min(...series), hi = Math.max(...series), span = hi - lo || 1;
  const pts = series.map((v, i) => `${(x + (i / (series.length - 1)) * w).toFixed(1)},${(y + h - ((v - lo) / span) * h).toFixed(1)}`);
  const last = pts[pts.length - 1].split(",");
  return `<path d="M${x} ${y + h}L${pts.join("L")}L${x + w} ${y + h}Z" fill="url(#spark)"/>
    <path d="M${pts.join("L")}" fill="none" stroke="${AMBER}" stroke-width="1.4"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="${AMBER}"><animate attributeName="r" values="2;4;2" dur="1.5s" repeatCount="indefinite"/></circle>
    <text x="${x}" y="${y - 4}" font-size="8" fill="${DIM}">${fmt(hi)} km/s</text>
    <text x="${x + w}" y="${y - 4}" font-size="8" fill="${DIM}" text-anchor="end">solar wind · last ${series.length} min</text>`;
}

function xrayClass(f) {
  if (!f) return null;
  const [c, base] = f >= 1e-4 ? ["X", 1e-4] : f >= 1e-5 ? ["M", 1e-5] : f >= 1e-6 ? ["C", 1e-6] : f >= 1e-7 ? ["B", 1e-7] : ["A", 1e-8];
  return { label: `${c}${(f / base).toFixed(1)}`, color: c === "X" || c === "M" ? RED : c === "C" ? AMBER : LIME, note: c === "X" ? "major flare!" : c === "M" ? "flare in progress" : c === "C" ? "minor flare" : "sun is calm" };
}

function tile(x, y, label, value, unit, color, note) {
  return `<rect x="${x}" y="${y}" width="96" height="62" rx="8" fill="#0A1230" stroke="#1C2A55"/>
    <text x="${x + 10}" y="${y + 17}" font-size="8" fill="${DIM}" letter-spacing="1.5">${label}</text>
    <text x="${x + 10}" y="${y + 40}" font-size="20" font-weight="800" fill="${color}">${value}<tspan font-size="9" font-weight="400" fill="${DIM}"> ${unit}</tspan></text>
    <text x="${x + 10}" y="${y + 54}" font-size="8" fill="${DIM}">${note}</text>`;
}

function render(now, sw, gh) {
  const orb = orrery(now);
  const rate = (distanceKm(new Date(now.getTime() + 60000)) - orb.km) / 60;
  const P = 446; // right panel x

  const kp = sw.kp;
  const kpColor = kp == null ? DIM : kp >= 5 ? RED : kp >= 4 ? AMBER : LIME;
  const kpNote = kp == null ? "no signal" : kp >= 7 ? "severe storm" : kp >= 5 ? "geomagnetic storm" : kp >= 4 ? "unsettled" : "quiet";
  const xr = xrayClass(sw.flux);
  const tiles =
    tile(P, 196, "SOLAR WIND", sw.speed != null ? fmt(sw.speed) : "—", "km/s", sw.speed > 600 ? RED : sw.speed > 450 ? AMBER : LIME, sw.speed > 600 ? "fast stream" : sw.speed > 450 ? "elevated" : "nominal") +
    tile(P + 103.5, 196, "DENSITY", sw.density != null ? fmt(sw.density, 1) : "—", "p/cm³", INK, "protons") +
    tile(P + 207, 196, "KP INDEX", kp != null ? fmt(kp, kp % 1 ? 1 : 0) : "—", "/ 9", kpColor, kpNote) +
    tile(P + 310.5, 196, "X-RAY FLUX", xr ? xr.label : "—", "", xr ? xr.color : DIM, xr ? xr.note : "no signal");

  let tx = "";
  if (gh) {
    const recent = gh.days.slice(-26 * 7);
    const max = Math.max(1, ...recent.map((d) => d.n));
    const first = new Date(recent[0].date + "T00:00:00Z").getUTCDay();
    recent.forEach((d, i) => {
      const col = Math.floor((i + first) / 7), row = (i + first) % 7;
      const t = d.n ? 0.25 + 0.75 * Math.sqrt(d.n / max) : 0;
      tx += `<rect x="${P + col * 9}" y="${338 + row * 9}" width="7" height="7" rx="1.5" fill="${d.n ? CYAN : "#121C3D"}" opacity="${d.n ? t.toFixed(2) : 1}"/>`;
    });
    const sx = P + 27 * 9 + 6;
    tx += `<text x="${sx}" y="352" font-size="22" font-weight="800" fill="${CYAN}">${fmt(gh.total)}</text>
      <text x="${sx}" y="366" font-size="9" fill="${DIM}">contributions this year</text>
      <text x="${sx}" y="388" font-size="11" fill="${INK}">today <tspan fill="${LIME}" font-weight="700">${gh.today}</tspan>  ·  streak <tspan fill="${LIME}" font-weight="700">${gh.streak}d</tspan></text>
      <text x="${sx}" y="402" font-size="9" fill="${DIM}">${gh.today ? "transmitting right now" : "radio silence today"}</text>`;
  } else {
    tx = `<text x="${P}" y="360" font-size="11" fill="${DIM}">github uplink lost — retrying on next view</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#050816"/><stop offset="1" stop-color="#0D0A2A"/></linearGradient>
  <radialGradient id="sunglow"><stop offset="0" stop-color="#FFD66B"/><stop offset=".4" stop-color="#FF9A1F" stop-opacity=".5"/><stop offset="1" stop-color="#FF6A00" stop-opacity="0"/></radialGradient>
  <radialGradient id="jup" cx=".35" cy=".35"><stop offset="0" stop-color="#FBE3BC"/><stop offset=".6" stop-color="#D9A066"/><stop offset="1" stop-color="#8A5530"/></radialGradient>
  <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${CYAN}" stop-opacity="0"/><stop offset="1" stop-color="${CYAN}" stop-opacity=".09"/></linearGradient>
  <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${AMBER}" stop-opacity=".3"/><stop offset="1" stop-color="${AMBER}" stop-opacity="0"/></linearGradient>
  <filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <clipPath id="card"><rect width="${W}" height="${H}" rx="18"/></clipPath>
</defs>
<g clip-path="url(#card)">
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${stars()}
  <text x="28" y="40" font-size="17" font-weight="800" fill="${CYAN}" letter-spacing="3" filter="url(#glow)">TANGOBEE // DEEP SPACE LINK</text>
  <text x="28" y="58" font-size="10" fill="${DIM}">software engineer @ akto · transmitting from jupiter, near the sun</text>
  <circle cx="${W - 120}" cy="35" r="4" fill="${PINK}" filter="url(#glow)"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/></circle>
  <text x="${W - 28}" y="40" font-size="12" font-weight="800" fill="${PINK}" text-anchor="end" letter-spacing="3">LIVE</text>
  ${ticking(now, (t) => `<text x="${W - 28}" y="58" font-size="10" fill="${DIM}" text-anchor="end">live for you · ${hms(t)} UTC</text>`)}

  ${orb.svg}
  <text x="28" y="${H - 18}" font-size="8" fill="${DIM}">real planet positions for ${now.toISOString().slice(0, 10)} · √-scaled orbits</text>

  <text x="${P}" y="96" font-size="9" fill="${DIM}" letter-spacing="2">JUPITER ⇄ EARTH · RIGHT NOW</text>
  <text x="${W - 28}" y="96" font-size="9" fill="${rate < 0 ? LIME : PINK}" text-anchor="end">${rate < 0 ? "▼ closing in" : "▲ drifting apart"} at ${fmt(Math.abs(rate), 2)} km/s</text>
  ${ticking(now, (t) => {
    const km = distanceKm(t), sec = Math.round(km / C_KMS);
    return `<text x="${P}" y="132" font-size="32" font-weight="800" fill="${AMBER}" filter="url(#glow)">${fmt(km)}<tspan font-size="14" fill="${DIM}" font-weight="400"> km</tspan></text>
  <text x="${P}" y="154" font-size="11" fill="${INK}">signal delay <tspan fill="${CYAN}" font-weight="700">${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s</tspan>  ·  sent from jupiter at <tspan fill="${CYAN}">${hms(new Date(t.getTime() - sec * 1000))}</tspan> UTC</text>`;
  })}

  <text x="${P}" y="186" font-size="9" fill="${DIM}" letter-spacing="2">SPACE WEATHER · NOAA REAL-TIME</text>
  <text x="${W - 28}" y="186" font-size="8" fill="${DIM}" text-anchor="end">${sw.windAt ? "sampled " + hms(sw.windAt) + " UTC" : ""}</text>
  ${tiles}
  ${sparkline(sw.series, P, 280, W - 28 - P, 26)}

  <text x="${P}" y="328" font-size="9" fill="${DIM}" letter-spacing="2">TRANSMISSIONS FROM TANGOBEE · LAST 26 WEEKS</text>
  ${tx}
  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="18" fill="none" stroke="#fff" stroke-opacity=".08"/>
</g>
</svg>`;
}

export default {
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname !== "/link.svg") return Response.redirect(`https://github.com/${USER}`, 302);
    const [sw, gh] = await Promise.all([spaceWeather().catch(() => ({})), contributions().catch(() => null)]);
    return new Response(render(new Date(), sw, gh), {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate, max-age=0",
        expires: "0",
      },
    });
  },
};
