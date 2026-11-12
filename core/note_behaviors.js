/**
 * What each note color does to a ball. Plain JS (no Matter, no DOM), so it
 * runs under `node --test` (dev/behaviors.test.mjs).
 *
 *   pink   normal wall
 *   green  bouncier wall
 *   blue   portal: a ball that touches one comes out of the other blue note,
 *          turned by the difference between the two notes' angles. Works only
 *          when there are exactly 2 blue notes.
 *
 * All coordinates are screen px. A polygon is [{x,y}, ...].
 */

export const NOTE_COLORS = ["pink", "green", "blue"];

// Wall bounciness. Matter.js bounces with max(ball, wall) and the ball is 0.8.
// Careful: Matter's setStatic() resets a static body's restitution to 0, so it
// only sticks when set AFTER the body is created (core.js polyBody does that).
// null = leave it at 0, i.e. the ball's own 0.8 (how pink always behaved).
// Green 0.9: first bounce ~26% higher than pink from the same drop, still dies down
// (0.95 = +41%, 1.0 = +57% and barely loses height).
export const RESTITUTION = { pink: null, green: 0.9 };

export const PORTAL_COOLDOWN_MS = 300; // a ball can't warp again this soon
const SLOW = 1;                        // px/step: slower than this has no direction

/** True when the portal pair is usable (exactly 2 blue notes). */
export const portalsActive = (blueCount) => blueCount === 2;

/**
 * Dominant edge direction of a square-ish polygon, in radians, in [-PI/4, PI/4).
 * A square looks the same every 90 degrees, so angles are compared modulo 90:
 * each edge votes with angle*4 (weighted by its length) and the average is /4.
 */
export function noteAngle(poly) {
  let c = 0, s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const t = 4 * Math.atan2(dy, dx);
    c += len * Math.cos(t);
    s += len * Math.sin(t);
  }
  return wrapQuarter(Math.atan2(s, c) / 4);
}

/** Angle folded into [-PI/4, PI/4): the smallest turn between two squares. */
export function wrapQuarter(a) {
  const q = Math.PI / 2;
  return ((((a + q / 2) % q) + q) % q) - q / 2;
}

export function rotate(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/**
 * Distance from `c` (inside a convex polygon) to its edge along unit direction `d`.
 * Returns 0 if `c` is outside or the ray misses.
 */
export function rayToEdge(poly, c, d) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-9) continue; // parallel
    const ax = a.x - c.x, ay = a.y - c.y;
    const t = (ax * ey - ay * ex) / den;   // along the ray
    const u = (ax * d.y - ay * d.x) / den; // along the edge, 0..1
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best === Infinity ? 0 : best;
}

/**
 * Where a ball comes out of portal `to` after entering portal `from`.
 *   from, to: { center, poly }    vel: ball velocity    radius: ball radius
 * The velocity turns by the angle between the two notes and keeps its speed.
 * The ball is placed just outside `to`, on the side it is heading for, so it
 * leaves the portal instead of landing inside it. A ball too slow to have a
 * direction drops out of the bottom.
 */
export function portalExit({ from, to, vel, radius }) {
  const turn = wrapQuarter(noteAngle(to.poly) - noteAngle(from.poly));
  const v = rotate(vel, turn);
  const speed = Math.hypot(v.x, v.y);
  const dir = speed > SLOW ? { x: v.x / speed, y: v.y / speed } : { x: 0, y: 1 };
  const dist = rayToEdge(to.poly, to.center, dir) + radius + 2;
  return {
    position: { x: to.center.x + dir.x * dist, y: to.center.y + dir.y * dist },
    velocity: v,
  };
}
