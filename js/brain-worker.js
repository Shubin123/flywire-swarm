// Runs the connectome propagation for every fly off the main thread.
import { propagate } from "./connectome.js";

let cx = null;
onmessage = (e) => {
  const m = e.data;
  if (m.init) {
    cx = m.init;
    return;
  }
  const out = new Float32Array(m.count * cx.N);
  propagate(cx, m.I, m.gains, m.count, m.hops, m.theta, m.noise, m.silenced, out);
  postMessage({ P: out, count: m.count }, [out.buffer]);
};
