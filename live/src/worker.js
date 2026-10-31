// tangobee — a one-of-one artwork for every visitor.
//
// Each profile view gets a new numbered edition: a plotter-style flow field whose shape is
// driven by what is happening right now — NOAA solar wind (turbulence), the Kp index
// (density), the real moon phase, the hour (accent colour) and today's commits.
//
//   GET /art.svg?theme=light|dark
import { DurableObject } from "cloudflare:workers";

const USER = "TangoBeee";
const W = 880, H = 400, M = 48; // canvas + margin
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const THEMES = {
  light: { ink: "#1F2328", muted: "#8C959F" },
  dark: { ink: "#E6EDF3", muted: "#6E7681" },
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
// live inputs (each upstream cached at the edge for a few minutes)
// ======================================================================================
async function getJSON(url, ttl) {
  const r = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true }, headers: { "user-agent": "tangobee-art" } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function solar() {
  const [wind, kp] = await Promise.allSettled([
    getJSON("https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json", 120),
    getJSON("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", 120),
  ]);
  const out = {};
  if (wind.status === "fulfilled") {
    const latest = wind.value.filter((d) => d.proton_speed != null).sort((a, b) => (a.time_tag < b.time_tag ? 1 : -1))[0];
    if (latest) out.wind = latest.proton_speed;
  }
  if (kp.status === "fulfilled" && kp.value.length) {
    const k = kp.value[kp.value.length - 1];
    out.kp = k.estimated_kp ?? k.kp_index;
  }
  return out;
}

async function commitsToday() {
  const r = await fetch(`https://github.com/users/${USER}/contributions`, {
    cf: { cacheTtl: 600, cacheEverything: true },
    headers: { "user-agent": "Mozilla/5.0 (tangobee-art)" },
  });
  if (!r.ok) throw new Error(`contributions ${r.status}`);
  const html = await r.text();
  const dateOf = {};
  for (const m of html.matchAll(/data-date="(\d{4}-\d\d-\d\d)"[^>]*?id="([^"]+)"/g)) dateOf[m[2]] = m[1];
  let last = null;
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>\s*(No|\d+) contributions? on/g)) {
    const date = dateOf[m[1]];
    if (date && (!last || date > last.date)) last = { date, n: m[2] === "No" ? 0 : +m[2] };
  }
  return last ? last.n : 0;
}

function moonPhase(t) {
  const synodic = 29.530588853, epoch = Date.UTC(2000, 0, 6, 18, 14);
  const age = ((((t - epoch) / 86400000) % synodic) + synodic) % synodic;
  return { phase: age / synodic, lit: (1 - Math.cos((2 * Math.PI * age) / synodic)) / 2 };
}

function accentFor(hour) {
  if (hour < 5) return "#5B8CFF";   // night
  if (hour < 9) return "#FF7A59";   // dawn
  if (hour < 16) return "#E8A400";  // day
  if (hour < 20) return "#FF4D8D";  // dusk
  return "#8B6CFF";                 // late
}

// ======================================================================================
// the drawing: evenly-spaced streamlines through a Perlin flow field
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

function draw({ seed, wind, kp, today, now, theme }) {
  const rand = rng(seed);
  const noise = perlin(rand);
  const turbulence = clamp(((wind ?? 400) - 300) / 450);
  const storm = clamp((kp ?? 2) / 9);
  const freq = 0.0016 + turbulence * 0.0032;
  const sep = 8.5 - storm * 4;           // calmer sky = airier drawing
  const step = 2.4, maxSteps = 260;
  const ox = rand() * 100, oy = rand() * 100;
  const angle = (x, y) =>
    noise(x * freq + ox, y * freq + oy) * Math.PI * 2.2 + noise(x * freq * 3.1 + oy, y * freq * 3.1 + ox) * Math.PI * (0.25 + storm * 0.6);

  // the moon sits somewhere in the upper half; lines flow around it
  const moon = { x: M + 80 + rand() * (W - 2 * M - 160), y: M + 40 + rand() * 70, r: 22 };
  const blocked = (x, y) => Math.hypot(x - moon.x, y - moon.y) < moon.r + sep * 1.2;

  const cell = sep, cols = Math.ceil(W / cell), grid = new Map();
  const key = (x, y) => Math.floor(x / cell) + Math.floor(y / cell) * cols;
  const near = (x, y, d) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), r = Math.ceil(d / cell);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const pts = grid.get(cx + i + (cy + j) * cols);
      if (pts) for (const [px, py] of pts) if (Math.hypot(px - x, py - y) < d) return true;
    }
    return false;
  };
  const inside = (x, y) => x > M && x < W - M && y > M && y < H - M - 22;

  const trace = (x, y, dir) => {
    const pts = [];
    for (let s = 0; s < maxSteps; s++) {
      const a = angle(x, y);
      x += Math.cos(a) * step * dir; y += Math.sin(a) * step * dir;
      if (!inside(x, y) || blocked(x, y) || near(x, y, sep * 0.55)) break;
      pts.push([x, y]);
    }
    return pts;
  };

  const lines = [];
  for (let tries = 0; tries < 2600; tries++) {
    const x = M + rand() * (W - 2 * M), y = M + rand() * (H - 2 * M - 22);
    if (!inside(x, y) || blocked(x, y) || near(x, y, sep)) continue;
    const pts = [...trace(x, y, -1).reverse(), [x, y], ...trace(x, y, 1)];
    if (pts.length < 14) continue;
    lines.push(pts);
    for (const p of pts) { const k = key(p[0], p[1]); (grid.get(k) || grid.set(k, []).get(k)).push(p); }
  }

  // accent: one line per commit today (at least one), chosen among the longest
  const accent = accentFor(now.getUTCHours());
  const byLength = lines.map((l, i) => [l.length, i]).sort((a, b) => b[0] - a[0]);
  const accented = new Set(byLength.slice(0, clamp(today, 1, 14)).map(([, i]) => i));

  // reveal left-to-right like a plotter pass
  const order = lines.map((l, i) => [Math.min(...l.map((p) => p[0])), i]).sort((a, b) => a[0] - b[0]);
  const { ink } = THEMES[theme];
  const paths = order.map(([minX, i]) => {
    const pts = lines[i].filter((_, k, arr) => k % 2 === 0 || k === arr.length - 1);
    const d = "M" + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L");
    const begin = ((minX - M) / (W - 2 * M)) * 3.2 + rand() * 0.4;
    const dur = 0.8 + pts.length / 90;
    const a = accented.has(i);
    return `<path d="${d}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" stroke="${a ? accent : ink}" stroke-width="${a ? 1.6 : 0.9}" stroke-opacity="${a ? 1 : 0.62}"><animate attributeName="stroke-dashoffset" from="1" to="0" begin="${begin.toFixed(2)}s" dur="${dur.toFixed(2)}s" fill="freeze" calcMode="spline" keySplines=".4 0 .2 1" keyTimes="0;1"/></path>`;
  });

  // real moon phase: lit part is a semicircle plus an elliptical terminator
  const { phase, lit } = moonPhase(now.getTime());
  const { x: mx, y: my, r } = moon;
  const waxing = phase < 0.5;
  const tx = Math.abs(1 - 2 * lit) * r;
  const outer = waxing ? 1 : 0, inner = lit > 0.5 ? (waxing ? 1 : 0) : (waxing ? 0 : 1);
  const litPath = `M${mx} ${my - r}A${r} ${r} 0 0 ${outer} ${mx} ${my + r}A${tx.toFixed(2)} ${r} 0 0 ${inner} ${mx} ${my - r}Z`;
  const moonSvg = `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="3.4s" dur="1.6s" fill="freeze"/>
    <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="${r}" fill="none" stroke="${ink}" stroke-opacity=".35" stroke-width=".9"/>
    <path d="${litPath}" fill="${ink}" fill-opacity=".85"/></g>`;

  return { paths: paths.join(""), moonSvg, accent, lit, count: lines.length };
}

function render(edition, inputs, theme) {
  const now = new Date();
  const art = draw({ seed: edition * 2654435761, ...inputs, now, theme });
  const { muted } = THEMES[theme];
  const parts = [
    inputs.wind != null && `solar wind ${fmt(inputs.wind)} km/s`,
    inputs.kp != null && `kp ${fmt(inputs.kp, 1)}`,
    `moon ${Math.round(art.lit * 100)}%`,
    `${inputs.today} commit${inputs.today === 1 ? "" : "s"} today`,
  ].filter(Boolean);
  const caption = `<g opacity="0" font-size="10" fill="${muted}"><animate attributeName="opacity" from="0" to="1" begin="4s" dur="1.5s" fill="freeze"/>
    <text x="${M}" y="${H - M + 18}">tangobee — № ${fmt(edition)} · drawn for you at ${now.toISOString().slice(11, 19)} UTC</text>
    <text x="${W - M}" y="${H - M + 18}" text-anchor="end">${parts.join(" · ")}</text>
    <circle cx="${W - M - parts.join(" · ").length * 6.02 - 10}" cy="${H - M + 14.5}" r="2.5" fill="${art.accent}"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" fill="none" stroke-linecap="round" stroke-linejoin="round">
<g>${art.paths}</g>${art.moonSvg}${caption}
</svg>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/art.svg") return Response.redirect(`https://github.com/${USER}`, 302);
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    const [edition, sun, today] = await Promise.all([
      env.EDITIONS.get(env.EDITIONS.idFromName("editions")).next(),
      solar().catch(() => ({})),
      commitsToday().catch(() => 0),
    ]);
    return new Response(render(edition, { ...sun, today }, theme), {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate, max-age=0",
        expires: "0",
      },
    });
  },
};
