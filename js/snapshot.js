// Serialise the whole running model — every fly's body, genes and connectome
// activity, the world, predators, robots and statistics — to JSON and back.
// Typed arrays travel as base64; the random generator's state is included so a
// restored swarm continues the same random stream (neural noise aside).
import { Sim, ARENA } from "./sim.js";
import { NavGrid } from "./heuristics.js";
import { GameStats } from "./game.js";

export const SNAPSHOT_VERSION = 1;

// per-fly arrays (structure of arrays) copied straight across
const FLY_ARRAYS = [
  "x", "z", "y", "h", "speed", "vy", "energy", "age", "life", "hp", "hurt", "hawkGene", "gainGene", "intake", "wing",
  "escape", "cooldown", "decide", "oa", "residence", "payoff", "played", "lastHawk", "target", "pathIdx", "swarm",
  "mode", "comp", "degree", "generation", "feeding", "parent", "id",
];
const PLAIN = [
  "n", "t", "tick", "births", "deaths", "nextId", "params", "obstacles", "patches", "predator", "chasers", "theoryX",
  "history", "kmeansCentroids", "modeCounts", "modeNames", "swarms", "social", "astarStats", "events", "reason", "path",
];

export function snapshot(sim, ui = {}) {
  const s = { v: SNAPSHOT_VERSION, N: sim.cx.N, cap: sim.cap, savedAt: Date.now(), ui };
  for (const k of FLY_ARRAYS) s[k] = sim[k];
  for (const k of PLAIN) s[k] = sim[k];
  s.rng = sim.rng.state();
  s.silenced = [...sim.silenced];
  s.stats = { ...sim.stats };
  s.corpses = sim.corpses.map(({ held, ox, oy, oz, ...c }) => c); // bodies being carried are dropped on load
  s.balls = sim.balls.map(({ from, ...b }) => ({ ...b, from: sim.robots.indexOf(from) }));
  s.robots = sim.robots.map(({ held, hitSet, ...R }) => R);
  s.brains = { R: sim.brains.R, gain: sim.brains.gain };
  return s;
}

export function restore(cx, s) {
  if (s.v !== SNAPSHOT_VERSION) throw new Error(`snapshot version ${s.v} is not supported (expected ${SNAPSHOT_VERSION})`);
  if (s.N !== cx.N) throw new Error(`snapshot was made with a ${s.N}-node connectome, this build has ${cx.N}`);
  const sim = new Sim(cx, { flies: s.n, params: s.params });
  for (const k of FLY_ARRAYS) sim[k].set(s[k]);
  for (const k of PLAIN) sim[k] = s[k];
  sim.rng.state(s.rng);
  sim.silenced = new Set(s.silenced);
  sim.stats = Object.assign(new GameStats(), s.stats);
  sim.corpses = s.corpses;
  sim.robots = s.robots.map((R) => ({ ...R, held: [], hitSet: R.state === "sweep" ? new Set() : null }));
  sim.balls = s.balls.map((b) => ({ ...b, from: sim.robots[b.from] ?? sim.robots[0] }));
  sim.brains.R.set(s.brains.R);
  sim.brains.gain.set(s.brains.gain);
  sim.grid = new NavGrid(ARENA, 60, sim.obstacles);
  sim.adj = null; // rebuilt by the next social-graph pass
  return sim;
}

// JSON with typed arrays as { $ta: type, b64 }
export function encode(snap) {
  return JSON.stringify(snap, (k, v) => (ArrayBuffer.isView(v) ? { $ta: v.constructor.name, b64: toB64(v) } : v));
}

export function decode(text) {
  return JSON.parse(text, (k, v) => (v && v.$ta ? fromB64(v.$ta, v.b64) : v));
}

const TYPES = { Float32Array, Float64Array, Int32Array, Int16Array, Int8Array, Uint8Array, Uint16Array, Uint32Array };
function toB64(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromB64(type, b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TYPES[type](bytes.buffer);
}

// gzip when the browser can (CompressionStream), else store the JSON as is
export async function pack(snap) {
  const text = encode(snap);
  if (typeof CompressionStream === "undefined") return new Blob([text], { type: "application/json" });
  const gz = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(gz).arrayBuffer()], { type: "application/gzip" });
}

export async function unpack(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  if (gz && typeof DecompressionStream === "undefined") throw new Error("this browser cannot read gzip snapshots");
  const text = gz ? await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text() : await blob.text();
  return decode(text);
}
