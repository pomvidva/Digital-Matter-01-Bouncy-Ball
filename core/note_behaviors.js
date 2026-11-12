/**
 * What each note color does to a ball. Plain JS (no Matter, no DOM), so it
 * runs under `node --test` (dev/behaviors.test.mjs).
 *
 *   pink   normal wall
 *   green  launch pad: a ball that touches one is shot away from it at
 *          GREEN_LAUNCH speed or more, so it keeps bouncing like a trampoline
 *   blue   splitter: a ball that hits one breaks into SPLIT_PARTS smaller
 *          balls that fan out; those can split again until they get too small
 *
 * All coordinates are screen px. A polygon is [{x,y}, ...].
 */

export const NOTE_COLORS = ["pink", "green", "blue"];

// Wall bounciness. Matter.js bounces with max(ball, wall) and the ball is 0.8.
// Careful: Matter's setStatic() resets a static body's restitution to 0, so it
// only sticks when set AFTER the body is created (core.js polyBody does that).
// null = leave it at 0, i.e. the ball's own 0.8 (how pink always behaved).
export const RESTITUTION = { pink: null, green: 0.9 };

// Speed a green note shoots a ball away with (Matter velocity units, px per
// 1/60 s). Bounciness alone (0.9) was too close to pink to notice.
export const GREEN_LAUNCH = 18;

// Blue splitter. Each split makes balls SPLIT_SCALE as big; only balls at
// least MIN_SPLIT_RADIUS split, so a 20px ball splits twice (20 -> 14 -> 9.8)
// and one drop ends as at most 9 balls.
export const SPLIT_PARTS = 3;
export const SPLIT_SCALE = 0.7;
export const MIN_SPLIT_RADIUS = 12;
export const SPLIT_SPREAD = 0.5;        // radians between neighbouring pieces (~29 deg)
export const SPLIT_MIN_SPEED = 4;       // pieces leave the note at least this fast
export const SPLIT_COOLDOWN_MS = 250;   // a fresh piece can't split again this soon

const rotate = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

/**
 * The pieces a ball breaks into when it hits a blue note.
 *   position, vel, radius: the ball    normal: outwardNormal of the note at the ball
 * Pieces sit side by side along the note's surface, just off it, and fly out in
 * a fan around the ball's own direction (pushed away from the note if needed).
 */
export function splitBall({ position, vel, normal, radius }) {
  const r = radius * SPLIT_SCALE;
  const away = vel.x * normal.x + vel.y * normal.y;
  const v = away >= SPLIT_MIN_SPEED ? { ...vel }
    : { x: vel.x + normal.x * (SPLIT_MIN_SPEED - away), y: vel.y + normal.y * (SPLIT_MIN_SPEED - away) };
  const along = { x: -normal.y, y: normal.x };
  const parts = [];
  for (let i = 0; i < SPLIT_PARTS; i++) {
    const k = i - (SPLIT_PARTS - 1) / 2;   // -1, 0, 1: left, middle, right
    parts.push({
      position: { x: position.x + along.x * k * 2.2 * r + normal.x * 2,
                  y: position.y + along.y * k * 2.2 * r + normal.y * 2 },
      velocity: rotate(v, k * SPLIT_SPREAD),
    });
  }
  return { radius: r, parts };
}

/**
 * Unit normal of the polygon edge nearest to point `p`, pointing out of the
 * polygon (towards `p` when `p` is outside).
 */
export function outwardNormal(poly, p) {
  let best = null, bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y, len2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2));
    const d = Math.hypot(p.x - (a.x + t * ex), p.y - (a.y + t * ey));
    if (d < bestD) { bestD = d; best = { ex, ey }; }
  }
  const len = Math.hypot(best.ex, best.ey) || 1;
  let n = { x: -best.ey / len, y: best.ex / len };
  // flip to point away from the polygon's middle
  const c = poly.reduce((s, q) => ({ x: s.x + q.x / poly.length, y: s.y + q.y / poly.length }), { x: 0, y: 0 });
  if ((p.x - c.x) * n.x + (p.y - c.y) * n.y < 0) n = { x: -n.x, y: -n.y };
  return n;
}

/**
 * Velocity of a ball after a green note launches it: the part moving away from
 * the note is raised to at least `speed`; the sideways part is kept, so a ball
 * hitting at a slant still leaves at a slant.
 */
export function greenLaunch({ vel, normal, speed = GREEN_LAUNCH }) {
  const away = vel.x * normal.x + vel.y * normal.y;
  if (away >= speed) return { ...vel };
  return { x: vel.x + normal.x * (speed - away), y: vel.y + normal.y * (speed - away) };
}
