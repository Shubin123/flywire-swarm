// The "Save" panel: keep snapshots of the running model in this browser
// (IndexedDB), load them back, export/import them as files, and show how much
// browser storage the project is using.
import { snapshot, pack, unpack } from "./snapshot.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DB = "flywire-swarm", STORE = "snapshots", LS_PREFIX = "flywire-swarm:";
const AUTOSAVE_MS = 60_000;

export function bytes(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  const u = ["B", "KB", "MB", "GB"];
  let k = 0;
  while (n >= 1024 && k < u.length - 1) (n /= 1024), k++;
  return `${n.toFixed(k && n < 10 ? 1 : 0)} ${u[k]}`;
}

function openDb() {
  return new Promise((ok, fail) => {
    if (typeof indexedDB === "undefined") return fail(new Error("IndexedDB is not available"));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
function tx(db, mode, fn) {
  return new Promise((ok, fail) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => ok(req?.result);
    t.onerror = t.onabort = () => fail(t.error);
  });
}
const lsGet = (k) => {
  try {
    return localStorage.getItem(LS_PREFIX + k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(LS_PREFIX + k, v);
  } catch {}
};

export class ModelStore {
  // getSim() -> current Sim; getUi() -> UI state to save; onLoad(snapshot) swaps it in
  constructor({ getSim, getUi, onLoad }) {
    Object.assign(this, { getSim, getUi, onLoad });
    this.db = null;
    this.list = [];
    this.busy = false;
    this.lastAuto = 0;
    $("#save-name").placeholder = `swarm ${new Date().toLocaleDateString()}`;
    $("#btn-save").addEventListener("click", () => this.save($("#save-name").value.trim() || null));
    $("#btn-export").addEventListener("click", () => this.exportCurrent());
    $("#file-import").addEventListener("change", (e) => this.importFile(e.target.files[0]).finally(() => (e.target.value = "")));
    $("#btn-persist").addEventListener("click", () => this.persist());
    $("#btn-clear-saves").addEventListener("click", () => this.clearAll());
    const auto = $("#c-autosave");
    auto.checked = lsGet("autosave") === "1";
    auto.addEventListener("change", () => lsSet("autosave", auto.checked ? "1" : "0"));
    $("#saves").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (b) this[b.dataset.act](b.dataset.id);
    });
    openDb()
      .then((db) => ((this.db = db), this.refresh()))
      .catch((err) => this.status(`Saving in this browser is unavailable: ${err.message}. Export to a file still works.`, true));
    setInterval(() => this.tick(), 5000);
  }

  status(msg, bad = false) {
    const el = $("#save-status");
    el.textContent = msg;
    el.classList.toggle("bad", bad);
  }

  async save(name, id = null) {
    if (!this.db || this.busy) return;
    this.busy = true;
    try {
      const sim = this.getSim();
      const blob = await pack(snapshot(sim, this.getUi()));
      const rec = {
        id: id || `s${Date.now()}`, name: name || `swarm ${new Date().toLocaleString()}`, created: Date.now(), size: blob.size, blob,
        meta: { t: sim.t, n: sim.n, game: sim.params.game, births: sim.births, hawk: sim.meanHawk() },
      };
      await tx(this.db, "readwrite", (s) => s.put(rec));
      this.status(`Saved “${rec.name}” (${bytes(blob.size)}).`);
      $("#save-name").value = "";
      await this.refresh();
    } catch (err) {
      this.status(err.name === "QuotaExceededError" ? "The browser's storage quota is full — delete a save or export to a file." : `Save failed: ${err.message}`, true);
    } finally {
      this.busy = false;
    }
  }

  async load(id) {
    const rec = await tx(this.db, "readonly", (s) => s.get(id));
    if (!rec) return;
    try {
      this.onLoad(await unpack(rec.blob));
      this.status(`Loaded “${rec.name}”.`);
    } catch (err) {
      this.status(`Could not load: ${err.message}`, true);
    }
  }

  async download(id) {
    const rec = await tx(this.db, "readonly", (s) => s.get(id));
    if (rec) saveFile(rec.blob, rec.name);
  }

  async remove(id) {
    await tx(this.db, "readwrite", (s) => s.delete(id));
    await this.refresh();
  }

  async clearAll() {
    if (!this.db || !this.list.length || !confirm(`Delete all ${this.list.length} saved models from this browser?`)) return;
    await tx(this.db, "readwrite", (s) => s.clear());
    this.status("All saved models deleted.");
    await this.refresh();
  }

  async exportCurrent() {
    saveFile(await pack(snapshot(this.getSim(), this.getUi())), `flywire-swarm t${Math.round(this.getSim().t)}s`);
  }

  async importFile(file) {
    if (!file) return;
    try {
      const snap = await unpack(file);
      this.onLoad(snap);
      this.status(`Loaded ${file.name}.`);
      if (this.db) await this.save(file.name.replace(/\.json(\.gz)?$/, ""));
    } catch (err) {
      this.status(`Could not read ${file.name}: ${err.message}`, true);
    }
  }

  async persist() {
    const ok = await navigator.storage?.persist?.();
    this.status(ok ? "Storage is persistent: the browser will not evict saved models when space runs low." : "The browser declined persistent storage (it may grant it after more visits or a bookmark).", !ok);
    this.usage();
  }

  tick() {
    if ($("#c-autosave").checked && Date.now() - this.lastAuto > AUTOSAVE_MS) {
      this.lastAuto = Date.now();
      this.save("autosave", "autosave");
    }
    if ($("#tab-save").classList.contains("on")) this.usage();
  }

  async refresh() {
    if (!this.db) return;
    const all = await tx(this.db, "readonly", (s) => s.getAll());
    this.list = all.map(({ blob, ...r }) => r).sort((a, b) => b.created - a.created);
    $("#saves").innerHTML = this.list.length
      ? this.list.map((r) => `<div class="save-row">
          <div><b>${esc(r.name)}</b><small>${new Date(r.created).toLocaleString()} · t = ${Math.round(r.meta.t)} s · ${r.meta.n} flies · ${esc(r.meta.game)} · ${bytes(r.size)}</small></div>
          <div class="save-acts"><button class="btn small" data-act="load" data-id="${r.id}">Load</button><button class="btn small ghost" data-act="download" data-id="${r.id}" title="Download">⤓</button><button class="btn small ghost" data-act="remove" data-id="${r.id}" title="Delete">✕</button></div>
        </div>`).join("")
      : `<p class="note">No saved models yet.</p>`;
    this.usage();
  }

  // origin storage from the Storage API, and this project's own share of it
  async usage() {
    const mine = this.list.reduce((s, r) => s + r.size, 0);
    let ls = 0;
    try {
      for (let k = 0; k < localStorage.length; k++) {
        const key = localStorage.key(k);
        if (key.startsWith(LS_PREFIX)) ls += 2 * (key.length + (localStorage.getItem(key) || "").length); // UTF-16
      }
    } catch {}
    let est = {};
    try {
      est = (await navigator.storage?.estimate?.()) || {};
    } catch {}
    let cacheNames = [];
    try {
      cacheNames = typeof caches !== "undefined" ? await caches.keys() : [];
    } catch {}
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    const d = est.usageDetails || {};
    const frac = est.quota ? Math.min(1, (est.usage || 0) / est.quota) : 0;
    const projFrac = est.quota ? Math.min(1, (mine + ls) / est.quota) : 0;
    const rows = [
      ["this project: saved models", `${bytes(mine)} in ${this.list.length} save${this.list.length === 1 ? "" : "s"}`],
      ["this project: settings (localStorage)", bytes(ls)],
      ["whole site origin in use", `${bytes(est.usage)} of ${bytes(est.quota)}`],
    ];
    if (d.indexedDB != null) rows.push(["· IndexedDB", bytes(d.indexedDB)]);
    if (d.caches != null) rows.push(["· Cache Storage", bytes(d.caches)]);
    if (d.serviceWorkerRegistrations != null) rows.push(["· service workers", bytes(d.serviceWorkerRegistrations)]);
    rows.push(["Cache Storage buckets", cacheNames.length ? cacheNames.map(esc).join(", ") : "none"]);
    rows.push(["persistent storage", persisted ? "yes" : "no (may be evicted)"]);
    $("#storage-bar").innerHTML = `<div class="used" style="width:${(100 * frac).toFixed(2)}%"></div><div class="mine" style="width:${(100 * projFrac).toFixed(2)}%"></div>`;
    $("#storage-stats").innerHTML = rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join("");
    $("#btn-persist").disabled = !!persisted || !navigator.storage?.persist;
  }
}

function saveFile(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w .-]+/g, "_")}${blob.type === "application/gzip" ? ".json.gz" : ".json"}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
