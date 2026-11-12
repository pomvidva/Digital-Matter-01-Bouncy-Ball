// The foundation every page builds on: camera + note detection, calibration,
// note bodies, Matter.js world, fixed-timestep physics, tuner panel, draw loop.
//
//   start()                  -> the plain bouncy ball (sandbox)
//   start({ project })       -> the same, plus the project's rules on top
//
// The page links core/core.css and loads opencv.js and matter.min.js (classic
// scripts) before this module. See game.html for the whole page.
//
// A project is an object; every hook is optional:
//   title                    page + panel title
//   help                     HTML for the panel's key list (replaces the sandbox's
//                            "click drop ball · space drop at top" line)
//   setup(core)              once, before the first frame. core = { Matter, engine,
//                            world, canvas, ctx, view, dropBall(x, y, radius?), clearBalls() }
//   resize(w, h)             canvas size changed (also called once after setup)
//   update(now)              every frame, after physics
//   draw(ctx, now)           every frame, after notes and balls are drawn
//   onKey(e)                 return true = handled, core skips its own key action
//   onPointer(e)             left click (not calibration, not shift+drag);
//                            return true = handled, core won't drop a ball
//   keepBallsOnFloor         true = the floor is solid (by default balls fall
//                            through it and are removed off the bottom)
//   onNoteHit(note, ball, speed)   a ball started touching a note body
//                            (note.plugin.color = "pink" | "green" | "blue")
//
// Note colors (rules in note_behaviors.js): pink = wall, green = launch pad,
// blue = splitter that breaks a ball into smaller ones.

import { NoteDetector } from "./note_detector.js";
import { NoteStabilizer } from "./note_stabilizer.js";
import {
  NOTE_COLORS, RESTITUTION, outwardNormal, greenLaunch,
  splitBall, MIN_SPLIT_RADIUS, SPLIT_COOLDOWN_MS,
} from "./note_behaviors.js";
import projects from "../projects.js";

export function start({ project = {} } = {}) {
  if (project.title) document.title = project.title;

  document.body.insertAdjacentHTML("afterbegin", `
    <canvas id="c"></canvas>
    <canvas id="mask"></canvas>

    <div id="panel">
      <h1>${project.title ?? "🎀 Note tuner"}</h1>
      <div id="pages"></div>
      <button id="stream">ball stream: off</button>
      <div id="stat">notes: 0 · balls: 0</div>
      <div id="tunecolors"></div>
      <div class="row"><label>H min</label><input id="hmin" type="range" min="0" max="179" value="140"><span id="hminV">140</span></div>
      <div class="row"><label>H max</label><input id="hmax" type="range" min="0" max="179" value="179"><span id="hmaxV">179</span></div>
      <div class="row h2"><label>H2 min</label><input id="h2min" type="range" min="0" max="179" value="0"><span id="h2minV">0</span></div>
      <div class="row h2"><label>H2 max</label><input id="h2max" type="range" min="0" max="179" value="10"><span id="h2maxV">10</span></div>
      <div class="row"><label>S min</label><input id="smin" type="range" min="0" max="255" value="70"><span id="sminV">70</span></div>
      <div class="row"><label>S max</label><input id="smax" type="range" min="0" max="255" value="255"><span id="smaxV">255</span></div>
      <div class="row"><label>V min</label><input id="vmin" type="range" min="0" max="255" value="70"><span id="vminV">70</span></div>
      <div class="row"><label>V max</label><input id="vmax" type="range" min="0" max="255" value="255"><span id="vmaxV">255</span></div>
      <div class="row"><label>Min</label><input id="minsize" type="range" min="6" max="60" value="20"><span id="minsizeV">20</span></div>
      <div class="keys">
        ${project.help ?? "<b>click</b> drop ball · <b>space</b> drop at top"}<br>
        <b>shift+drag</b> fake note · <b>right-click</b> delete it · <b>n</b> clear fakes<br>
        <b>k</b> fake note color: <span id="fakecolor">pink</span><br>
        <b>m</b> mask view · <b>v</b> feed · <b>o</b> outlines<br>
        <b>p</b> projector mode · <b>h</b> hide panel<br>
        <b>c</b> calibrate · <b>shift+c</b> cancel (or reset saved)<br>
        <b>w</b> switch camera · <b>e</b> lock exposure<br>
        <b>l</b> lock notes (walls stop changing)<br>
        <b>b</b> ball stream · <b>shift+b</b> move it to the mouse<br>
        <b>x</b> clear balls · <b>f</b> fullscreen
      </div>
    </div>
  `);

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const maskCanvas = document.getElementById("mask");
  const stat = document.getElementById("stat");

  const panel = document.getElementById("panel");

  const view = { showFeed: true, showMask: false, mirror: true, projector: false, outlines: true, panel: true };

  // ---------- links to the other pages ----------
  // /game, /game.html and /index.html all count as "this page"
  const pageKey = (u) => new URL(u, location.href).pathname.replace(/(index)?(\.html)?$/, "");
  const root = new URL("../", import.meta.url);
  for (const p of projects) {
    const a = document.createElement("a");
    a.href = new URL(p.path, root);
    a.textContent = p.name;
    if (pageKey(a.href) === pageKey(location.href)) a.className = "here";
    document.getElementById("pages").append(a);
  }

  // ---------- calibration hooks (B6) ----------
  // calibration.js is Person A's. Loaded optionally so this page works without it.
  // API: start(video, camW, camH), draw(ctx), handleClick/handleMove(x, y), handleKey(key),
  //      active, camToProj(p, w, h), isCalibrated, clear()
  let calibration = null;
  let calibrating = false;
  import("./calibration.js")
    .then((m) => { calibration = new m.Calibration(); })
    .catch(() => { /* not written yet */ });

  // ---------- Matter.js world ----------
  const { Engine, Bodies, Body, Composite } = Matter;
  const engine = Engine.create();
  engine.gravity.y = 2; // canvas is large in px, so 1 felt floaty
  const world = engine.world;

  let walls = [];
  let noteBodies = [];

  function rebuildWalls() {
    Composite.remove(world, walls);
    const w = canvas.width, h = canvas.height, t = 200;
    walls = [
      Bodies.rectangle(w / 2, -t / 2, w * 2, t, { isStatic: true }),          // top (open-ish, high up)
      // floor: a sensor (balls fall through) unless the project needs to land on it
      Bodies.rectangle(w / 2, h + t / 2, w * 2, t, { isStatic: true, restitution: 0.7, isSensor: !project.keepBallsOnFloor }),
      Bodies.rectangle(-t / 2, h / 2, t, h * 2, { isStatic: true, restitution: 0.7 }),     // left
      Bodies.rectangle(w + t / 2, h / 2, t, h * 2, { isStatic: true, restitution: 0.7 }),  // right
    ];
    Composite.add(world, walls);
    project.resize?.(w, h);
  }

  function dropBall(x, y, radius = 20) {
    const ball = Bodies.circle(x, y, radius, {
      restitution: 0.8, friction: 0.02, frictionAir: 0.002, density: 0.001,
      render: {}, label: "ball",
    });
    Composite.add(world, ball);   // no sideways push: it falls straight down
    // cap total balls: the oldest fades out (see fadeBalls) instead of vanishing
    const balls = Composite.allBodies(world).filter(b => b.label === "ball" && !b.plugin.fadeAt);
    if (balls.length > MAX_BALLS) balls[0].plugin.fadeAt = performance.now();
    return ball;
  }

  function clearBalls() {
    Composite.remove(world, Composite.allBodies(world).filter(b => b.label === "ball"));
  }

  const MAX_BALLS = 80;   // blue splits one ball into up to 9
  const FADE_MS = 600;
  // remove faded balls; returns a ball's opacity for drawing
  function fadeBalls(now) {
    const below = canvas.height + 100;   // fell through the floor, out of sight
    const gone = Composite.allBodies(world).filter(b => b.label === "ball" &&
      ((b.plugin.fadeAt && now - b.plugin.fadeAt > FADE_MS) || b.position.y > below));
    if (gone.length) Composite.remove(world, gone);
  }
  const ballAlpha = (b, now) => b.plugin.fadeAt ? Math.max(0, 1 - (now - b.plugin.fadeAt) / FADE_MS) : 1;

  // ---------- ball stream: one ball at a time from the same spot ----------
  const STREAM_MS = 600;   // time between balls: calm, not a waterfall
  const stream = { on: false, x: null, last: 0 };   // x null = top center
  let mouseX = null;
  const streamButton = document.getElementById("stream");
  function setStream(on) {
    stream.on = on;
    streamButton.textContent = `ball stream: ${on ? "on" : "off"}`;
    streamButton.classList.toggle("here", on);
  }
  function runStream(now) {
    if (!stream.on || now - stream.last < STREAM_MS) return;
    stream.last = now;
    // a hair of randomness so balls don't stack in a perfect column
    dropBall((stream.x ?? canvas.width / 2) + (Math.random() - 0.5) * 2, 30);
  }
  streamButton.addEventListener("click", () => {
    setStream(!stream.on);
    streamButton.blur();   // else space (drop ball) would press the button again
  });

  // ball <-> note contacts: green notes queue a launch, blue a split, and projects hear about
  // every contact (sounds, glow, scoring...)
  Matter.Events.on(engine, "collisionStart", (e) => {
    for (const { bodyA: a, bodyB: b } of e.pairs) {
      const note = a.label === "note" ? a : b.label === "note" ? b : null;
      const ball = a.label === "ball" ? a : b.label === "ball" ? b : null;
      if (!note || !ball) continue;
      if (note.plugin.color === "green") launchQueue.push({ ball, pad: note });
      if (note.plugin.color === "blue") splitQueue.set(ball, note);
      project.onNoteHit?.(note, ball, ball.speed);
    }
  });

  // Shoot queued balls off their green note (after the step, never inside the
  // collision event: changing a body mid-solve confuses Matter), and
  // leave a ring where it happened so the launch is easy to see.
  const launchQueue = [];   // { ball, pad }
  const RING_MS = 450;
  let rings = [];           // { x, y, t0, color }: launch / split flashes
  function runLaunches() {
    for (const { ball, pad } of launchQueue.splice(0)) {
      const normal = outwardNormal(pad.vertices, ball.position);
      Body.setVelocity(ball, greenLaunch({ vel: ball.velocity, normal }));
      rings.push({ x: ball.position.x, y: ball.position.y, t0: performance.now(), color: SWATCH.green });
    }
  }
  function drawRings(now) {
    rings = rings.filter((r) => now - r.t0 < RING_MS);
    ctx.save(); ctx.lineWidth = 3;
    for (const r of rings) {
      const k = (now - r.t0) / RING_MS;
      // white in projector mode: projected green/blue would be detected as a note
      ctx.strokeStyle = view.projector ? "#fff" : r.color;
      ctx.globalAlpha = 1 - k;
      ctx.beginPath(); ctx.arc(r.x, r.y, 20 + 40 * k, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  // Blue splitters: a ball that hits one shrinks and two more pieces fly off
  // beside it (the original body stays, so projects keep tracking it). Pieces
  // too small, or fresh from a split, just bounce.
  const splitQueue = new Map();   // ball -> blue note, one entry per ball per step
  function runSplits() {
    if (!splitQueue.size) return;
    const now = engine.timing.timestamp;
    for (const [ball, note] of splitQueue) {
      if (ball.circleRadius < MIN_SPLIT_RADIUS || now < (ball.plugin.splitUntil ?? 0)) continue;
      const out = splitBall({
        position: ball.position, vel: ball.velocity, radius: ball.circleRadius,
        normal: outwardNormal(note.vertices, ball.position),
      });
      rings.push({ x: ball.position.x, y: ball.position.y, t0: performance.now(), color: SWATCH.blue });
      const [middle, ...others] = out.parts;
      Body.scale(ball, out.radius / ball.circleRadius, out.radius / ball.circleRadius);
      Body.setPosition(ball, middle.position);
      Body.setVelocity(ball, middle.velocity);
      ball.plugin.splitUntil = now + SPLIT_COOLDOWN_MS;
      for (const part of others) {
        const piece = dropBall(part.position.x, part.position.y, out.radius);
        Body.setVelocity(piece, part.velocity);
        piece.plugin.splitUntil = now + SPLIT_COOLDOWN_MS;
      }
    }
    splitQueue.clear();
  }

  // ---------- camera->canvas mapping (contain + optional mirror) ----------
  let layout = { s: 1, ox: 0, oy: 0, camW: 1, camH: 1 };
  function computeLayout(camW, camH) {
    const s = Math.min(canvas.width / camW, canvas.height / camH);
    layout = { s, ox: (canvas.width - camW * s) / 2, oy: (canvas.height - camH * s) / 2, camW, camH };
  }
  const mapX = (x) => view.mirror ? layout.ox + (layout.camW - x) * layout.s : layout.ox + x * layout.s;
  const mapY = (y) => layout.oy + y * layout.s;

  // ---------- note tracking ----------
  // Detected notes go through NoteStabilizer: each wall keeps its exact shape
  // until the note really moves, so a ball dropped from the same spot always
  // takes the same path. A wall body is rebuilt only when its shape's version
  // changes. Fake notes are exact already and skip the stabilizer.
  const stabilizer = new NoteStabilizer();
  const noteWalls = new Map(); // stabilizer track id -> { version, body }
  let fakeBodies = [];
  let rawNotes = [];           // this detection's notes, unfiltered (drawn thin with `o`)
  let lastDetection = null;    // detector.notes is a new array per detection
  let lastCal;                 // calibration.H the walls were made with

  // convex polygon (screen px) -> static Matter body with exactly that shape.
  function polyBody(poly, color = "pink") {
    const vertices = Matter.Vertices.clockwiseSort(poly.map((p) => ({ x: p.x, y: p.y })));
    const body = Body.create({
      position: Matter.Vertices.centre(vertices), vertices,
      isStatic: true, label: "note",
      plugin: { color },
    });
    // after create: isStatic resets restitution to 0 (see note_behaviors.js)
    if (RESTITUTION[color] != null) body.restitution = RESTITUTION[color];
    return body;
  }

  // ---------- notes in screen px (the A -> B contract) ----------
  // A note is { corners: [{x,y} x4], center: {x,y}, outline?: [{x,y}...] }
  // in screen/projector pixels. `outline` is the convex shape when the detector has it.

  // camera px -> screen px: calibrated homography if available, else fit + mirror
  function camToScreen(p) {
    if (calibration?.isCalibrated) return calibration.camToProj(p, canvas.width, canvas.height);
    return { x: mapX(p.x), y: mapY(p.y) };
  }

  // detector note (camera px) -> contract note. Uses n.corners if the detector
  // provides them (A2), otherwise rebuilds them from center/size/angle.
  function toScreenNote(n) {
    let cam = n.corners;
    if (!cam) {
      const a = n.angle * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      const hw = n.size.width / 2, hh = n.size.height / 2;
      cam = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => (
        { x: n.center.x + x * cos - y * sin, y: n.center.y + x * sin + y * cos }));
    }
    const note = { corners: cam.map(camToScreen), center: camToScreen(n.center), color: n.color };
    if (n.outline) note.outline = n.outline.map(camToScreen);
    return note;
  }

  // ---------- fake notes (B1): shift+drag a line, it becomes a note along that line ----------
  const FAKE_THICKNESS = 40;
  let fakeNotes = [];
  let drag = null;   // { x0, y0, x1, y1 } while shift-dragging
  let fakeColor = "pink";   // `k` cycles it; new fake notes get this color

  function makeFakeNote(x0, y0, x1, y1, color) {
    const len = Math.max(30, Math.hypot(x1 - x0, y1 - y0));
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hl = len / 2, ht = FAKE_THICKNESS / 2;
    return {
      color,
      center: { x: cx, y: cy },
      corners: [[-hl, -ht], [hl, -ht], [hl, ht], [-hl, ht]].map(([l, t]) => (
        { x: cx + ux * l + vx * t, y: cy + uy * l + vy * t })),
    };
  }

  let fakesDirty = true;

  // runs every frame; does work only on a new detection, a calibration change,
  // or a fake-note edit
  function syncNoteBodies() {
    let changed = false;
    const cal = calibration?.isCalibrated ? calibration.H : null;
    if (cal !== lastCal) { stabilizer.clear(); lastCal = cal; lastDetection = null; }

    if (detector.notes !== lastDetection) {
      lastDetection = detector.notes;
      rawNotes = (detector.notes || []).map(toScreenNote);
      const seen = new Set();
      for (const n of stabilizer.update(rawNotes)) {
        seen.add(n.id);
        const wall = noteWalls.get(n.id);
        if (wall?.version === n.version) continue;   // same shape: leave the body alone
        if (wall) Composite.remove(world, wall.body);
        const body = polyBody(n.poly, n.color);
        Composite.add(world, body);
        noteWalls.set(n.id, { version: n.version, body });
        changed = true;
      }
      for (const [id, wall] of noteWalls) {
        if (seen.has(id)) continue;
        Composite.remove(world, wall.body);
        noteWalls.delete(id);
        changed = true;
      }
    }

    if (fakesDirty) {
      fakesDirty = false;
      Composite.remove(world, fakeBodies);
      fakeBodies = fakeNotes.map((n) => polyBody(n.corners, n.color));
      Composite.add(world, fakeBodies);
      changed = true;
    }

    if (changed) noteBodies = [...[...noteWalls.values()].map((w) => w.body), ...fakeBodies];
  }

  // ---------- detector ----------
  // "auto" picks an external webcam over the laptop's own; `w` cycles and remembers
  const CAMERA_KEY = "bouncy.camera";
  let savedCamera = "auto";
  try { savedCamera = localStorage.getItem(CAMERA_KEY) || "auto"; } catch { /* storage blocked */ }
  const detector = new NoteDetector({
    camera: savedCamera,
    debugCanvas: maskCanvas,
  });

  // ---------- tuner wiring ----------
  // One set of sliders; the color tabs pick which note color they edit (and
  // which color the `m` mask view shows). Saved per site, so every page shares
  // the same color settings.
  const ids = ["hmin","hmax","h2min","h2max","smin","smax","vmin","vmax"];
  const TUNER_KEY = "bouncy.tuner.v2";   // { pink: {lower, upper, hue2}, green: ..., blue: ... }
  const OLD_TUNER_KEY = "bouncy.tuner";  // pink-only slider values from before colors
  const SWATCH = { pink: "#ff7fbf", green: "#7cf29a", blue: "#00e5ff" };
  let tuneColor = "pink";

  const tabs = document.getElementById("tunecolors");
  for (const c of NOTE_COLORS) {
    const b = document.createElement("button");
    b.textContent = c;
    b.dataset.color = c;
    b.style.setProperty("--swatch", SWATCH[c]);
    b.addEventListener("click", () => { tuneColor = c; showTuner(); });
    tabs.append(b);
  }

  // detector -> sliders, for the selected color
  function showTuner() {
    const { lower, upper, hue2 } = detector.colors[tuneColor];
    const v = { hmin: lower[0], smin: lower[1], vmin: lower[2],
                hmax: upper[0], smax: upper[1], vmax: upper[2],
                h2min: hue2?.[0] ?? 0, h2max: hue2?.[1] ?? 0 };
    for (const id of ids) {
      document.getElementById(id).value = v[id];
      document.getElementById(id + "V").textContent = v[id];
    }
    // only pink wraps past 179, so only pink has the second hue window
    for (const row of panel.querySelectorAll(".row.h2")) row.style.display = hue2 ? "" : "none";
    for (const b of tabs.children) b.classList.toggle("here", b.dataset.color === tuneColor);
    detector.debugColor = tuneColor;
  }
  // sliders -> detector, for the selected color
  function readTuner() {
    const g = (id) => +document.getElementById(id).value;
    const c = detector.colors[tuneColor];
    c.lower = [g("hmin"), g("smin"), g("vmin")];
    c.upper = [g("hmax"), g("smax"), g("vmax")];
    if (c.hue2) c.hue2 = [g("h2min"), g("h2max")];
  }
  function saveTuner() {
    try { localStorage.setItem(TUNER_KEY, JSON.stringify(detector.colors)); }
    catch { /* storage blocked: sliders just won't persist */ }
  }
  function loadTuner() {
    const isHsv = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    try {
      const saved = JSON.parse(localStorage.getItem(TUNER_KEY) || "null");
      if (saved) {
        for (const c of NOTE_COLORS) {
          const s = saved[c];
          if (!s || !isHsv(s.lower) || !isHsv(s.upper)) continue;
          detector.colors[c] = { lower: s.lower, upper: s.upper, hue2: s.hue2 ?? null };
        }
        return;
      }
      // first run after the color update: keep the pink the user already tuned
      const old = JSON.parse(localStorage.getItem(OLD_TUNER_KEY) || "{}");
      if (old.hmin === undefined) return;
      const n = (id) => +old[id];
      const pink = { lower: [n("hmin"), n("smin"), n("vmin")], upper: [n("hmax"), n("smax"), n("vmax")],
                     hue2: [n("h2min"), n("h2max")] };
      if (isHsv(pink.lower) && isHsv(pink.upper)) detector.colors.pink = pink;
    } catch { /* ignore corrupt/blocked storage */ }
  }
  ids.forEach((id) => {
    const el = document.getElementById(id);
    const out = document.getElementById(id + "V");
    el.addEventListener("input", () => { out.textContent = el.value; readTuner(); saveTuner(); });
  });
  loadTuner();
  showTuner();

  // Min slider: smallest note kept, as the side of a square in camera px (all
  // colors). Lower it if single notes are missed; raise it if specks show up.
  const MIN_SIZE_KEY = "bouncy.minsize";
  const minSize = document.getElementById("minsize");
  const minSizeOut = document.getElementById("minsizeV");
  function readMinSize() {
    minSizeOut.textContent = minSize.value;
    detector.minArea = minSize.value ** 2;
  }
  try { const v = localStorage.getItem(MIN_SIZE_KEY); if (v) minSize.value = v; } catch { /* storage blocked */ }
  readMinSize();
  minSize.addEventListener("input", () => {
    readMinSize();
    try { localStorage.setItem(MIN_SIZE_KEY, minSize.value); } catch { /* storage blocked */ }
  });

  // ---------- fixed-timestep physics ----------
  // Step by real elapsed time so speed doesn't depend on display refresh rate or
  // on frames lost to OpenCV; small steps keep fast balls from tunnelling.
  const STEP_MS = 1000 / 120, MAX_STEPS = 8, MAX_SPEED = 25; // MAX_SPEED: px per step
  let lastT = 0, acc = 0;
  function stepPhysics(now) {
    acc += Math.min(now - (lastT || now), STEP_MS * MAX_STEPS);
    lastT = now;
    const balls = Composite.allBodies(world).filter(b => b.label === "ball");
    while (acc >= STEP_MS) {
      Engine.update(engine, STEP_MS);
      runLaunches();
      runSplits();
      for (const b of balls) {
        const sp = Math.hypot(b.velocity.x, b.velocity.y);
        if (sp > MAX_SPEED) Body.setVelocity(b, { x: b.velocity.x * MAX_SPEED / sp, y: b.velocity.y * MAX_SPEED / sp });
      }
      acc -= STEP_MS;
    }
  }

  let flash = "";   // one-off message shown under the stats (errors, missing calibration.js)
  const perf = { frames: 0, detects: 0, t0: performance.now(), lastNotes: null, text: "" };

  // ---------- draw loop ----------
  function frame() {
    if (canvas.width !== innerWidth || canvas.height !== innerHeight) {
      canvas.width = innerWidth; canvas.height = innerHeight;
      maskCanvas.width = innerWidth; maskCanvas.height = innerHeight;
      rebuildWalls();
    }
    if (detector.width) computeLayout(detector.width, detector.height);
    syncNoteBodies();

    runStream(performance.now());
    stepPhysics(performance.now());
    fadeBalls(performance.now());
    project.update?.(performance.now());

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (view.projector) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height); }

    // background: camera feed or mask (never in projector mode: the camera must not
    // see its own picture projected back on the wall)
    if (view.projector) {
      // black
    } else if (view.showMask) {
      ctx.save(); ctx.globalAlpha = 0.9;
      drawContain(maskCanvas);
      ctx.restore();
    } else if (view.showFeed && detector.video && detector.video.readyState >= 2) {
      ctx.save(); ctx.globalAlpha = 0.4;
      drawContain(detector.video);
      ctx.restore();
    }

    // note collision boxes, in the note's color on the screen but plain white in
    // projector mode: projected pink/green/cyan would be detected as a note by
    // the camera, and that fake note would never go away. Splitters are dashed.
    if (view.outlines) {
      // thin grey: what the camera sees this instant; thick: the locked wall.
      // Hidden in projector mode so the camera never sees it.
      if (!view.projector) {
        ctx.lineWidth = 1; ctx.strokeStyle = "#8a96a3";
        for (const n of rawNotes) drawPoly(n.outline ?? n.corners);
      }
      ctx.save(); ctx.lineWidth = 3;
      for (const b of noteBodies) {
        ctx.strokeStyle = view.projector ? "#fff" : SWATCH[b.plugin.color] ?? "#fff";
        ctx.setLineDash(b.plugin.color === "blue" ? [10, 6] : []);
        drawBody(b);
      }
      ctx.restore();
    }

    // fake note being dragged
    if (drag) {
      ctx.save(); ctx.setLineDash([8, 8]); ctx.lineWidth = 2;
      ctx.strokeStyle = view.projector ? "#fff" : SWATCH[fakeColor];
      ctx.beginPath(); ctx.moveTo(drag.x0, drag.y0); ctx.lineTo(drag.x1, drag.y1); ctx.stroke();
      ctx.restore();
    }

    // balls
    const tBalls = performance.now();
    for (const b of Composite.allBodies(world)) {
      if (b.label !== "ball") continue;
      ctx.globalAlpha = ballAlpha(b, tBalls);
      ctx.beginPath();
      ctx.arc(b.position.x, b.position.y, b.circleRadius, 0, Math.PI * 2);
      ctx.fillStyle = "#fff"; ctx.fill();
    }
    ctx.globalAlpha = 1;
    drawRings(tBalls);

    if (project.draw) { ctx.save(); project.draw(ctx, performance.now()); ctx.restore(); }

    const nBalls = Composite.allBodies(world).filter(b => b.label === "ball").length;
    // fps counters, refreshed once a second
    perf.frames++;
    if (detector.notes !== perf.lastNotes) { perf.detects++; perf.lastNotes = detector.notes; }
    const t = performance.now();
    if (t - perf.t0 >= 1000) {
      perf.text = `draw ${perf.frames} fps · detect ${perf.detects} fps`;
      perf.frames = perf.detects = 0; perf.t0 = t;
    }
    const notesInfo = stabilizer.locked ? "🔒 notes locked" : `jitter ${stabilizer.jitter.toFixed(1)}px`;
    stat.textContent = `notes: ${noteBodies.length} · ${notesInfo} · balls: ${nBalls} · ${perf.text}` +
      (flash ? `\n${flash}` : "");

    if (calibrating && calibration) calibration.draw(ctx);

    requestAnimationFrame(frame);
  }

  function drawContain(src) {
    ctx.save();
    if (view.mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    const dx = view.mirror ? canvas.width - layout.ox - layout.camW * layout.s : layout.ox;
    ctx.drawImage(src, dx, layout.oy, layout.camW * layout.s, layout.camH * layout.s);
    ctx.restore();
  }

  function drawBody(b) { drawPoly(b.vertices); }

  function drawPoly(v) {
    ctx.beginPath();
    ctx.moveTo(v[0].x, v[0].y);
    for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y);
    ctx.closePath();
    ctx.stroke();
  }

  // ---------- input ----------
  // projector mode hides the panel and cursor; `h` can still toggle the panel after
  function applyUI() {
    // the panel would cover calibration dot 1, so it hides while calibrating
    panel.style.display = view.panel && !calibrating ? "" : "none";
    canvas.style.cursor = view.projector && !calibrating ? "none" : "";
  }

  // calibration finishes itself after the 4th valid click, or on Esc
  function syncCalibrating() {
    if (calibrating && !calibration.active) { calibrating = false; applyUI(); }
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (calibrating && calibration) {            // clicks belong to calibration while it runs
      calibration.handleClick(e.clientX, e.clientY);
      syncCalibrating();
    } else if (e.shiftKey) {                     // B1: start a fake note
      drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    } else if (!project.onPointer?.(e)) {
      dropBall(e.clientX, e.clientY);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    mouseX = e.clientX;
    if (calibrating && calibration) calibration.handleMove(e.clientX, e.clientY);   // zoom loupe
    if (drag) { drag.x1 = e.clientX; drag.y1 = e.clientY; }
  });
  canvas.addEventListener("pointerup", () => {
    if (!drag) return;
    if (Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 10) {
      fakeNotes.push(makeFakeNote(drag.x0, drag.y0, drag.x1, drag.y1, fakeColor));
      fakesDirty = true;
    }
    drag = null;
  });
  // right-click on a fake note deletes it
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const p = { x: e.clientX, y: e.clientY };
    const hit = fakeNotes.findIndex((n) => Matter.Vertices.contains(n.corners, p));
    if (hit >= 0) { fakeNotes.splice(hit, 1); fakesDirty = true; }
  });

  addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (calibrating && calibration) {            // Backspace = undo, Esc = cancel (A handles the details)
      e.preventDefault();
      if (e.key === "C") calibration.cancel();   // shift+c = cancel, same as Esc
      else calibration.handleKey(e.key);
      syncCalibrating();
      return;
    }
    if (project.onKey?.(e)) { e.preventDefault(); return; }
    if (k === " ") { e.preventDefault(); dropBall(canvas.width / 2 + (Math.random() - 0.5) * 300, 40); }
    else if (k === "m") view.showMask = !view.showMask;
    else if (k === "v") view.showFeed = !view.showFeed;
    else if (k === "o") view.outlines = !view.outlines;
    else if (k === "h") { view.panel = !view.panel; applyUI(); }
    else if (k === "p") { view.projector = !view.projector; view.panel = !view.projector; applyUI(); }
    else if (k === "n") { fakeNotes = []; fakesDirty = true; }
    else if (k === "k") {
      fakeColor = NOTE_COLORS[(NOTE_COLORS.indexOf(fakeColor) + 1) % NOTE_COLORS.length];
      document.getElementById("fakecolor").textContent = fakeColor;
    }
    else if (k === "l") {
      stabilizer.locked = !stabilizer.locked;
      flash = stabilizer.locked ? "notes locked: walls won't change (l to unlock)" : "notes follow the camera again";
    }
    else if (e.key === "C") { calibration?.clear(); flash = "calibration cleared"; }
    else if (k === "c") {
      if (!calibration) flash = "calibration.js failed to load";
      else if (!detector.video) flash = "camera not running yet, can't calibrate";
      else {
        calibration.start(detector.video, detector.width, detector.height);
        calibrating = true; flash = ""; applyUI();
      }
    }
    else if (k === "w") switchCamera();
    else if (k === "e") toggleCameraLock();
    else if (e.key === "B") {
      stream.x = mouseX;   // null (mouse not over the canvas yet) = top center
      setStream(true);
    }
    else if (k === "b") setStream(!stream.on);
    else if (k === "x") clearBalls();
    else if (k === "f") document.documentElement.requestFullscreen?.();
  });

  // e: freeze the camera's auto exposure / white balance at the current look
  // Locking often drops to a very short exposure, so an Exp slider appears while
  // locked; the last value is remembered and reused on the next lock.
  const EXPOSURE_KEY = "bouncy.exposure";
  let cameraLocked = false;
  let expRow = null;
  function showExposureSlider(exp) {
    expRow?.remove(); expRow = null;
    if (!exp) return;
    expRow = document.createElement("div");
    expRow.className = "row";
    expRow.innerHTML = `<label>Exp</label><input type="range" min="${exp.min}" max="${exp.max}" step="${exp.step}" value="${exp.value}"><span>${Math.round(exp.value)}</span>`;
    const input = expRow.querySelector("input"), out = expRow.querySelector("span");
    input.addEventListener("input", async () => {
      out.textContent = Math.round(+input.value);
      try {
        await detector.setExposure(+input.value);
        localStorage.setItem(EXPOSURE_KEY, input.value);
      } catch (err) { flash = "exposure: " + err.message; }
    });
    stat.after(expRow);
  }
  async function toggleCameraLock() {
    if (!detector.stream) { flash = "camera not running"; return; }
    const want = !cameraLocked;
    let saved;
    try { saved = localStorage.getItem(EXPOSURE_KEY); } catch { /* storage blocked */ }
    const { locked, unsupported, exposure } = await detector.lockCamera(want,
      { exposureTime: saved ? +saved : undefined });
    if (locked.length) cameraLocked = want;
    showExposureSlider(cameraLocked ? exposure : null);
    flash = locked.length
      ? `${want ? "🔒 locked" : "🔓 auto"}: ${locked.join(", ")}` +
        (unsupported.length ? ` · camera can't: ${unsupported.join(", ")}` : "")
      : `this camera can't lock: ${unsupported.join(", ")}`;
  }

  // next video input; the choice is saved so every page opens the same camera
  let switching = false;
  async function switchCamera() {
    if (switching) return;
    switching = true;
    try {
      const cams = await NoteDetector.listCameras();
      if (cams.length < 2) { flash = `only one camera found: ${detector.cameraLabel || "?"}`; return; }
      const i = cams.findIndex((c) => c.deviceId === detector.cameraId);
      const next = cams[(i + 1) % cams.length];
      flash = "switching camera…";
      detector.stop();
      detector.camera = next.deviceId;
      await detector.start();
      cameraLocked = false;   // a fresh stream starts on auto again
      showExposureSlider(null);
      try { localStorage.setItem(CAMERA_KEY, next.deviceId); } catch { /* storage blocked */ }
      flash = `camera: ${detector.cameraLabel} (press c to recalibrate)`;
    } catch (err) {
      flash = "camera switch failed: " + err.message;
    } finally {
      switching = false;
    }
  }

  // ---------- boot ----------
  function whenCvReady() {
    return new Promise((resolve) => {
      if (globalThis.cv && cv.Mat) return resolve();
      cv["onRuntimeInitialized"] = resolve;
    });
  }

  (async () => {
    canvas.width = innerWidth; canvas.height = innerHeight;
    maskCanvas.width = innerWidth; maskCanvas.height = innerHeight;
    project.setup?.({ Matter, engine, world, canvas, ctx, view, dropBall, clearBalls });
    rebuildWalls();
    stat.textContent = "loading OpenCV…";
    await whenCvReady();
    stat.textContent = "starting camera… allow webcam";
    try {
      try {
        await detector.start();
      } catch (err) {
        // the saved camera was unplugged: fall back to auto
        if (detector.camera === "auto") throw err;
        detector.stop();
        detector.camera = "auto";
        await detector.start();
      }
      flash = `camera: ${detector.cameraLabel}`;
      // An Exp value was saved last time: lock the camera again once its auto
      // white balance / focus have settled, so `e` isn't needed after every reload.
      let savedExp = null;
      try { savedExp = localStorage.getItem(EXPOSURE_KEY); } catch { /* storage blocked */ }
      if (savedExp) setTimeout(() => { if (!cameraLocked) toggleCameraLock(); }, 3000);
    } catch (err) {
      // no camera: keep going so fake notes (shift+drag) still work
      flash = "no camera: " + err.message;
    }
    requestAnimationFrame(frame);
  })();
}
