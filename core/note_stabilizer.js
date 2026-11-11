/**
 * Keeps note shapes still while the camera's view of them jitters.
 *
 * Every detection gives a slightly different outline (noise, a curled corner
 * catching light, a shadow). Feeding those straight into physics makes the
 * walls twitch and the balls take a different path each time. This sits in
 * between: each note's shape is LOCKED and only replaced when the note has
 * really moved.
 *
 * How:
 *   - A shape is described by its center plus the distance to its edge along
 *     RAYS fixed directions (a "radial signature"). Outlines are convex, so each
 *     ray hits the edge exactly once, and every shape has the same RAYS numbers,
 *     whatever its vertex count. That makes shapes easy to average and compare.
 *   - The last `recent` observations of a note are combined by median (a
 *     single bad frame can't move it).
 *   - If that median is more than `commitPx` away from the locked shape at any
 *     ray, the locked shape is replaced (`version` goes up). Otherwise nothing
 *     changes, so the physics body stays exactly where it was.
 *   - A note that disappears (hand in front) keeps its shape for `maxMissing`
 *     detections before it is dropped.
 *
 * Plain JS, no OpenCV or DOM, so it runs under `node --test`.
 * All coordinates are screen px. Input notes: { center, corners, outline? }.
 */

export const RAYS = 32;

export class NoteStabilizer {
  constructor(options = {}) {
    this.rays = options.rays ?? RAYS;
    this.recent = options.recent ?? 4;          // observations combined by median
    this.commitPx = options.commitPx ?? 8;      // shape change needed to move the wall
    this.confirm = options.confirm ?? 3;        // sightings before a new note gets a wall
    this.maxMissing = options.maxMissing ?? 20; // detections a note may vanish (~1 s at 20 fps)
    this.matchDist = options.matchDist ?? 60;   // px: max center distance for "same note"

    this.tracks = [];   // { id, version, center, sig, poly, history, missing }
    this.nextId = 1;
    this.locked = false; // true = ignore the camera, keep every shape as it is
    this.jitter = 0;     // largest change (px) seen this update that did NOT move a wall
  }

  /** Notes that currently have a locked shape: [{ id, version, center, poly }]. */
  get stable() {
    return this.tracks.filter((t) => t.poly).map(({ id, version, center, poly }) => ({ id, version, center, poly }));
  }

  /** Forget everything (e.g. calibration changed, so screen positions moved). */
  clear() {
    this.tracks = [];
  }

  /** Feed one detection (all notes seen in it). Returns `stable`. */
  update(notes) {
    if (this.locked) return this.stable;
    this.jitter = 0;

    const obs = notes.map((n) => {
      const poly = convexHull(n.outline ?? n.corners);
      return { poly, center: polygonCentroid(poly) };
    }).filter((o) => o.poly.length >= 3);

    // 1. pair tracks with observations, nearest first, each used once
    const pairs = [];
    this.tracks.forEach((t, ti) => {
      const c = t.center ?? t.history[t.history.length - 1].center;
      obs.forEach((o, oi) => {
        const d = Math.hypot(c.x - o.center.x, c.y - o.center.y);
        if (d < this.matchDist) pairs.push({ ti, oi, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set(), usedO = new Set();
    for (const { ti, oi } of pairs) {
      if (usedT.has(ti) || usedO.has(oi)) continue;
      usedT.add(ti); usedO.add(oi);
      this.#observe(this.tracks[ti], obs[oi]);
    }

    // 2. unseen tracks age out
    this.tracks = this.tracks.filter((t, ti) => usedT.has(ti) || ++t.missing <= this.maxMissing);

    // 3. new notes
    obs.forEach((o, oi) => {
      if (usedO.has(oi)) return;
      const t = { id: this.nextId++, version: 0, center: null, sig: null, poly: null, history: [], missing: 0, settle: 0 };
      this.tracks.push(t);
      this.#observe(t, o);
    });

    return this.stable;
  }

  #observe(t, o) {
    t.missing = 0;
    t.history.push(o);
    if (t.history.length > this.recent) t.history.shift();

    // a brand-new note needs a few sightings first (filters one-frame specks)
    if (!t.poly && t.history.length < Math.min(this.confirm, this.recent)) return;

    const cand = medianShape(t.history, this.rays);
    if (t.poly) {
      const diff = shapeDistance(t.center, t.sig, cand.center, cand.sig, this.rays);
      if (diff > this.commitPx) {
        // really moved: start the median over from here so the old spot can't drag it back
        t.history = [o];
        t.settle = this.recent; // refine the next few frames (one frame is noisy)
        return this.#commit(t, { center: o.center, sig: radialSignature(o.poly, o.center, this.rays) });
      }
      if (t.settle > 0) {
        t.settle -= 1;
        if (diff > 1) this.#commit(t, cand);
        return;
      }
      this.jitter = Math.max(this.jitter, diff);
      return;
    }
    this.#commit(t, cand);
  }

  #commit(t, shape) {
    t.center = shape.center;
    t.sig = shape.sig;
    t.poly = simplifyConvex(signatureToPolygon(shape.center, shape.sig));
    t.version += 1;
  }
}

// ---------- geometry helpers (exported for tests) ----------

/** Convex hull, Andrew's monotone chain. Returns points in angle order around the center. */
export function convexHull(points) {
  const pts = points.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Area centroid of a simple polygon (falls back to the vertex mean if degenerate). */
export function polygonCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

const rayDir = (i, rays) => {
  const a = (i / rays) * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
};

/** Distance from `center` to the edge of convex `poly` along each of `rays` directions. */
export function radialSignature(poly, center, rays = RAYS) {
  const sig = new Array(rays).fill(0);
  for (let i = 0; i < rays; i++) {
    const d = rayDir(i, rays);
    let best = 0;
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      const ex = q.x - p.x, ey = q.y - p.y;
      const den = d.x * ey - d.y * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = p.x - center.x, wy = p.y - center.y;
      const t = (wx * ey - wy * ex) / den;      // along the ray
      const s = (wx * d.y - wy * d.x) / den;    // along the edge, 0..1
      if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
    }
    sig[i] = best;
  }
  return sig;
}

export function signatureToPolygon(center, sig) {
  return sig.map((r, i) => {
    const d = rayDir(i, sig.length);
    return { x: center.x + d.x * r, y: center.y + d.y * r };
  });
}

/** Largest gap (px) between two shapes, compared ray by ray. */
export function shapeDistance(c1, s1, c2, s2, rays = RAYS) {
  let worst = 0;
  for (let i = 0; i < rays; i++) {
    const d = rayDir(i, rays);
    const dx = c2.x - c1.x + d.x * (s2[i] - s1[i]);
    const dy = c2.y - c1.y + d.y * (s2[i] - s1[i]);
    worst = Math.max(worst, Math.hypot(dx, dy));
  }
  return worst;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Per-ray median of several observations, all measured from their median center. */
export function medianShape(observations, rays = RAYS) {
  const center = { x: median(observations.map((o) => o.center.x)), y: median(observations.map((o) => o.center.y)) };
  const sigs = observations.map((o) => radialSignature(o.poly, center, rays));
  const sig = sigs[0].map((_, i) => median(sigs.map((s) => s[i])));
  return { center, sig };
}

/** Drop vertices that sit (almost) on the line between their neighbors. */
export function simplifyConvex(poly, tolerance = 1) {
  let pts = poly;
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      const dist = Math.abs((c.x - a.x) * (a.y - b.y) - (a.x - b.x) * (c.y - a.y)) / len;
      if (dist < tolerance) { pts = pts.filter((_, j) => j !== i); changed = true; break; }
    }
  }
  return pts;
}
