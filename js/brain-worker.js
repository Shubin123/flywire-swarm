// Runs the connectome propagation for every fly off the main thread.
// Module workers do not see the page's import map, so the build version in this
// worker's own URL (?v=...) is forwarded to keep connectome.js in step.
const { propagate } = await import(`./connectome.js${self.location.search}`);

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
