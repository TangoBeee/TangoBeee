// TANGOBEE ARCADE: one shared snake, played by everyone who visits the profile.
//
//   GET /screen.svg        the live frame (never cached, so GitHub shows the newest one)
//   GET /up|down|left|right one move, then a redirect straight back to the profile
//   GET /pad/<dir>.svg      the arrow buttons
//
// All state lives in a single Durable Object, so every click is applied in order.
import { DurableObject } from "cloudflare:workers";

const PROFILE = "https://github.com/TangoBeee#arcade";
const COLS = 30, ROWS = 20;
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };
const ARROW = { up: "▲", down: "▼", left: "◀", right: "▶" };
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|go-http|headless/i;
const MIN_GAP_MS = 250; // per-IP throttle

const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const CYAN = "#3EE6FF", PINK = "#FF3D8B", LIME = "#B6FF5C", AMBER = "#FFB020", DIM = "#5E6B8C", INK = "#E8EEFF";

// 64x26 land mask (lon -180..180, lat 80..-60), rasterised from Natural Earth 110m
const WORLD = ["................##..#########.....#...............#.............","..........###.#.###...######.............#..#.#########..##.....","..################################.....#........................","...############...#....#.........##.###########################.","...#.....########.###..........#.##.####################....#...",".........############...........##########################......","..........###########...........#####..#.###############........","..........#########...........##.#...################.#.........","...........#######.............###....###############..#........","............###..#............########################..........","............###..............#########.###..##########..........","..............##.............#############...##..##..#..........","................#............###########.....#....#..#..........","..................####........###########.....#.................","..................#####...........######..........###...........","..................#######.........#####...........#.###.#.......","..................########........#####..............#..........","..................#######.........#####...............##.#......","....................#####.........####..#.............####......","...................#####...........###..............#######.....","...................####............##...............#######.....","...................###...................................##.....","...................#............................................","...................#............................................","...................#.#..........................................","................................................................"];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => n.toLocaleString("en-US");
const where = (e) => (e.city ? `${e.city}, ${e.cc}` : e.cc || "somewhere");

function ago(t, now) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function newGame() {
  const g = { snake: [[8, 10], [7, 10], [6, 10]], dir: "right", score: 0, alive: true, death: null };
  g.food = spawn(g.snake);
  return g;
}

function spawn(snake) {
  const taken = new Set(snake.map(([x, y]) => `${x},${y}`));
  for (;;) {
    const p = [Math.floor(Math.random() * COLS), Math.floor(Math.random() * ROWS)];
    if (!taken.has(`${p[0]},${p[1]}`)) return p;
  }
}

export class Arcade extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.lastByIp = new Map();
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS players (h TEXT PRIMARY KEY)");
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get("s")) || {
        game: newGame(), best: { score: 0 }, moves: 0, deaths: 0, recent: [], countries: {},
      };
    });
  }

  async move(dir, who) {
    const now = Date.now();
    if (now - (this.lastByIp.get(who.ip) || 0) < MIN_GAP_MS) return;
    this.lastByIp.set(who.ip, now);
    if (this.lastByIp.size > 5000) this.lastByIp.clear();

    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tb-arcade:" + who.ip)))]
      .slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO players (h) VALUES (?)", hash);

    const s = this.s;
    if (!s.game.alive) s.game = newGame();
    const g = s.game;
    if (OPPOSITE[dir] === g.dir) dir = g.dir; // can't reverse into your own neck; keep going
    const [dx, dy] = DIRS[dir];
    const head = [g.snake[0][0] + dx, g.snake[0][1] + dy];
    const eats = head[0] === g.food[0] && head[1] === g.food[1];
    const body = eats ? g.snake : g.snake.slice(0, -1);
    const place = { city: who.city, cc: who.cc };
    let ev = dir;

    if (head[0] < 0 || head[1] < 0 || head[0] >= COLS || head[1] >= ROWS || body.some(([x, y]) => x === head[0] && y === head[1])) {
      g.alive = false;
      g.death = { t: now, len: g.snake.length, ...place };
      s.deaths++;
      ev = "crash";
    } else {
      g.snake.unshift(head);
      if (eats) {
        g.score++;
        g.food = spawn(g.snake);
        ev = "eat";
      } else g.snake.pop();
      g.dir = dir;
      if (g.score > s.best.score) s.best = { score: g.score, ...place };
    }
    s.moves++;
    if (who.cc) s.countries[who.cc] = 1;
    const r = (v) => (Number.isFinite(v) ? Math.round(v * 2) / 2 : null); // ~50km, never exact
    s.recent.unshift({ t: now, dir, ev, ...place, lat: r(who.lat), lon: r(who.lon) });
    s.recent.length = Math.min(s.recent.length, 60);
    await this.ctx.storage.put("s", s);
  }

  screen() {
    const players = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM players").one().n;
    return render(this.s, players, Date.now());
  }
}

// ======================================================================================
// the frame
// ======================================================================================
function render(s, players, now) {
  const W = 960, H = 540, C = 17, bx = 48, by = 96, bw = COLS * C, bh = ROWS * C;
  const g = s.game;

  // snake: head bright lime, fading to teal at the tail; red when dead
  const n = g.snake.length;
  const seg = g.snake.map(([x, y], i) => {
    const t = n > 1 ? i / (n - 1) : 0;
    const fill = g.alive ? mix("#B6FF5C", "#1FD1A5", t) : mix("#FF5C7A", "#7A1F3D", t);
    const pad = i === 0 ? 0.5 : 1.5 + t * 1.5;
    return `<rect x="${bx + x * C + pad}" y="${by + y * C + pad}" width="${C - pad * 2}" height="${C - pad * 2}" rx="${i === 0 ? 5 : 4}" fill="${fill}"/>`;
  }).reverse().join("");
  const [hx, hy] = g.snake[0], [dx, dy] = DIRS[g.dir];
  const ex = bx + hx * C + C / 2 + dx * 3, ey = by + hy * C + C / 2 + dy * 3;
  const eyes = g.alive
    ? `<circle cx="${ex - dy * 3.5}" cy="${ey - dx * 3.5}" r="1.8" fill="#04110a"/><circle cx="${ex + dy * 3.5}" cy="${ey + dx * 3.5}" r="1.8" fill="#04110a"/>`
    : `<text x="${bx + hx * C + C / 2}" y="${by + hy * C + C / 2 + 4}" font-size="11" text-anchor="middle" fill="#04110a" font-weight="700">x</text>`;
  const fx = bx + g.food[0] * C + C / 2, fy = by + g.food[1] * C + C / 2;
  const food = `<circle cx="${fx}" cy="${fy}" r="5.5" fill="${PINK}" filter="url(#glow)"><animate attributeName="r" values="4.5;6.5;4.5" dur="1s" repeatCount="indefinite"/></circle>`;

  let overlay = "";
  if (!g.alive) {
    const d = g.death;
    overlay = `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#050816" opacity=".72"/>
      <text x="${bx + bw / 2}" y="${by + bh / 2 - 22}" text-anchor="middle" font-size="38" font-weight="800" fill="${PINK}" letter-spacing="6" filter="url(#glow)">CRASHED</text>
      <text x="${bx + bw / 2}" y="${by + bh / 2 + 10}" text-anchor="middle" font-size="13" fill="${INK}">by someone in ${esc(where(d))} · length ${d.len} · ${ago(d.t, now)}</text>
      <text x="${bx + bw / 2}" y="${by + bh / 2 + 40}" text-anchor="middle" font-size="12" fill="${AMBER}">PRESS ANY ARROW TO START A NEW GAME<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.5;.5;1" dur="1s" repeatCount="indefinite"/></text>`;
  } else if (!s.recent.length) {
    overlay = `<text x="${bx + bw / 2}" y="${by + bh - 24}" text-anchor="middle" font-size="12" fill="${AMBER}">PRESS ANY ARROW TO PLAY<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.5;.5;1" dur="1s" repeatCount="indefinite"/></text>`;
  }

  // world map with a ping for everyone who played recently
  const mx = 590, my = 124, sp = 5;
  let land = "";
  WORLD.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] === "#") land += `M${mx + c * sp + 2.5} ${my + r * sp + 2.5}h.01`;
  });
  const proj = (lat, lon) => [mx + ((lon + 180) / 360) * 320, my + ((80 - lat) / 140) * 130];
  const seen = new Set();
  const pings = s.recent.filter((e) => e.lat !== null && e.lon !== null && !seen.has(`${e.lat},${e.lon}`) && seen.add(`${e.lat},${e.lon}`))
    .slice(0, 40).reverse().map((e, i, arr) => {
      const [x, y] = proj(e.lat, e.lon);
      const latest = i === arr.length - 1;
      const o = Math.max(0.35, 1 - (now - e.t) / 86400000);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${latest ? 3.2 : 2.4}" fill="${latest ? PINK : AMBER}" opacity="${o.toFixed(2)}" filter="url(#glow)"/>` +
        (latest ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="none" stroke="${PINK}" stroke-width="1.5"><animate attributeName="r" values="3;16" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="1.6s" repeatCount="indefinite"/></circle>` : "");
    }).join("");

  const log = s.recent.slice(0, 6).map((e, i) => {
    const y = 302 + i * 22;
    const [glyph, color] = e.ev === "crash" ? ["☠", PINK] : e.ev === "eat" ? ["●", LIME] : [ARROW[e.dir], CYAN];
    const place = where(e);
    return `<g opacity="${(1 - i * 0.12).toFixed(2)}"><text x="${mx}" y="${y}" font-size="12" fill="${color}">${glyph}</text>
      <text x="${mx + 20}" y="${y}" font-size="12" fill="${INK}">${esc(place.length > 26 ? place.slice(0, 25) + "…" : place)}</text>
      <text x="${mx + 320}" y="${y}" font-size="11" fill="${DIM}" text-anchor="end">${ago(e.t, now)}</text></g>`;
  }).join("") || `<text x="${mx}" y="302" font-size="12" fill="${DIM}">nobody yet. be the first.</text>`;

  const stat = (x, label, value, color, sub = "") =>
    `<text x="${x}" y="466" font-size="10" fill="${DIM}" letter-spacing="2">${label}</text>
     <text x="${x}" y="493" font-size="24" font-weight="800" fill="${color}">${value}</text>` +
    (sub ? `<text x="${x}" y="508" font-size="9" fill="${DIM}">${esc(sub)}</text>` : "");
  const clock = new Date(now).toISOString().slice(11, 19);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<defs>
  <linearGradient id="case" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A2D38"/><stop offset="1" stop-color="#111218"/></linearGradient>
  <radialGradient id="vignette" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".65"/></radialGradient>
  <linearGradient id="sweep" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".045"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity=".28"/></pattern>
  <pattern id="grid" x="${bx}" y="${by}" width="${C}" height="${C}" patternUnits="userSpaceOnUse"><circle cx="${C / 2}" cy="${C / 2}" r=".8" fill="#1A2547"/></pattern>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <clipPath id="screen"><rect x="22" y="22" width="${W - 44}" height="${H - 44}" rx="22"/></clipPath>
</defs>
<rect width="${W}" height="${H}" rx="30" fill="url(#case)"/>
<rect x="21" y="21" width="${W - 42}" height="${H - 42}" rx="23" fill="none" stroke="#000" stroke-opacity=".6" stroke-width="2"/>
<g clip-path="url(#screen)">
  <rect width="${W}" height="${H}" fill="#050816"/>
  <g><animate attributeName="opacity" values="1;.94;1;1;.97;1" dur="4s" repeatCount="indefinite"/>
  <text x="${bx}" y="60" font-size="21" font-weight="800" fill="${CYAN}" letter-spacing="5" filter="url(#glow)">TANGOBEE ARCADE</text>
  <text x="${bx}" y="80" font-size="11" fill="${DIM}">one snake · the whole internet · every click below is a real move</text>
  <circle cx="${W - 132}" cy="55" r="4.5" fill="${PINK}" filter="url(#glow)"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/></circle>
  <text x="${W - 48}" y="60" font-size="13" font-weight="800" fill="${PINK}" text-anchor="end" letter-spacing="3">LIVE</text>
  <text x="${W - 48}" y="80" font-size="10" fill="${DIM}" text-anchor="end">frame rendered ${clock} UTC</text>

  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6" fill="#070C1F"/>
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="url(#grid)"/>
  <rect x="${bx - 1}" y="${by - 1}" width="${bw + 2}" height="${bh + 2}" rx="7" fill="none" stroke="${CYAN}" stroke-opacity=".35" filter="url(#glow)"/>
  ${food}
  <g filter="url(#glow)">${seg}</g>${eyes}
  ${overlay}

  <text x="${mx}" y="112" font-size="10" fill="${DIM}" letter-spacing="2">WHERE PLAYERS ARE</text>
  <text x="${mx + 320}" y="112" font-size="10" fill="${DIM}" text-anchor="end">${Object.keys(s.countries).length} countr${Object.keys(s.countries).length === 1 ? "y" : "ies"}</text>
  <path d="${land}" stroke="#22325C" stroke-width="2.6" stroke-linecap="round"/>
  ${pings}
  <text x="${mx}" y="280" font-size="10" fill="${DIM}" letter-spacing="2">LAST MOVES</text>
  ${log}

  <path d="M${bx} 448H${W - 48}" stroke="#1A2547"/>
  ${stat(bx, "SCORE", g.score, LIME)}
  ${stat(bx + 130, "LENGTH", n, INK)}
  ${stat(bx + 260, "BEST", s.best.score, AMBER, s.best.score ? "by " + where(s.best) : "")}
  ${stat(bx + 470, "MOVES", fmt(s.moves), INK)}
  ${stat(bx + 610, "PLAYERS", fmt(players), CYAN)}
  ${stat(bx + 760, "CRASHES", fmt(s.deaths), PINK)}
  </g>
  <rect width="${W}" height="${H}" fill="url(#scan)"/>
  <rect y="-120" width="${W}" height="120" fill="url(#sweep)"><animate attributeName="y" values="-120;${H}" dur="7s" repeatCount="indefinite"/></rect>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
</g>
</svg>`;
}

function mix(a, b, t) {
  const p = (h, i) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

// ======================================================================================
// arrow keycaps
// ======================================================================================
function pad(dir) {
  const rot = { up: 0, right: 90, down: 180, left: 270 }[dir];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120" font-family="${FONT}">
<defs><linearGradient id="k" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2E3242"/><stop offset="1" stop-color="#1A1C25"/></linearGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<rect x="8" y="14" width="104" height="100" rx="22" fill="#0B0C11"/>
<rect x="8" y="6" width="104" height="100" rx="22" fill="url(#k)" stroke="#3A3F52"/>
<rect x="18" y="12" width="84" height="40" rx="16" fill="#fff" opacity=".05"/>
<path transform="rotate(${rot} 60 52)" d="M60 34L80 60H40Z" fill="${CYAN}" filter="url(#glow)"/>
<text x="60" y="92" font-size="11" fill="#6B7699" text-anchor="middle" letter-spacing="3">${dir.toUpperCase()}</text>
</svg>`;
}

// ======================================================================================
function svgResponse(body, live) {
  return new Response(body, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": live ? "no-cache, no-store, must-revalidate, max-age=0" : "public, max-age=86400",
      ...(live ? { expires: "0", pragma: "no-cache" } : {}),
    },
  });
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    const arcade = env.ARCADE.get(env.ARCADE.idFromName("world"));
    let m;
    if (pathname === "/screen.svg") return svgResponse(await arcade.screen(), true);
    if ((m = pathname.match(/^\/pad\/(up|down|left|right)\.svg$/))) return svgResponse(pad(m[1]), false);
    if ((m = pathname.match(/^\/(up|down|left|right)$/))) {
      const ua = req.headers.get("user-agent") || "";
      const purpose = (req.headers.get("sec-purpose") || "") + (req.headers.get("purpose") || "");
      if (ua && !BOTS.test(ua) && !/prefetch|prerender/i.test(purpose)) {
        const cf = req.cf || {};
        await arcade.move(m[1], {
          ip: req.headers.get("cf-connecting-ip") || "local",
          city: cf.city || "", cc: cf.country || "",
          lat: parseFloat(cf.latitude), lon: parseFloat(cf.longitude),
        });
      }
      return new Response(null, { status: 302, headers: { location: PROFILE, "cache-control": "no-store" } });
    }
    return Response.redirect(PROFILE, 302);
  },
};
