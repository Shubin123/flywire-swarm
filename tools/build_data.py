"""
Build the static, browser-sized data files used by the demo from the public
FlyWire v783 release.

Inputs (download first, see tools/README.md):
  Connectivity_783.parquet  - Shiu et al. (2024), github.com/philshiu/Drosophila_brain_model (MIT)
  Supplemental_file1_neuron_annotations.tsv
                            - Schlegel et al. (2024) / FlyWire annotations,
                              github.com/flyconnectome/flywire_annotations

Outputs (written to ../data):
  neurons.bin   - every proofread neuron: uint16 x,y,z (normalised) + uint8 super_class + uint16 group
  connectome.json - a reduced, cell-type x hemisphere graph (~500 nodes) with signed weights

Usage: python build_data.py <connectivity.parquet> <annotations.tsv> <out_dir>
"""
import json
import sys

import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

conn_path, ann_path, out_dir = sys.argv[1:4]

N_TOP = 420          # groups chosen by total synapse count
K_IN = 14            # strongest incoming edges kept per node
K_OUT = 6            # strongest outgoing edges kept per node (keeps outputs reachable)

ann = pd.read_csv(ann_path, sep="\t", low_memory=False)
con = pd.read_parquet(conn_path)

# ---------------------------------------------------------------- groups
side = ann.side.fillna("na").replace({"na": "center"})
base = ann.cell_type.copy()
optic = ann.super_class == "optic"
# intrinsic optic-lobe neurons are aggregated by class so the brain view still covers the lobes
base[optic] = "OL:" + ann.cell_class[optic].fillna("optic")
base = base.fillna(ann.cell_class).fillna(ann.super_class)

# functional sensory pools (named so the JS can find them)
gust = ann.cell_class == "gustatory"
base[gust & ann.cell_sub_class.isin(["sugar", "sugar/low_salt"])] = "GRN_sugar"
base[gust & (ann.cell_sub_class == "bitter")] = "GRN_bitter"
base[ann.cell_class == "olfactory"] = "ORN"
base[ann.cell_class == "mechanosensory"] = "JO_mechano"
base[ann.cell_type == "CB0701"] = "MN9"      # proboscis motor neuron used by Shiu et al. (2024)
base[ann.cell_type == "DNp01"] = "GF"        # Giant Fiber
ann["group"] = base + "|" + side
# groups that are not a single cell type (optic-lobe classes, untyped fall-backs) are shown in the
# point cloud but excluded from the dynamic graph: lumping thousands of neurons into one node
# creates artificial recurrent excitation that the real, sparse circuit does not have
pools = {"GRN_sugar", "GRN_bitter", "ORN", "JO_mechano", "MN9", "GF"}
ann["specific"] = ann.cell_type.notna() & ~optic | base.isin(pools)
ann["super_class"] = ann.super_class.fillna("unknown")

# ---------------------------------------------------------------- group graph
gid = {g: i for i, g in enumerate(sorted(ann.group.unique()))}
root2g = pd.Series(ann.group.map(gid).values, index=ann.root_id.values)
pre = root2g.reindex(con.Presynaptic_ID.values).values
post = root2g.reindex(con.Postsynaptic_ID.values).values
ok = ~(np.isnan(pre) | np.isnan(post))
e = pd.DataFrame({
    "s": pre[ok].astype(int), "t": post[ok].astype(int),
    "w": con["Excitatory x Connectivity"].values[ok],
    "n": con["Connectivity"].values[ok],
})
E = e.groupby(["s", "t"], as_index=False).agg(w=("w", "sum"), n=("n", "sum"))
G = len(gid)
syn_out = np.bincount(E.s, weights=E.n, minlength=G)
syn_in = np.bincount(E.t, weights=E.n, minlength=G)
print("groups", G, "group edges", len(E))

mandatory_bases = ["GRN_sugar", "GRN_bitter", "ORN", "JO_mechano", "LPLC2", "EPG", "PFL3",
                   "DNa01", "DNa02", "GF", "MDN", "DNp09", "MN9", "PEN_a(PEN1)", "Kenyon_Cell"]
names = np.array(sorted(gid, key=gid.get))
gbase = np.array([n.split("|")[0] for n in names])
mand = [i for i, b in enumerate(gbase) if b in mandatory_bases or b.startswith("OA-") or b.startswith("MBON")]
mand = [i for i in mand if syn_in[i] + syn_out[i] > 0]
specific = set(ann.loc[ann.specific, "group"].map(gid))
mand = [i for i in mand if i in specific]

score = syn_in + syn_out
score[[i for i in range(G) if i not in specific]] = -1
order = np.argsort(-score)
chosen = list(dict.fromkeys(mand + list(order[:N_TOP])))

# add nodes on the strongest paths sensory -> motor so the reduced brain stays wired end to end
Es = E[E.s.isin(specific) & E.t.isin(specific)]
W = csr_matrix((1.0 / np.log1p(Es.n.values), (Es.s.values, Es.t.values)), shape=(G, G))
sources = [i for i in mand if gbase[i] in ("GRN_sugar", "GRN_bitter", "ORN", "LPLC2", "PFL3", "JO_mechano")]
targets = [i for i in mand if gbase[i] in ("GF", "MDN", "DNa02", "DNa01", "DNp09", "MN9")]
dist, pred = dijkstra(W, directed=True, indices=sources, return_predecessors=True)
for si in range(len(sources)):
    for t in targets:
        if np.isinf(dist[si, t]):
            continue
        v = t
        while v != sources[si] and v >= 0:
            chosen.append(v)
            v = pred[si, v]
chosen = list(dict.fromkeys(chosen))
idx = {g: k for k, g in enumerate(chosen)}
print("nodes", len(chosen))

sub = E[E.s.isin(idx) & E.t.isin(idx) & (E.s != E.t)].copy()
sub["a"] = sub.w.abs()
keep = set(sub.sort_values("a", ascending=False).groupby("t").head(K_IN).index)
keep |= set(sub.sort_values("a", ascending=False).groupby("s").head(K_OUT).index)
sub = sub.loc[sorted(keep)]
print("edges", len(sub))

# ---------------------------------------------------------------- coordinates
# FlyWire positions are in 4x4x40 nm voxels; convert to micrometres
xyz = np.stack([ann.pos_x * 4e-3, ann.pos_y * 4e-3, ann.pos_z * 40e-3], 1)
lo, hi = xyz.min(0), xyz.max(0)
centre = (lo + hi) / 2
scale = (hi - lo).max()

ann["gidx"] = ann.group.map(lambda g: idx.get(gid[g], -1))
nodes = []
for g in chosen:
    m = (ann.group.values == names[g])
    p = (xyz[m].mean(0) - centre) / scale
    sc = ann.super_class[m].mode().iat[0]
    nt = ann.top_nt[m].mode()
    b, s = names[g].split("|")
    nodes.append({
        "id": names[g], "type": b, "side": s, "n": int(m.sum()),
        "sc": sc, "nt": nt.iat[0] if len(nt) else "unknown",
        "p": [round(float(v), 4) for v in p],
        "syn": int(syn_in[g] + syn_out[g]),
    })

# normalise weights per postsynaptic node so every node sees comparable drive
edges = []
tot_in = sub.groupby("t").a.sum()
for r in sub.itertuples():
    edges.append([idx[r.s], idx[r.t], round(float(r.w / tot_in[r.t]), 4), int(r.n)])

meta = {
    "source": "FlyWire v783 public release (Dorkenwald et al. 2024; Schlegel et al. 2024); "
              "edge list from Shiu et al. 2024",
    "neurons": int(len(ann)), "synaptic_connections": int(con.Connectivity.sum()),
    "edges_full": int(len(con)), "groups_full": int(G),
    "um_scale": float(scale), "um_centre": [float(v) for v in centre],
}
with open(f"{out_dir}/connectome.json", "w") as f:
    json.dump({"meta": meta, "nodes": nodes, "edges": edges}, f, separators=(",", ":"))

# ---------------------------------------------------------------- point cloud
classes = sorted(ann.super_class.unique())
q = np.clip(((xyz - centre) / scale + 0.5) * 65535, 0, 65535).astype("<u2")
sc = ann.super_class.map({c: i for i, c in enumerate(classes)}).values.astype("u1")
gi = ann.gidx.values.astype("<i4")
gi = np.where(gi < 0, 65535, gi).astype("<u2")
buf = np.zeros(len(ann), dtype=[("x", "<u2"), ("y", "<u2"), ("z", "<u2"), ("g", "<u2")])
buf["x"], buf["y"], buf["z"], buf["g"] = q[:, 0], q[:, 1], q[:, 2], gi
with open(f"{out_dir}/neurons.bin", "wb") as f:
    f.write(buf.tobytes())
    f.write(sc.tobytes())
with open(f"{out_dir}/neurons.json", "w") as f:
    json.dump({"count": int(len(ann)), "classes": classes}, f)
print("done")
