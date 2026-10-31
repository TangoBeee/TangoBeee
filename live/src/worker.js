// tangobee — the sun's magnetic field, drawn live for every visitor.
//
// Each view is a new numbered edition. The lines are streamlines of the real interplanetary
// magnetic field (NOAA real-time solar wind) over the last two hours:
//   x axis     time: left edge = 2h ago, right edge = now (one column per minute)
//   direction  the field's clock angle as seen from the sun (By sideways, Bz up/down)
//   density    field strength Bt: stronger field = tighter lines
//   accent     southward field (Bz < 0), when it can couple with Earth's and drive aurora
//
//   GET /art.svg?theme=light|dark
import { DurableObject } from "cloudflare:workers";

const USER = "TangoBeee";
const W = 880, H = 400, M = 48; // canvas + margin
const BOTTOM = H - M - 30;      // drawing area ends here; time axis + caption below
const MINUTES = 120;
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const AURORA = "#2BD98F";
const THEMES = {
  light: { ink: "#1F2328", muted: "#8C959F", accent: "#0FA968", glow: "#7DF5C0" },
  dark: { ink: "#E6EDF3", muted: "#6E7681", accent: AURORA, glow: "#E9FFF5" },
};
const fmt = (n, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// ======================================================================================
// edition counter: one Durable Object so every view gets a unique number
// ======================================================================================
export class Editions extends DurableObject {
  async next() {
    const n = ((await this.ctx.storage.get("n")) || 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}

// ======================================================================================
// live data: NOAA SWPC real-time solar wind (cached at the edge for a minute)
// ======================================================================================
async function getJSON(url) {
  const r = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true }, headers: { "user-agent": "tangobee-art" } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

// one reading per minute, preferring the spacecraft NOAA currently marks as active
function perMinute(rows, ok) {
  const byMinute = {};
  for (const d of rows) if (ok(d) && (!byMinute[d.time_tag] || d.active)) byMinute[d.time_tag] = d;
  return Object.values(byMinute).sort((a, b) => (a.time_tag < b.time_tag ? -1 : 1));
}

async function magneticField() {
  const rows = perMinute(await getJSON("https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json"),
    (d) => d.by_gsm != null && d.bz_gsm != null && d.bt != null);
  if (rows.length < 20) throw new Error("not enough field data");
  const last = new Date(rows[rows.length - 1].time_tag + "Z").getTime();
  // resample onto exactly MINUTES columns ending at the newest reading; fill gaps from neighbours
  const at = new Map(rows.map((d) => [new Date(d.time_tag + "Z").getTime(), d]));
  const series = [];
  let prev = rows.find((d) => new Date(d.time_tag + "Z").getTime() >= last - MINUTES * 60000) || rows[0];
  for (let i = MINUTES - 1; i >= 0; i--) {
    const d = at.get(last - i * 60000) || prev;
    series.push({ by: d.by_gsm, bz: d.bz_gsm, bt: d.bt });
    prev = d;
  }
  // a little smoothing so minute-to-minute jitter reads as flow, not noise
  const smooth = series.map((_, i) => {
    const win = series.slice(Math.max(0, i - 3), i + 4);
    const avg = (k) => win.reduce((s, d) => s + d[k], 0) / win.length;
    return { by: avg("by"), bz: avg("bz"), bt: avg("bt") };
  });
  return { series: smooth, now: series[series.length - 1], at: new Date(last) };
}

async function solarWindSpeed() {
  const rows = perMinute(await getJSON("https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json"), (d) => d.proton_speed != null);
  return rows.length ? rows[rows.length - 1].proton_speed : null;
}

// ======================================================================================
// the drawing: evenly-spaced streamlines through the measured field
// ======================================================================================
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function perlin(rand) {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const perm = [...p, ...p];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  return (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y), a = perm[X] + Y, b = perm[X + 1] + Y;
    const l1 = grad(perm[a], x, y) + u * (grad(perm[b], x - 1, y) - grad(perm[a], x, y));
    const l2 = grad(perm[a + 1], x, y - 1) + u * (grad(perm[b + 1], x - 1, y - 1) - grad(perm[a + 1], x, y - 1));
    return l1 + v * (l2 - l1);
  };
}

function moonPhase(t) {
  const synodic = 29.530588853, epoch = Date.UTC(2000, 0, 6, 18, 14);
  const age = ((((t - epoch) / 86400000) % synodic) + synodic) % synodic;
  return { phase: age / synodic, lit: (1 - Math.cos((2 * Math.PI * age) / synodic)) / 2 };
}

function draw({ seed, field, theme }) {
  const rand = rng(seed);
  const { ink, accent, glow } = THEMES[theme];
  const s = field.series, n = s.length;

  // field sample at any x: interpolate the vector (not the angle) to avoid wrap-around jumps
  const sample = (x) => {
    const f = clamp((x - M) / (W - 2 * M)) * (n - 1), i = Math.min(n - 2, Math.floor(f)), t = f - i;
    const lerp = (k) => s[i][k] + (s[i + 1][k] - s[i][k]) * t;
    return { by: lerp("by"), bz: lerp("bz"), bt: lerp("bt") };
  };
  // the real field sets the drift at each minute (north is up); organic swirls ride on top of it
  const noise = perlin(rand), ox = rand() * 100, oy = rand() * 100, f = 0.0035;
  const angle = (x, y) => {
    const { by, bz } = sample(x);
    const swirl = noise(x * f + ox, y * f + oy) + 0.35 * noise(x * f * 3.1 + oy, y * f * 3.1 + ox);
    return Math.atan2(-bz, by) + swirl * Math.PI * 1.6;
  };

  // the moon, in its real phase; lines flow around it
  const moon = { x: M + 80 + rand() * (W - 2 * M - 160), y: M + 36 + rand() * 60, r: 20 };
  const blocked = (x, y) => Math.hypot(x - moon.x, y - moon.y) < moon.r + 9;
  const sepAt = (x) => 9 - clamp((sample(x).bt - 3) / 15) * 4.5; // stronger field = tighter lines

  const cell = 4, cols = Math.ceil(W / cell), grid = new Map();
  const key = (x, y) => Math.floor(x / cell) + Math.floor(y / cell) * cols;
  const near = (x, y, d) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), r = Math.ceil(d / cell);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const pts = grid.get(cx + i + (cy + j) * cols);
      if (pts) for (const [px, py] of pts) if (Math.hypot(px - x, py - y) < d) return true;
    }
    return false;
  };
  const inside = (x, y) => x > M && x < W - M && y > M && y < BOTTOM;

  const step = 2.2;
  const trace = (x, y, dir) => {
    const pts = [];
    for (let k = 0; k < 400; k++) {
      const a = angle(x, y);
      x += Math.cos(a) * step * dir; y += Math.sin(a) * step * dir;
      if (!inside(x, y) || blocked(x, y) || near(x, y, sepAt(x) * 0.5)) break;
      pts.push([x, y]);
    }
    return pts;
  };

  const lines = [];
  for (let tries = 0; tries < 4000; tries++) {
    const x = M + rand() * (W - 2 * M), y = M + rand() * (BOTTOM - M);
    if (blocked(x, y) || near(x, y, sepAt(x))) continue;
    const pts = [...trace(x, y, -1).reverse(), [x, y], ...trace(x, y, 1)];
    if (pts.length < 10) continue;
    lines.push(pts);
    for (const p of pts) { const k = key(p[0], p[1]); (grid.get(k) || grid.set(k, []).get(k)).push(p); }
  }

  // split lines into runs of northward / southward field. About a third of the lines turn
  // green through southward stretches, so the accent stays a highlight but still marks them.
  const runs = [];
  for (const pts of lines) {
    const carries = rand() < 0.3;
    let cur = [pts[0]], south = sample(pts[0][0]).bz < 0;
    for (let k = 1; k < pts.length; k++) {
      const sk = sample(pts[k][0]).bz < 0;
      cur.push(pts[k]);
      if (sk !== south) { runs.push({ pts: cur, south: south && carries }); cur = [pts[k]]; south = sk; }
    }
    if (cur.length > 1) runs.push({ pts: cur, south: south && carries });
  }

  // reveal left-to-right: the past is drawn first, "now" arrives last
  const paths = runs.map(({ pts, south }) => {
    const thin = pts.filter((_, k, arr) => k % 2 === 0 || k === arr.length - 1);
    if (thin.length < 2) return "";
    const minX = Math.min(...thin.map((p) => p[0]));
    const d = "M" + thin.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L");
    const begin = ((minX - M) / (W - 2 * M)) * 3.4 + rand() * 0.3;
    const dur = 0.5 + thin.length / 80;
    const line = `<path d="${d}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" stroke="${south ? accent : ink}" stroke-width="${south ? 1.3 : 0.9}" stroke-opacity="${south ? 0.95 : 0.6}"><animate attributeName="stroke-dashoffset" from="1" to="0" begin="${begin.toFixed(2)}s" dur="${dur.toFixed(2)}s" fill="freeze" calcMode="spline" keySplines=".4 0 .2 1" keyTimes="0;1"/></path>`;
    if (!south) return line;
    // once drawn, a glint of light keeps travelling along each southward line, forever
    const glint = `<path d="${d}" pathLength="1" stroke-dasharray=".07 .93" stroke-dashoffset="1" stroke="${glow}" stroke-width="1.8" opacity="0"><set attributeName="opacity" to="1" begin="${(begin + dur).toFixed(2)}s"/><animate attributeName="stroke-dashoffset" from="1" to="0" begin="${(begin + dur).toFixed(2)}s" dur="${(2.5 + rand() * 3).toFixed(2)}s" repeatCount="indefinite"/></path>`;
    return line + glint;
  });
  const { phase, lit } = moonPhase(Date.now());
  const { x: mx, y: my, r } = moon, waxing = phase < 0.5, tx = Math.abs(1 - 2 * lit) * r;
  const outer = waxing ? 1 : 0, inner = lit > 0.5 ? (waxing ? 1 : 0) : (waxing ? 0 : 1);
  const moonSvg = `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="3.4s" dur="1.6s" fill="freeze"/>
    <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="${r}" stroke="${ink}" stroke-opacity=".35" stroke-width=".9"/>
    <path d="M${mx} ${my - r}A${r} ${r} 0 0 ${outer} ${mx} ${my + r}A${tx.toFixed(2)} ${r} 0 0 ${inner} ${mx} ${my - r}Z" fill="${ink}" fill-opacity=".85"/></g>`;
  return paths.join("") + moonSvg;
}

function render(edition, field, wind, theme) {
  const { ink, muted, accent } = THEMES[theme];
  const fade = (begin) => `<animate attributeName="opacity" from="0" to="1" begin="${begin}s" dur="1.5s" fill="freeze"/>`;
  const now = field.now;
  const dirWord = now.bz < 0 ? "south" : "north";
  const right = [
    `now ${fmt(now.bt, 1)} nT, pointing ${dirWord}`,
    wind != null && `${fmt(wind)} km/s`,
  ].filter(Boolean).join(" · ");
  const axisY = BOTTOM + 12;
  const tick = (x, label, anchor) =>
    `<path d="M${x} ${axisY - 3}v6" stroke="${ink}" stroke-opacity=".3"/><text x="${x}" y="${axisY + 14}" text-anchor="${anchor}">${label}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" fill="none" stroke-linecap="round" stroke-linejoin="round">
<g>${draw({ seed: edition * 2654435761, field, theme })}</g>
<g opacity="0" font-size="9" fill="${muted}">${fade(0.2)}
  <path d="M${M} ${axisY}H${W - M}" stroke="${ink}" stroke-opacity=".18"/>
  ${tick(M, "−2h", "start")}${tick(W / 2, "−1h", "middle")}${tick(W - M, `now · ${field.at.toISOString().slice(11, 16)} UTC`, "end")}
</g>
<g opacity="0" font-size="10" fill="${muted}">${fade(3.8)}
  <text x="${M}" y="${H - 14}">tangobee #${fmt(edition)} · the sun's magnetic field passing earth</text>
  <text x="${W - M}" y="${H - 14}" text-anchor="end"><tspan fill="${accent}">━</tspan> southward (aurora-friendly) · ${right}</text>
</g>
</svg>`;
}

function offline(theme) {
  const { muted } = THEMES[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="11" fill="${muted}">the spacecraft are quiet right now — the field will be drawn on your next visit</text></svg>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/art.svg") return Response.redirect(`https://github.com/${USER}`, 302);
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    const [field, wind] = await Promise.all([magneticField().catch(() => null), solarWindSpeed().catch(() => null)]);
    const body = field ? render(await env.EDITIONS.get(env.EDITIONS.idFromName("editions")).next(), field, wind, theme) : offline(theme);
    return new Response(body, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate, max-age=0",
        expires: "0",
      },
    });
  },
};
