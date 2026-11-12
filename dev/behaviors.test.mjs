// Run: node --test dev/behaviors.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESTITUTION, outwardNormal, greenLaunch, GREEN_LAUNCH,
  splitBall, SPLIT_PARTS, SPLIT_SCALE, MIN_SPLIT_RADIUS, SPLIT_MIN_SPEED,
} from "../core/note_behaviors.js";

const deg = (d) => (d * Math.PI) / 180;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const rotate = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

// a size x size square at (cx, cy), rotated by `d` degrees
function square(cx, cy, size, d = 0) {
  const h = size / 2;
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => {
    const p = rotate({ x, y }, deg(d));
    return { x: cx + p.x, y: cy + p.y };
  });
}

test("pink keeps the ball's own bounce; green beats the ball's 0.8", () => {
  assert.equal(RESTITUTION.pink, null);
  assert.ok(RESTITUTION.green > 0.8 && RESTITUTION.green < 1);
});

test("outwardNormal points from the nearest edge towards the ball", () => {
  const sq = square(0, 0, 100);
  const up = outwardNormal(sq, { x: 10, y: -70 });
  close(up.x, 0); close(up.y, -1);
  const right = outwardNormal(sq, { x: 80, y: 5 });
  close(right.x, 1); close(right.y, 0);
  // winding doesn't matter
  const flipped = outwardNormal([...sq].reverse(), { x: 10, y: -70 });
  close(flipped.x, 0); close(flipped.y, -1);
});

test("green launches a falling ball back up at GREEN_LAUNCH, keeping sideways speed", () => {
  // after Matter's bounce the ball moves up a little; green raises it to full speed
  const v = greenLaunch({ vel: { x: 3, y: -2 }, normal: { x: 0, y: -1 } });
  close(v.x, 3); close(v.y, -GREEN_LAUNCH);
  // even a ball still moving into the pad leaves at full speed
  close(greenLaunch({ vel: { x: 0, y: 5 }, normal: { x: 0, y: -1 } }).y, -GREEN_LAUNCH);
});

test("green never slows a ball that is already leaving faster", () => {
  const v = greenLaunch({ vel: { x: 0, y: -(GREEN_LAUNCH + 5) }, normal: { x: 0, y: -1 } });
  close(v.y, -(GREEN_LAUNCH + 5));
});

test("blue splits a ball into smaller pieces that fan out", () => {
  const out = splitBall({ position: { x: 100, y: 100 }, vel: { x: 0, y: -8 }, normal: { x: 0, y: -1 }, radius: 20 });
  close(out.radius, 20 * SPLIT_SCALE);
  assert.equal(out.parts.length, SPLIT_PARTS);
  const speeds = out.parts.map((p) => Math.hypot(p.velocity.x, p.velocity.y));
  for (const sp of speeds) close(sp, 8);                    // same speed, new directions
  const xs = out.parts.map((p) => p.velocity.x);
  assert.ok(xs[0] < 0 && Math.abs(xs[1]) < 1e-9 && xs[2] > 0, "left, straight, right");
});

test("split pieces don't overlap each other or start inside the note", () => {
  const out = splitBall({ position: { x: 0, y: 0 }, vel: { x: 0, y: -5 }, normal: { x: 0, y: -1 }, radius: 20 });
  const [a, b] = out.parts.map((p) => p.position);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 2 * out.radius, "neighbours apart");
  for (const p of out.parts) assert.ok(p.position.y <= 0, "on the ball's side of the note");
});

test("a ball resting on blue still splits and its pieces leave", () => {
  const out = splitBall({ position: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, normal: { x: 0, y: -1 }, radius: 20 });
  close(out.parts[1].velocity.y, -SPLIT_MIN_SPEED);
});

test("a 20px ball splits twice, then the pieces are too small", () => {
  let r = 20, splits = 0;
  while (r >= MIN_SPLIT_RADIUS) { r *= SPLIT_SCALE; splits++; }
  assert.equal(splits, 2);
});
