// Run: node --test dev/stabilizer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NoteStabilizer, convexHull, polygonCentroid, radialSignature, signatureToPolygon,
  shapeDistance, simplifyConvex,
} from "../core/note_stabilizer.js";

// a w x h rectangle at (cx, cy), rotated by `deg`, as a note { corners, center }
function rectNote(cx, cy, w, h, deg = 0, jitter = 0, rand = Math.random) {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const j = () => (rand() * 2 - 1) * jitter;
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({
    x: cx + x * cos - y * sin + j(), y: cy + x * sin + y * cos + j(),
  }));
  return { corners, center: { x: cx, y: cy } };
}

// deterministic random so failures are repeatable
function seeded(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("convexHull fills a bite taken out of a square", () => {
  const bitten = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 60, y: 50 }, // the notch
    { x: 100, y: 60 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ];
  const hull = convexHull(bitten);
  assert.equal(hull.length, 4);
  const c = polygonCentroid(hull);
  assert.ok(Math.abs(c.x - 50) < 1e-9 && Math.abs(c.y - 50) < 1e-9);
});

test("radial signature round-trips a square within a few px", () => {
  const sq = convexHull(rectNote(200, 200, 100, 100).corners);
  const c = polygonCentroid(sq);
  const back = convexHull(signatureToPolygon(c, radialSignature(sq, c)));
  assert.ok(shapeDistance(c, radialSignature(sq, c), c, radialSignature(back, c)) < 3);
  assert.ok(Math.abs(radialSignature(sq, c)[0] - 50) < 1e-6); // side midpoint hit exactly
});

test("simplifyConvex drops collinear points", () => {
  const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  assert.equal(simplifyConvex(pts).length, 4);
});

test("a new note gets a wall only after `confirm` sightings", () => {
  const s = new NoteStabilizer({ confirm: 3 });
  assert.equal(s.update([rectNote(300, 300, 120, 120)]).length, 0);
  assert.equal(s.update([rectNote(300, 300, 120, 120)]).length, 0);
  assert.equal(s.update([rectNote(300, 300, 120, 120)]).length, 1);
});

test("±3 px noise never moves the wall", () => {
  const rand = seeded(42);
  const s = new NoteStabilizer();
  for (let i = 0; i < 3; i++) s.update([rectNote(400, 300, 150, 150, 10, 3, rand)]);
  const [first] = s.stable;
  for (let i = 0; i < 200; i++) s.update([rectNote(400, 300, 150, 150, 10, 3, rand)]);
  const [after] = s.stable;
  assert.equal(after.version, first.version, "wall was rebuilt by noise");
  assert.deepEqual(after.poly, first.poly);
});

test("a single wild frame does not move the wall", () => {
  const s = new NoteStabilizer();
  for (let i = 0; i < 5; i++) s.update([rectNote(400, 300, 150, 150)]);
  const v = s.stable[0].version;
  s.update([rectNote(430, 300, 150, 150)]); // one bad detection, 30 px off
  for (let i = 0; i < 5; i++) s.update([rectNote(400, 300, 150, 150)]);
  assert.equal(s.stable[0].version, v);
});

test("moving the note 20 px moves the wall to the new spot", () => {
  const s = new NoteStabilizer();
  for (let i = 0; i < 5; i++) s.update([rectNote(400, 300, 150, 150)]);
  const v = s.stable[0].version;
  for (let i = 0; i < 8; i++) s.update([rectNote(420, 300, 150, 150)]);
  const [n] = s.stable;
  assert.ok(n.version > v);
  assert.ok(Math.abs(n.center.x - 420) < 1.5, `center ${n.center.x}`);
});

test("a hidden note keeps its wall for maxMissing detections, then goes", () => {
  const s = new NoteStabilizer({ maxMissing: 10 });
  for (let i = 0; i < 4; i++) s.update([rectNote(400, 300, 150, 150)]);
  const { id, version } = s.stable[0];
  for (let i = 0; i < 10; i++) s.update([]);
  assert.equal(s.stable.length, 1);
  s.update([rectNote(400, 300, 150, 150)]); // back: same wall
  assert.equal(s.stable[0].id, id);
  assert.equal(s.stable[0].version, version);
  for (let i = 0; i < 11; i++) s.update([]);
  assert.equal(s.stable.length, 0);
});

test("two notes keep their own walls", () => {
  const s = new NoteStabilizer();
  for (let i = 0; i < 4; i++) s.update([rectNote(200, 300, 100, 100), rectNote(600, 300, 100, 100)]);
  const ids = s.stable.map((n) => n.id).sort();
  for (let i = 0; i < 4; i++) s.update([rectNote(600, 300, 100, 100), rectNote(200, 300, 100, 100)]); // order swapped
  assert.deepEqual(s.stable.map((n) => n.id).sort(), ids);
});

test("locked ignores everything", () => {
  const s = new NoteStabilizer();
  for (let i = 0; i < 4; i++) s.update([rectNote(400, 300, 150, 150)]);
  const before = s.stable;
  s.locked = true;
  for (let i = 0; i < 30; i++) s.update([]);
  for (let i = 0; i < 30; i++) s.update([rectNote(500, 300, 150, 150)]);
  assert.deepEqual(s.stable, before);
});

test("outline is preferred over corners", () => {
  const s = new NoteStabilizer({ confirm: 1 });
  const outline = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }];
  s.update([{ corners: rectNote(50, 50, 10, 10).corners, outline, center: { x: 100, y: 100 } }]);
  const c = s.stable[0].center;
  assert.ok(Math.abs(c.x - 100) < 1e-6 && Math.abs(c.y - 100) < 1e-6);
});
