// Cup game (game.html): 5 levels. Each round, 10 balls drop from a fixed chute (space).
// Land them in the cup, past the level's walls, to score. Notes (real or fake)
// are how you steer them. Get PASS_HITS balls in to unlock the next level.
//
// Game API: layout(w, h), startLevel(i), release(now), reset(), update(now), draw(ctx, now).
// The default export wires it into core/core.js as a project.
// Colors: never pink or red, the camera would see them as notes.

const { Bodies, Composite } = Matter;

const BALLS_PER_ROUND = 10;
const POINTS = 10;              // per ball in the cup
const PASS_HITS = 3;            // balls in the cup needed to clear a level
const COOLDOWN_MS = 500;        // min time between two drops
const SETTLE_MS = 1200;         // a ball this still for this long is done (missed)
const STILL_SPEED = 0.25;       // px per physics step
const BALL_TIMEOUT_MS = 15000;  // a ball still moving after this is done (missed)
const RESTART_GUARD_MS = 800;   // after a round ends, ignore space this long
const GHOST_MS = 700;           // fade-out of a finished ball
const POPUP_MS = 1000;
const BEST_KEY = "bouncy.best";

const CHUTE_Y = 70;
const CUP_H = 110, CUP_WALL = 14;
const WALL_T = 24;              // obstacle thickness, px
const CUP_COLOR = "#7cf29a", WALL_COLOR = "#8aa0b8", MISS_COLOR = "#445060";

// Levels, easy -> hard. Positions are fractions of the screen (x of width, y of
// height) so they fit any projector. chute = drop x, cup = { fx, w: inner px },
// walls = [x0, y0, x1, y1] segments. A ball dropped with no notes always misses.
// Difficulty was checked by simulating random note placements: the share that
// scores drops from ~8% (level 1) to ~0.1% (level 5). Farther cup = harder.
export const LEVELS = [
  { name: "Warm-up", chute: 0.20, cup: { fx: 0.50, w: 200 },    // one low wall: a single ramp does it
    walls: [[0.36, 0.80, 0.36, 1]] },
  { name: "Roof", chute: 0.50, cup: { fx: 0.15, w: 140 },       // slab under the chute, a guard by the cup
    walls: [[0.30, 0.40, 0.70, 0.40], [0.30, 0.70, 0.30, 1]] },
  { name: "The Wall", chute: 0.15, cup: { fx: 0.64, w: 170 },   // tall wall: go over it
    walls: [[0.42, 0.55, 0.42, 1]] },
  { name: "Zigzag", chute: 0.15, cup: { fx: 0.74, w: 140 },     // under the first wall, over the second
    walls: [[0.36, 0, 0.36, 0.45], [0.56, 0.68, 0.56, 1]] },
  { name: "Fortress", chute: 0.88, cup: { fx: 0.12, w: 110 },   // all the way across, into a roofed cup
    walls: [[0.66, 0, 0.66, 0.50], [0.40, 0.62, 0.40, 1], [0.06, 0.62, 0.19, 0.62]] },
];

// best score per level
function loadBest() {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY));
    return LEVELS.map((_, i) => (Array.isArray(v) && +v[i]) || 0);
  } catch { return LEVELS.map(() => 0); }
}
function saveBest(v) {
  try { localStorage.setItem(BEST_KEY, JSON.stringify(v)); } catch { /* storage blocked */ }
}

// segment in screen fractions -> static rectangle WALL_T thick (ends overhang by WALL_T/2)
function segBody([x0, y0, x1, y1], w, h, opts) {
  const ax = x0 * w, ay = y0 * h, bx = x1 * w, by = y1 * h;
  return Bodies.rectangle((ax + bx) / 2, (ay + by) / 2, Math.hypot(bx - ax, by - ay) + WALL_T, WALL_T,
    { ...opts, angle: Math.atan2(by - ay, bx - ax) });
}

export class Game {
  constructor({ world, dropBall }) {
    this.world = world;
    this.dropBall = dropBall;   // (x, y) -> ball body
    this.w = 0; this.h = 0;
    this.level = 0;
    this.levelScores = LEVELS.map(() => null);   // this run's clearing score per level
    this.cup = null;
    this.bodies = [];           // cup walls + obstacles
    this.walls = [];            // obstacles only (for drawing)
    this.best = loadBest();
    this.lastT = 0;
    this.reset();
  }

  get def() { return LEVELS[this.level]; }
  get chute() { return { x: Math.round(this.w * this.def.chute), y: CHUTE_Y }; }
  get hits() { return this.results.filter((p) => p > 0).length; }
  get passed() { return this.hits >= PASS_HITS; }
  get total() { return this.levelScores.reduce((a, s) => a + (s || 0), 0); }

  startLevel(i) {
    this.level = Math.max(0, Math.min(LEVELS.length - 1, i));
    this.build();
    this.reset();
  }

  layout(w, h) {
    this.w = w; this.h = h;
    this.build();
  }

  build() {
    Composite.remove(this.world, this.bodies);
    const { cup, walls } = this.def;
    this.cup = { x: this.w * cup.fx, w: cup.w, top: this.h - CUP_H };
    const off = cup.w / 2 + CUP_WALL / 2;
    const cupOpts = { isStatic: true, restitution: 0.3, friction: 0.1, label: "cup" };
    this.walls = walls.map((s) => segBody(s, this.w, this.h, { isStatic: true, restitution: 0.5, label: "wall" }));
    this.bodies = [
      Bodies.rectangle(this.cup.x - off, this.h - CUP_H / 2, CUP_WALL, CUP_H, cupOpts),
      Bodies.rectangle(this.cup.x + off, this.h - CUP_H / 2, CUP_WALL, CUP_H, cupOpts),
      ...this.walls,
    ];
    Composite.add(this.world, this.bodies);   // the floor is the cup's bottom
  }

  // restart the current level's round
  reset() {
    this.removeLive();
    this.live = [];                                    // { body, i, t0, still }
    this.results = Array(BALLS_PER_ROUND).fill(null);  // points per ball, null = not done yet
    this.released = 0;
    this.score = 0;
    this.state = "playing";                            // "playing" | "over"
    this.overAt = 0;
    this.newBest = false;
    this.lastDrop = -Infinity;
    this.ghosts = [];                                  // finished balls fading out
    this.popups = [];                                  // "+10" texts
  }

  removeLive() {
    if (this.live?.length) Composite.remove(this.world, this.live.map((b) => b.body));
  }

  release(now) {
    if (this.state === "over") {
      if (now - this.overAt <= RESTART_GUARD_MS) return;
      if (!this.passed) this.reset();                                   // try again
      else if (this.level < LEVELS.length - 1) this.startLevel(this.level + 1);
      else { this.levelScores = LEVELS.map(() => null); this.startLevel(0); }   // all clear: new run
      return;
    }
    if (this.released >= BALLS_PER_ROUND || now - this.lastDrop < COOLDOWN_MS) return;
    const { x, y } = this.chute;
    const body = this.dropBall(x, y + 10);
    this.live.push({ body, i: this.released, t0: now, still: 0 });
    this.released++;
    this.lastDrop = now;
  }

  // a ball is done: it scored `points` (0 = missed). It leaves the world and fades out.
  finish(b, points, now, ghost = true) {
    b.done = true;
    this.results[b.i] = points;
    this.score += points;
    Composite.remove(this.world, b.body);
    const { x, y } = b.body.position;
    if (ghost) this.ghosts.push({ x, y, r: b.body.circleRadius, color: points ? "#fff" : MISS_COLOR, t0: now });
    if (points) this.popups.push({ x, y: y - 30, text: `+${points}`, t0: now });
  }

  update(now) {
    const dt = Math.min(100, now - (this.lastT || now));
    this.lastT = now;

    const inWorld = new Set(Composite.allBodies(this.world));
    const c = this.cup;
    for (const b of this.live) {
      if (!inWorld.has(b.body)) { this.finish(b, 0, now, false); continue; }   // cleared with `x`
      const p = b.body.position, r = b.body.circleRadius;
      if (Math.abs(p.x - c.x) < c.w / 2 && p.y > c.top + r) { this.finish(b, POINTS, now); continue; }
      const v = b.body.velocity;
      b.still = Math.hypot(v.x, v.y) < STILL_SPEED ? b.still + dt : 0;
      if (b.still > SETTLE_MS || now - b.t0 > BALL_TIMEOUT_MS || p.y > this.h + 200) this.finish(b, 0, now);
    }
    this.live = this.live.filter((b) => !b.done);
    this.ghosts = this.ghosts.filter((g) => now - g.t0 < GHOST_MS);
    this.popups = this.popups.filter((p) => now - p.t0 < POPUP_MS);

    if (this.state === "playing" && this.released === BALLS_PER_ROUND && !this.live.length) {
      this.state = "over";
      this.overAt = now;
      if (this.passed) this.levelScores[this.level] = this.score;
      if (this.score > this.best[this.level]) {
        this.best[this.level] = this.score; this.newBest = true; saveBest(this.best);
      }
    }
  }

  draw(ctx, now) {
    ctx.save();
    this.drawLevel(ctx);
    this.drawChute(ctx, now);
    this.drawEffects(ctx, now);
    this.drawHud(ctx);
    if (this.state === "over") this.drawResults(ctx, now);
    ctx.restore();
  }

  drawLevel(ctx) {
    ctx.fillStyle = WALL_COLOR;
    for (const b of this.walls) {
      const v = b.vertices;
      ctx.beginPath(); ctx.moveTo(v[0].x, v[0].y);
      for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y);
      ctx.closePath(); ctx.fill();
    }
    const c = this.cup;
    ctx.fillStyle = CUP_COLOR;
    ctx.globalAlpha = 0.12; ctx.fillRect(c.x - c.w / 2, c.top, c.w, CUP_H);
    ctx.globalAlpha = 1;
    ctx.fillRect(c.x - c.w / 2 - CUP_WALL, c.top, CUP_WALL, CUP_H);
    ctx.fillRect(c.x + c.w / 2, c.top, CUP_WALL, CUP_H);
  }

  drawChute(ctx, now) {
    const { x, y } = this.chute;
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 4; ctx.lineJoin = "round";
    ctx.beginPath();                         // funnel
    ctx.moveTo(x - 46, y - 50); ctx.lineTo(x - 26, y - 6); ctx.lineTo(x - 26, y + 4);
    ctx.moveTo(x + 46, y - 50); ctx.lineTo(x + 26, y - 6); ctx.lineTo(x + 26, y + 4);
    ctx.stroke();
    // next ball waiting in the funnel
    const ready = this.state === "playing" && this.released < BALLS_PER_ROUND && now - this.lastDrop >= COOLDOWN_MS;
    if (ready) {
      ctx.beginPath(); ctx.arc(x, y - 26, 18, 0, Math.PI * 2);
      ctx.fillStyle = "#fff"; ctx.fill();
    }
  }

  drawEffects(ctx, now) {
    for (const g of this.ghosts) {
      const k = (now - g.t0) / GHOST_MS;
      ctx.globalAlpha = 1 - k; ctx.fillStyle = g.color;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r * (1 - 0.5 * k), 0, Math.PI * 2); ctx.fill();
    }
    ctx.textAlign = "center"; ctx.font = "bold 34px ui-monospace, monospace";
    for (const p of this.popups) {
      const k = (now - p.t0) / POPUP_MS;
      ctx.globalAlpha = 1 - k; ctx.fillStyle = CUP_COLOR;
      ctx.fillText(p.text, p.x, p.y - 50 * k);
    }
    ctx.globalAlpha = 1;
  }

  // top center: level, ball count, score, best, and one dot per ball
  drawHud(ctx) {
    const cx = this.w / 2;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#9ab"; ctx.font = "bold 18px ui-monospace, monospace";
    ctx.fillText(`LEVEL ${this.level + 1}/${LEVELS.length} · ${this.def.name.toUpperCase()}`, cx, 24);
    ctx.fillStyle = "#fff"; ctx.font = "bold 26px ui-monospace, monospace";
    const ball = Math.min(this.released + (this.state === "playing" ? 1 : 0), BALLS_PER_ROUND);
    ctx.fillText(`BALL ${ball}/${BALLS_PER_ROUND}   SCORE ${this.score}   BEST ${this.best[this.level]}`, cx, 56);
    this.drawDots(ctx, cx, 90, 9, 26);
    if (this.released === 0) {
      ctx.font = "16px ui-monospace, monospace"; ctx.fillStyle = "#9ab";
      ctx.fillText(`space = drop ball · place notes to steer it · ${PASS_HITS} in the cup to clear`, cx, 120);
    }
  }

  // one dot per ball: hollow = not dropped / in flight, filled = done (grey = miss)
  drawDots(ctx, cx, y, r, gap, labels = false) {
    const x0 = cx - (gap * (BALLS_PER_ROUND - 1)) / 2;
    this.results.forEach((pts, i) => {
      const x = x0 + i * gap;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      if (pts === null) { ctx.lineWidth = 2; ctx.strokeStyle = "#667"; ctx.stroke(); }
      else { ctx.fillStyle = pts ? CUP_COLOR : MISS_COLOR; ctx.fill(); }
      if (labels) {
        ctx.fillStyle = pts ? "#05070a" : "#9ab";
        ctx.fillText(pts ? String(pts) : "–", x, y + 1);
      }
    });
  }

  drawResults(ctx, now) {
    const k = Math.min(1, (now - this.overAt) / 300);   // fade in
    const cx = this.w / 2, cy = this.h / 2;
    const last = this.level === LEVELS.length - 1;
    const allClear = last && this.passed;
    ctx.globalAlpha = 0.7 * k; ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalAlpha = k;

    const cw = Math.min(560, this.w - 32), ch = allClear ? 400 : 340;
    const top = cy - ch / 2;
    ctx.fillStyle = "#0c121a"; ctx.strokeStyle = this.passed ? CUP_COLOR : WALL_COLOR; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(cx - cw / 2, top, cw, ch, 18); ctx.fill(); ctx.stroke();

    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = this.passed ? CUP_COLOR : "#9ab"; ctx.font = "bold 20px ui-monospace, monospace";
    ctx.fillText(this.passed ? `LEVEL ${this.level + 1} CLEAR!` : `LEVEL ${this.level + 1} · TRY AGAIN`, cx, top + 40);
    ctx.fillStyle = "#fff"; ctx.font = "bold 96px ui-monospace, monospace";
    ctx.fillText(String(this.score), cx, top + 115);
    ctx.font = "20px ui-monospace, monospace"; ctx.fillStyle = "#cfe";
    ctx.fillText(`${this.hits}/${BALLS_PER_ROUND} in the cup · best ${this.best[this.level]}`, cx, top + 187);
    ctx.font = "bold 18px ui-monospace, monospace";
    if (this.newBest) { ctx.fillStyle = "#ffb000"; ctx.fillText("NEW BEST!", cx, top + 217); }
    else if (!this.passed) { ctx.fillStyle = "#9ab"; ctx.fillText(`need ${PASS_HITS} in the cup`, cx, top + 217); }
    ctx.font = "bold 13px ui-monospace, monospace";
    this.drawDots(ctx, cx, top + 260, 17, Math.min(44, (cw - 40) / BALLS_PER_ROUND), true);

    let y = top + 306;
    if (allClear) {
      ctx.fillStyle = "#ffb000"; ctx.font = "bold 26px ui-monospace, monospace";
      ctx.fillText(`ALL CLEAR · TOTAL ${this.total}`, cx, y);
      ctx.fillStyle = "#cfe"; ctx.font = "16px ui-monospace, monospace";
      ctx.fillText(this.levelScores.map((s, i) => `L${i + 1} ${s}`).join("  "), cx, y + 32);
      y += 66;
    }
    if (now - this.overAt > RESTART_GUARD_MS) {
      const next = !this.passed ? "try again" : last ? "play from level 1" : "next level";
      ctx.fillStyle = "#9ab"; ctx.font = "16px ui-monospace, monospace";
      ctx.fillText(`space = ${next} · r = replay level · g = leave game`, cx, y);
    }
    ctx.globalAlpha = 1;
  }
}

// ---------- project hooks (see core/core.js) ----------
let game;
export default {
  title: "Cup Game",
  help: `<b>space</b> drop ball (10 per round) · <b>r</b> replay level<br>
         <b>1</b>–<b>${LEVELS.length}</b> jump to level · clicks don't drop balls`,
  setup(core) { game = new Game(core); },
  resize(w, h) { game.layout(w, h); },
  update(now) { game.update(now); },
  draw(ctx, now) { game.draw(ctx, now); },
  onKey(e) {
    const k = e.key.toLowerCase();
    if (k === " ") game.release(performance.now());
    else if (k === "r") game.reset();
    else if (k >= "1" && k <= String(LEVELS.length)) game.startLevel(+k - 1);
    else return false;
    return true;
  },
  onPointer() { return true; },   // balls only come from the chute
};
