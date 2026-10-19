"""
Build data/refs.json from Crossref so that every author is credited exactly as
published. Works without DOIs (books, proceedings) are entered by hand below.

Usage: python build_refs.py ../data/refs.json
"""
import json
import sys
import urllib.request

DOIS = {
    # FlyWire connectome and its data products
    "dorkenwald2024": "10.1038/s41586-024-07558-y",
    "schlegel2024": "10.1038/s41586-024-07686-5",
    "matsliah2024": "10.1038/s41586-024-07981-1",
    "lin2024": "10.1038/s41586-024-07968-y",
    "shiu2024": "10.1038/s41586-024-07763-9",
    "eckstein2024": "10.1016/j.cell.2024.03.016",
    "zheng2018": "10.1016/j.cell.2018.06.019",
    "buhmann2021": "10.1038/s41592-021-01183-7",
    "berg2026": "10.1016/j.cell.2026.08.015",
    "tastekin2026": "10.1016/j.cell.2026.08.016",
    # circuits used for behaviour
    "vonreyn2014": "10.1038/nn.3741",
    "ache2019": "10.1016/j.cub.2019.01.079",
    "bidaye2014": "10.1126/science.1249964",
    "bidaye2020": "10.1016/j.neuron.2020.07.032",
    "westeinde2024": "10.1038/s41586-024-07039-2",
    "mussellspires2024": "10.1038/s41586-023-07006-3",
    "hoyer2008": "10.1016/j.cub.2007.12.052",
    "zhou2008": "10.1038/nn.2164",
    # game theory
    "maynardsmith1973": "10.1038/246015a0",
    "taylor1978": "10.1016/0025-5564(78)90077-9",
    "nash1950": "10.1073/pnas.36.1.48",
    "nowak1992": "10.1038/359826a0",
    "lieberman2005": "10.1038/nature03204",
    "ohtsuki2006": "10.1038/nature04605",
    "hamilton1971": "10.1016/0022-5193(71)90189-5",
    "traulsen2006": "10.1103/PhysRevE.74.011909",
    "hauert2004": "10.1038/nature02360",
    # heuristics
    "hart1968": "10.1109/TSSC.1968.300136",
    "gigerenzer1996": "10.1037/0033-295X.103.4.650",
    "simon1955": "10.2307/1884852",
    "charnov1976": "10.1016/0040-5809(76)90040-X",
    "reynolds1987": "10.1145/37402.37406",
    # graph theory
    "dijkstra1959": "10.1007/BF01386390",
    "brandes2001": "10.1080/0022250X.2001.9990249",
    "watts1998": "10.1038/30918",
    "blondel2008": "10.1088/1742-5468/2008/10/P10008",
    "newman2004": "10.1103/PhysRevE.69.026113",
    # clustering
    "lloyd1982": "10.1109/TIT.1982.1056489",
    "aloise2009": "10.1007/s10994-009-5103-0",
}

MANUAL = {
    "flywire_zenodo": {
        "authors": ["FlyWire Consortium"], "year": 2024,
        "title": "FlyWire Whole-brain Connectome Connectivity Data (materialization v783)",
        "venue": "Zenodo (CC BY 4.0)", "doi": "10.5281/zenodo.10676866",
    },
    "flywire_annotations": {
        "authors": ["Philipp Schlegel", "Gregory S. X. E. Jefferis", "and contributors"], "year": 2026,
        "title": "flywire_annotations: neuron annotations for the FlyWire 783 release",
        "venue": "GitHub, flyconnectome/flywire_annotations",
        "url": "https://github.com/flyconnectome/flywire_annotations",
    },
    "shiu_code": {
        "authors": ["Philip K. Shiu", "Nico Spiller"], "year": 2023,
        "title": "Drosophila_brain_model (Connectivity_783.parquet edge list; MIT licence)",
        "venue": "GitHub, philshiu/Drosophila_brain_model",
        "url": "https://github.com/philshiu/Drosophila_brain_model",
    },
    "maynardsmith1982": {
        "authors": ["John Maynard Smith"], "year": 1982,
        "title": "Evolution and the Theory of Games", "venue": "Cambridge University Press",
        "doi": "10.1017/CBO9780511806292",
    },
    "hofbauer1998": {
        "authors": ["Josef Hofbauer", "Karl Sigmund"], "year": 1998,
        "title": "Evolutionary Games and Population Dynamics", "venue": "Cambridge University Press",
        "doi": "10.1017/CBO9781139173179",
    },
    "page1999": {
        "authors": ["Lawrence Page", "Sergey Brin", "Rajeev Motwani", "Terry Winograd"], "year": 1999,
        "title": "The PageRank citation ranking: bringing order to the web",
        "venue": "Stanford InfoLab Technical Report 1999-66", "url": "http://ilpubs.stanford.edu:8090/422/",
    },
    "ester1996": {
        "authors": ["Martin Ester", "Hans-Peter Kriegel", "Jörg Sander", "Xiaowei Xu"], "year": 1996,
        "title": "A density-based algorithm for discovering clusters in large spatial databases with noise",
        "venue": "Proceedings of KDD-96, AAAI Press, 226–231",
        "url": "https://cdn.aaai.org/KDD/1996/KDD96-037.pdf",
    },
    "arthur2007": {
        "authors": ["David Arthur", "Sergei Vassilvitskii"], "year": 2007,
        "title": "k-means++: the advantages of careful seeding",
        "venue": "Proceedings of the 18th ACM-SIAM Symposium on Discrete Algorithms (SODA), 1027–1035",
        "url": "https://dl.acm.org/doi/10.5555/1283383.1283494",
    },
    "threejs": {
        "authors": ["Ricardo Cabello (mrdoob)", "three.js contributors"], "year": 2010,
        "title": "three.js — JavaScript 3D library (MIT licence)", "venue": "threejs.org",
        "url": "https://threejs.org",
    },
}


def crossref(doi):
    req = urllib.request.Request(f"https://api.crossref.org/works/{doi}",
                                 headers={"User-Agent": "flywire-swarm-refs/1.0"})
    m = json.load(urllib.request.urlopen(req, timeout=30))["message"]
    authors = []
    for a in m.get("author", []):
        if "family" in a:
            given = a.get("given", "").strip()
            fam = a["family"].strip()
            if fam.isupper():
                fam = fam.title()
            authors.append(f"{given} {fam}".strip())
        elif "name" in a:
            authors.append(a["name"])
    title = " ".join(m["title"][0].replace("<i>", "").replace("</i>", "").split())
    venue = (m.get("container-title") or [""])[0]
    bits = [venue]
    if m.get("volume"):
        bits.append(m["volume"])
    if m.get("page"):
        bits.append(m["page"])
    return {
        "authors": authors, "year": m["issued"]["date-parts"][0][0], "title": title,
        "venue": ", ".join(b for b in bits if b), "doi": doi,
    }


out = {}
for key, doi in DOIS.items():
    out[key] = crossref(doi)
    print(key, len(out[key]["authors"]), "authors")
out.update(MANUAL)
with open(sys.argv[1], "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=0)
