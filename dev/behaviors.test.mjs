// Run: node --test dev/behaviors.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  noteAngle, wrapQuarter, rotate, rayToEdge, portalExit, portalsActive, RESTITUTION,
} from "../core/note_behaviors.js";

const deg = (d) => (d * Math.PI) / 180;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// a size x size square at (cx, cy), rotated by `d` degrees
function square(cx, cy, size, d = 0) {
  const h = size / 2;
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => {
    const p = rotate({ x, y }, deg(d));
    return { x: cx + p.x, y: cy + p.y };
  });
}

test("noteAngle reads a square's rotation, modulo 90 degrees", () => {
  close(noteAngle(square(0, 0, 100, 0)), 0);
  close(noteAngle(square(0, 0, 100, 20)), deg(20));
  close(noteAngle(square(0, 0, 100, -30)), deg(-30));
  close(noteAngle(square(0, 0, 100, 110)), deg(20)); // 110 = 20 + 90
});

test("noteAngle ignores where the polygon starts and its winding", () => {
  const sq = square(5, 7, 80, 15);
  close(noteAngle([...sq.slice(2), ...sq.slice(0, 2)]), deg(15));
  close(noteAngle([...sq].reverse()), deg(15));
});

test("wrapQuarter takes the short way round", () => {
  close(wrapQuarter(deg(50)), deg(-40));
  close(wrapQuarter(deg(-50)), deg(40));
  close(wrapQuarter(deg(10)), deg(10));
});

test("rayToEdge measures center -> edge", () => {
  const sq = square(0, 0, 100);
  close(rayToEdge(sq, { x: 0, y: 0 }, { x: 1, y: 0 }), 50);
  close(rayToEdge(sq, { x: 0, y: 0 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }), 50 * Math.SQRT2);
});

test("portal between two level notes keeps the velocity and exits outside", () => {
  const from = { center: { x: 100, y: 100 }, poly: square(100, 100, 60) };
  const to = { center: { x: 500, y: 300 }, poly: square(500, 300, 60) };
  const out = portalExit({ from, to, vel: { x: 0, y: 10 }, radius: 20 });
  close(out.velocity.x, 0);
  close(out.velocity.y, 10);
  close(out.position.x, 500);
  close(out.position.y, 300 + 30 + 20 + 2); // below the note, clear of it
});

test("portal turns the velocity by the angle between the notes", () => {
  const from = { center: { x: 0, y: 0 }, poly: square(0, 0, 60, 0) };
  const to = { center: { x: 400, y: 0 }, poly: square(400, 0, 60, 30) };
  const out = portalExit({ from, to, vel: { x: 0, y: 10 }, radius: 10 });
  const v = rotate({ x: 0, y: 10 }, deg(30));
  close(out.velocity.x, v.x);
  close(out.velocity.y, v.y);
  close(Math.hypot(out.velocity.x, out.velocity.y), 10); // same speed
  // exit point is outside the destination note
  const d = Math.hypot(out.position.x - 400, out.position.y);
  assert.ok(d > 30 + 10, `exit ${d}px from center`);
});

test("a stopped ball drops out of the bottom", () => {
  const from = { center: { x: 0, y: 0 }, poly: square(0, 0, 60) };
  const to = { center: { x: 200, y: 200 }, poly: square(200, 200, 60) };
  const out = portalExit({ from, to, vel: { x: 0, y: 0 }, radius: 10 });
  close(out.position.x, 200);
  assert.ok(out.position.y > 200 + 30);
});

test("portals need exactly two blue notes", () => {
  assert.equal(portalsActive(0), false);
  assert.equal(portalsActive(1), false);
  assert.equal(portalsActive(2), true);
  assert.equal(portalsActive(3), false);
});

test("pink keeps the ball's own bounce; green beats the ball's 0.8", () => {
  assert.equal(RESTITUTION.pink, null);
  assert.ok(RESTITUTION.green > 0.8 && RESTITUTION.green < 1);
});
