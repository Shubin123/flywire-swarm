# FlyWire Swarm

A swarm of flies, each running its own reduced copy of the adult *Drosophila* whole-brain connectome from
[FlyWire](https://flywire.ai), rendered with three.js. It runs entirely in the browser (static files, no server) and ties
together **game theory, heuristics, graph theory, clustering and the connectome**, with every pair of ideas linked
inside the simulation.

**Live demo:** https://shubin123.github.io/flywire-swarm/

## How it works

```
senses ──► sensory neurons ──► reduced FlyWire connectome (618 cell types, 9,144 signed edges) ──► descending / motor neurons ──► body
   ▲                                         ▲                                                          │
   │                  heuristic goal (A*) ──► PFL3                                                     ▼
 world ◄── Hawk–Dove contests, birth–death selection, DBSCAN swarms, social graph, predator ◄──── behaviour
```

| Connectome pathway (real FlyWire wiring) | Behaviour in the swarm |
|---|---|
| sugar gustatory receptor neurons → … → **MN9** proboscis motor neuron (Shiu et al. 2024) | energy intake is proportional to MN9 activity |
| **LPLC2** looming detectors → **Giant Fiber** (DNp01) | escape take-off when the predator dives |
| heuristic goal injected into **PFL3** → **DNa02** steering neurons | turning toward the A* waypoint |
| Johnston's organ (touch) → **MDN** moonwalker neurons | backing away when jostled |
| octopaminergic (**OA-**) cell types | raise the probability of playing the selfish option (Hawk / Defect / Hare) |

The five ideas and how they connect (all ten pairs are explained, with a live metric, in the **Ideas** tab):

| | Graph theory | Clustering | Game theory | Heuristics |
|---|---|---|---|---|
| **Connectome** | the connectome is a weighted digraph: PageRank, betweenness, Louvain, Dijkstra paths | cell types are clusters; k-means on neural activity gives behavioural modes | octopaminergic activity biases the strategy choice | A* goals reach the motor system through PFL3 → DNa02 |
| **Graph theory** | | DBSCAN swarms ≈ components of the ε-graph; Louvain = graph clustering | contests and strategy copying happen along social-graph edges (evolutionary graph theory) | A* is heuristic graph search (vs Dijkstra) |
| **Clustering** | | | crowding sets contest rates; predator targets the biggest swarm | k-means is Lloyd's heuristic; "fewer rivals" is a take-the-best cue |
| **Game theory** | | | | bounded-rational imitators still converge on the ESS |

### Games and learning

Pick **Hawk–Dove**, the **Prisoner's Dilemma** (donation game) or the **Stag Hunt**. Flies that meet on food play with expected
payoffs; every ~8 s a fly compares its recent payoff with a graph neighbour's (or anyone's — a toggle) and copies that fly's
disposition with the Fermi probability (pairwise comparison, Traulsen, Nowak & Pacheco 2006). Births are proportional to energy.
The Game tab shows the payoff matrix, the stable and unstable rest points of the replicator equation, and the population's path.
Expected outcomes: Hawk share ≈ V/C in Hawk–Dove, all-Defect in the Prisoner's Dilemma, and whichever side of the tipping point
1 − C/V the Stag Hunt starts on. Mutation and the finite swarm keep the population near, not exactly on, the analytic line.

Two design choices keep that comparison fair, and both were found by measuring the simulation: losers are jostled but not
chased off a patch (otherwise winners monopolise patches and pairings stop being random), and payoffs are scaled so that one
contest rarely kills (otherwise losers die before anyone can learn from their bad payoffs — survivorship bias).

### Health, predators and robots

Every fly has a health value (0–1) next to its energy. Escalated Hawk–Hawk fights wound both flies in proportion to C,
the bird's dive batters flies near its path and swallows the one it touches, and dragonflies run down single flies
(preferring wounded, isolated ones) and bite. Robots, re-implemented after the 6-DOF arm in
[ArmLab / 6dof-gym-web](https://shubin123.github.io/6dof-gym-web/) (analytic IK targets, a per-tick joint-step cap,
no going below the floor), share the arena: a **picker** arm grips flies off the food and crushes them, a **net** arm
sweeps through the densest knot, a **ball turret** lobs balls at flies near the stacker, and a **stacker** arm tries to
stack 16 blocks while flies knock blocks out of its gripper and stray balls topple its tower. Wounded flies are slower
and heal slowly. At zero health a fly dies: its body falls, lies (legs up, over a splat) for six seconds, and its slot
goes to a newborn. Colour by **Health** for green → yellow → red. In every other colouring, wounds darken a fly and a hit
flashes white. In 300 s runs over three seeds, the robots and dragonflies did not shift the Hawk share away from the ESS
(0.46 with them, 0.44 without).

### Saving the model

The **Save** tab snapshots the whole model (every fly's body, genes and connectome activity, the RNG state, food,
predators, robots and statistics), gzips it (~330 KB) and keeps it in the browser's IndexedDB. Snapshots can be loaded
back, exported or imported as `.json.gz` files, or autosaved every minute. The tab also shows how much storage the project
and the whole origin use.

### Things to try

Drag **V** and **C** and watch the played share follow the equilibrium; switch to the Stag Hunt and start on either side of
the tipping point; silence **MN9** (flies starve), **Giant Fiber** (the predator feasts), **PFL3** (navigation breaks) or **OA-**
neurons (less selfish play); click a fly to see its brain light up. **Copy link to this setup** puts every setting in the URL,
so an experiment can be shared, e.g.
`https://shubin123.github.io/flywire-swarm/?game=stag&V=4&C=1.5&learn=anyone`.

## Honest limitations

This is an illustration, not a biophysical model. The reduction lumps neurons by cell type and hemisphere, keeps the
strongest ~15 inputs per node, and replaces spiking neurons with a 4-hop rate propagation so hundreds of brains can run in
a background Web Worker. Lumping removes the sparse coding of the real olfactory system, so odour only sets arousal; odour-guided search is
done by the heuristic layer. The game, heuristic and clustering layers are deliberately simple textbook algorithms, and a
reflex layer prevents collisions.

## Data and licences

- **Connectivity:** FlyWire materialization v783, via the edge list published with Shiu et al. (2024)
  ([philshiu/Drosophila_brain_model](https://github.com/philshiu/Drosophila_brain_model), MIT). FlyWire connectivity data are
  released by the FlyWire Consortium under CC BY 4.0 ([Zenodo 10676866](https://doi.org/10.5281/zenodo.10676866)).
- **Neuron positions, super-classes, cell types, neurotransmitters:** [flyconnectome/flywire_annotations](https://github.com/flyconnectome/flywire_annotations)
  (Schlegel et al. 2024, with updates from Matsliah et al. 2024, Berg et al. 2026 and Tastekin et al. 2026, which the maintainers ask to be cited).
- `data/` holds derived files only: `neurons.bin` (positions + super-class of all 139,248 neurons), `connectome.json`
  (the reduced graph) and `refs.json` (references, built from Crossref).
- Code in this repository: MIT (see `LICENSE`). three.js (r186, loaded from jsDelivr) is MIT, © Ricardo Cabello and three.js contributors.

### Rebuilding the data

```bash
pip install pandas pyarrow numpy scipy
curl -LO https://github.com/philshiu/Drosophila_brain_model/raw/main/Connectivity_783.parquet
curl -LO https://github.com/flyconnectome/flywire_annotations/raw/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv
python tools/build_data.py Connectivity_783.parquet Supplemental_file1_neuron_annotations.tsv data
python tools/build_refs.py data/refs.json
```

Rendering falls back from WebGL to WebGPU to a 2D canvas automatically; add `?renderer=webgpu` or `?renderer=2d` to the URL to force a path.

Serve the folder with any static server (`python -m http.server`) and open `http://localhost:8000`.
Before deploying, run `python tools/stamp.py`: it versions every script, stylesheet and data file in `index.html` with a
content hash, so browsers never mix cached old files with new ones.

## Code map

| File | Role |
|---|---|
| `js/connectome.js` | loads the data; batched per-fly brain model |
| `js/brain-worker.js` | runs the brain propagation off the main thread |
| `js/sim.js` | the swarm: senses → brain → body, contests, health, predator, dragonflies, life cycle |
| `js/robots.js` | 6-DOF arms (picker, net, stacker) and the ball turret |
| `js/snapshot.js`, `js/store.js` | model serialisation; the Save panel (IndexedDB, files, storage usage) |
| `js/game.js` | 2×2 games (Hawk–Dove, Prisoner's Dilemma, Stag Hunt), equilibria, replicator equation |
| `js/heuristics.js` | A* on an occupancy grid, take-the-best, satisficing leave rule |
| `js/graph.js` | PageRank, Louvain, Brandes betweenness, Dijkstra, clustering coefficient, union-find |
| `js/cluster.js` | spatial hash, DBSCAN, k-means++ |
| `js/analysis.js` | start-up analysis of the reduced connectome |
| `js/main.js`, `js/brainview.js` | three.js swarm and brain renderers (WebGL, or WebGPU when WebGL is unavailable) |
| `js/canvasview.js`, `js/brain2d.js` | 2D canvas fallbacks for browsers with neither WebGL nor WebGPU |
| `js/panels.js`, `js/ideas.js` | side panels, charts, concept map, citations |
| `tools/` | data reduction, reference builder and `stamp.py` cache-busting |

## Acknowledgements

FlyWire was built by the FlyWire Consortium: the hundreds of proofreaders, annotators, tool builders and scientists listed in
the papers below, led by Sebastian Seung and Mala Murthy, with annotation led by Gregory Jefferis and Philipp Schlegel.
The whole-brain computational model that inspired the brain layer is by Philip Shiu, Kristin Scott and colleagues.

## References

### FlyWire connectome & data

- Sven Dorkenwald, Arie Matsliah, Amy R. Sterling, Philipp Schlegel, Szi-chieh Yu, Claire E. McKellar, Albert Lin, Marta Costa, Katharina Eichler, Yijie Yin, … Meet Zandawala (2024). *Neuronal wiring diagram of an adult brain*. Nature, 634, 124-138. [doi:10.1038/s41586-024-07558-y](https://doi.org/10.1038/s41586-024-07558-y)
  <details><summary>All 294 authors</summary>

  Sven Dorkenwald, Arie Matsliah, Amy R. Sterling, Philipp Schlegel, Szi-chieh Yu, Claire E. McKellar, Albert Lin, Marta Costa, Katharina Eichler, Yijie Yin, Will Silversmith, Casey Schneider-Mizell, Chris S. Jordan, Derrick Brittain, Akhilesh Halageri, Kai Kuehner, Oluwaseun Ogedengbe, Ryan Morey, Jay Gager, Krzysztof Kruk, Eric Perlman, Runzhe Yang, David Deutsch, Doug Bland, Marissa Sorek, Ran Lu, Thomas Macrina, Kisuk Lee, J. Alexander Bae, Shang Mu, Barak Nehoran, Eric Mitchell, Sergiy Popovych, Jingpeng Wu, Zhen Jia, Manuel A. Castro, Nico Kemnitz, Dodam Ih, Alexander Shakeel Bates, Nils Eckstein, Jan Funke, Forrest Collman, Davi D. Bock, Gregory S. X. E. Jefferis, H. Sebastian Seung, Mala Murthy, The FlyWire Consortium, Zairene Lenizo, Austin T. Burke, Kyle Patrick Willie, Nikitas Serafetinidis, Nashra Hadjerol, Ryan Willie, Ben Silverman, John Anthony Ocho, Joshua Bañez, Rey Adrian Candilada, Anne Kristiansen, Nelsie Panes, Arti Yadav, Remer Tancontian, Shirleyjoy Serona, Jet Ivan Dolorosa, Kendrick Joules Vinson, Dustin Garner, Regine Salem, Ariel Dagohoy, Jaime Skelton, Mendell Lopez, Laia Serratosa Capdevila, Griffin Badalamente, Thomas Stocks, Anjali Pandey, Darrel Jay Akiatan, James Hebditch, Celia David, Dharini Sapkal, Shaina Mae Monungolh, Varun Sane, Mark Lloyd Pielago, Miguel Albero, Jacquilyn Laude, Márcia dos Santos, Zeba Vohra, Kaiyu Wang, Allien Mae Gogo, Emil Kind, Alvin Josh Mandahay, Chereb Martinez, John David Asis, Chitra Nair, Dhwani Patel, Marchan Manaytay, Imaan F. M. Tamimi, Clyde Angelo Lim, Philip Lenard Ampo, Michelle Darapan Pantujan, Alexandre Javier, Daril Bautista, Rashmita Rana, Jansen Seguido, Bhargavi Parmar, John Clyde Saguimpa, Merlin Moore, Markus William Pleijzier, Mark Larson, Joseph Hsu, Itisha Joshi, Dhara Kakadiya, Amalia Braun, Cathy Pilapil, Marina Gkantia, Kaushik Parmar, Quinn Vanderbeck, Irene Salgarella, Christopher Dunne, Eva Munnelly, Chan Hyuk Kang, Lena Lörsch, Jinmook Lee, Lucia Kmecova, Gizem Sancer, Christa Baker, Jenna Joroff, Steven Calle, Yashvi Patel, Olivia Sato, Siqi Fang, Janice Salocot, Farzaan Salman, Sebastian Molina-Obando, Paul Brooks, Mai Bui, Matthew Lichtenberger, Edward Tamboboy, Katie Molloy, Alexis E. Santana-Cruz, Anthony Hernandez, Seongbong Yu, Arzoo Diwan, Monika Patel, Travis R. Aiken, Sarah Morejohn, Sanna Koskela, Tansy Yang, Daniel Lehmann, Jonas Chojetzki, Sangeeta Sisodiya, Selden Koolman, Philip K. Shiu, Sky Cho, Annika Bast, Brian Reicher, Marlon Blanquart, Lucy Houghton, Hyungjun Choi, Maria Ioannidou, Matt Collie, Joanna Eckhardt, Benjamin Gorko, Li Guo, Zhihao Zheng, Alisa Poh, Marina Lin, István Taisz, Wes Murfin, Álvaro Sanz Díez, Nils Reinhard, Peter Gibb, Nidhi Patel, Sandeep Kumar, Minsik Yun, Megan Wang, Devon Jones, Lucas Encarnacion-Rivera, Annalena Oswald, Akanksha Jadia, Mert Erginkaya, Nik Drummond, Leonie Walter, Ibrahim Tastekin, Xin Zhong, Yuta Mabuchi, Fernando J. Figueroa Santiago, Urja Verma, Nick Byrne, Edda Kunze, Thomas Crahan, Ryan Margossian, Haein Kim, Iliyan Georgiev, Fabianna Szorenyi, Atsuko Adachi, Benjamin Bargeron, Tomke Stürner, Damian Demarest, Burak Gür, Andrea N. Becker, Robert Turnbull, Ashley Morren, Andrea Sandoval, Anthony Moreno-Sanchez, Diego A. Pacheco, Eleni Samara, Haley Croke, Alexander Thomson, Connor Laughland, Suchetana B. Dutta, Paula Guiomar Alarcón de Antón, Binglin Huang, Patricia Pujols, Isabel Haber, Amanda González-Segarra, Daniel T. Choe, Veronika Lukyanova, Nino Mancini, Zequan Liu, Tatsuo Okubo, Miriam A. Flynn, Gianna Vitelli, Meghan Laturney, Feng Li, Shuo Cao, Carolina Manyari-Diaz, Hyunsoo Yim, Anh Duc Le, Kate Maier, Seungyun Yu, Yeonju Nam, Daniel Bąba, Amanda Abusaif, Audrey Francis, Jesse Gayk, Sommer S. Huntress, Raquel Barajas, Mindy Kim, Xinyue Cui, Gabriella R. Sterne, Anna Li, Keehyun Park, Georgia Dempsey, Alan Mathew, Jinseong Kim, Taewan Kim, Guan-ting Wu, Serene Dhawan, Margarida Brotas, Cheng-hao Zhang, Shanice Bailey, Alexander Del Toro, Runzhe Yang, Stephan Gerhard, Andrew Champion, David J. Anderson, Rudy Behnia, Salil S. Bidaye, Alexander Borst, Eugenia Chiappe, Kenneth J. Colodner, Andrew Dacks, Barry Dickson, Denise Garcia, Stefanie Hampel, Volker Hartenstein, Bassem Hassan, Charlotte Helfrich-Forster, Wolf Huetteroth, Jinseop Kim, Sung Soo Kim, Young-Joon Kim, Jae Young Kwon, Wei-Chung Lee, Gerit A. Linneweber, Gaby Maimon, Richard Mann, Stéphane Noselli, Michael Pankratz, Lucia Prieto-Godino, Jenny Read, Michael Reiser, Katie von Reyn, Carlos Ribeiro, Kristin Scott, Andrew M. Seeds, Mareike Selcho, Marion Silies, Julie Simpson, Scott Waddell, Mathias F. Wernet, Rachel I. Wilson, Fred W. Wolf, Zepeng Yao, Nilay Yapici, Meet Zandawala
  </details>
- Philipp Schlegel, Yijie Yin, Alexander S. Bates, Sven Dorkenwald, Katharina Eichler, Paul Brooks, Daniel S. Han, Marina Gkantia, Marcia dos Santos, Eva J. Munnelly, … Gregory S. X. E. Jefferis (2024). *Whole-brain annotation and multi-connectome cell typing of Drosophila*. Nature, 634, 139-152. [doi:10.1038/s41586-024-07686-5](https://doi.org/10.1038/s41586-024-07686-5)
  <details><summary>All 307 authors</summary>

  Philipp Schlegel, Yijie Yin, Alexander S. Bates, Sven Dorkenwald, Katharina Eichler, Paul Brooks, Daniel S. Han, Marina Gkantia, Marcia dos Santos, Eva J. Munnelly, Griffin Badalamente, Laia Serratosa Capdevila, Varun A. Sane, Alexandra M. C. Fragniere, Ladann Kiassat, Markus W. Pleijzier, Tomke Stürner, Imaan F. M. Tamimi, Christopher R. Dunne, Irene Salgarella, Alexandre Javier, Siqi Fang, Eric Perlman, Tom Kazimiers, Sridhar R. Jagannathan, Arie Matsliah, Amy R. Sterling, Szi-chieh Yu, Claire E. McKellar, FlyWire Consortium, Krzysztof Kruk, Doug Bland, Zairene Lenizo, Austin T. Burke, Kyle Patrick Willie, Alexander S. Bates, Nikitas Serafetinidis, Nashra Hadjerol, Ryan Willie, Ben Silverman, John Anthony Ocho, Joshua Bañez, Rey Adrian Candilada, Jay Gager, Anne Kristiansen, Nelsie Panes, Arti Yadav, Remer Tancontian, Shirleyjoy Serona, Jet Ivan Dolorosa, Kendrick Joules Vinson, Dustin Garner, Regine Salem, Ariel Dagohoy, Jaime Skelton, Mendell Lopez, Thomas Stocks, Anjali Pandey, Darrel Jay Akiatan, James Hebditch, Celia David, Dharini Sapkal, Shaina Mae Monungolh, Varun Sane, Mark Lloyd Pielago, Miguel Albero, Jacquilyn Laude, Márcia dos Santos, David Deutsch, Zeba Vohra, Kaiyu Wang, Allien Mae Gogo, Emil Kind, Alvin Josh Mandahay, Chereb Martinez, John David Asis, Chitra Nair, Dhwani Patel, Marchan Manaytay, Clyde Angelo Lim, Philip Lenard Ampo, Michelle Darapan Pantujan, Daril Bautista, Rashmita Rana, Jansen Seguido, Bhargavi Parmar, John Clyde Saguimpa, Merlin Moore, Markus W. Pleijzier, Mark Larson, Joseph Hsu, Itisha Joshi, Dhara Kakadiya, Amalia Braun, Cathy Pilapil, Kaushik Parmar, Quinn Vanderbeck, Christopher Dunne, Eva Munnelly, Chan Hyuk Kang, Lena Lörsch, Jinmook Lee, Lucia Kmecova, Gizem Sancer, Christa Baker, Jenna Joroff, Steven Calle, Yashvi Patel, Olivia Sato, Janice Salocot, Farzaan Salman, Sebastian Molina-Obando, Mai Bui, Matthew Lichtenberger, Edmark Tamboboy, Katie Molloy, Alexis E. Santana-Cruz, Anthony Hernandez, Seongbong Yu, Marissa Sorek, Arzoo Diwan, Monika Patel, Travis R. Aiken, Sarah Morejohn, Sanna Koskela, Tansy Yang, Daniel Lehmann, Jonas Chojetzki, Sangeeta Sisodiya, Selden Koolman, Philip K. Shiu, Sky Cho, Annika Bast, Brian Reicher, Marlon Blanquart, Lucy Houghton, Hyungjun Choi, Maria Ioannidou, Matt Collie, Joanna Eckhardt, Benjamin Gorko, Li Guo, Zhihao Zheng, Alisa Poh, Marina Lin, István Taisz, Wes Murfin, Álvaro Sanz Díez, Nils Reinhard, Peter Gibb, Nidhi Patel, Sandeep Kumar, Minsik Yun, Megan Wang, Devon Jones, Lucas Encarnacion-Rivera, Annalena Oswald, Akanksha Jadia, Mert Erginkaya, Nik Drummond, Leonie Walter, Ibrahim Tastekin, Xin Zhong, Yuta Mabuchi, Fernando J. Figueroa Santiago, Urja Verma, Nick Byrne, Edda Kunze, Thomas Crahan, Ryan Margossian, Haein Kim, Iliyan Georgiev, Fabianna Szorenyi, Atsuko Adachi, Benjamin Bargeron, Tomke Stürner, Damian Demarest, Burak Gür, Andrea N. Becker, Robert Turnbull, Ashley Morren, Andrea Sandoval, Anthony Moreno-Sanchez, Diego A. Pacheco, Eleni Samara, Haley Croke, Alexander Thomson, Connor Laughland, Suchetana B. Dutta, Paula Guiomar Alarcón de Antón, Binglin Huang, Patricia Pujols, Isabel Haber, Amanda González-Segarra, Albert Lin, Daniel T. Choe, Veronika Lukyanova, Nino Mancini, Zequan Liu, Tatsuo Okubo, Miriam A. Flynn, Gianna Vitelli, Meghan Laturney, Feng Li, Shuo Cao, Carolina Manyari-Diaz, Hyunsoo Yim, Anh Duc Le, Kate Maier, Seungyun Yu, Yeonju Nam, Daniel Bąba, Amanda Abusaif, Audrey Francis, Jesse Gayk, Sommer S. Huntress, Raquel Barajas, Mindy Kim, Xinyue Cui, Amy R. Sterling, Gabriella R. Sterne, Anna Li, Keehyun Park, Georgia Dempsey, Alan Mathew, Jinseong Kim, Taewan Kim, Guan-ting Wu, Serene Dhawan, Margarida Brotas, Cheng-hao Zhang, Shanice Bailey, Alexander Del Toro, Kisuk Lee, Thomas Macrina, Casey Schneider-Mizell, Sergiy Popovych, Oluwaseun Ogedengbe, Runzhe Yang, Akhilesh Halageri, Will Silversmith, Stephan Gerhard, Andrew Champion, Nils Eckstein, Dodam Ih, Nico Kemnitz, Manuel Castro, Zhen Jia, Jingpeng Wu, Eric Mitchell, Barak Nehoran, Shang Mu, J. Alexander Bae, Ran Lu, Ryan Morey, Kai Kuehner, Derrick Brittain, Chris S. Jordan, David J. Anderson, Rudy Behnia, Salil S. Bidaye, Alexander Borst, Eugenia Chiappe, Forrest Collman, Kenneth J. Colodner, Andrew Dacks, Barry Dickson, Jan Funke, Denise Garcia, Stefanie Hampel, Volker Hartenstein, Bassem Hassan, Charlotte Helfrich-Forster, Wolf Huetteroth, Jinseop Kim, Sung Soo Kim, Young-Joon Kim, Jae Young Kwon, Wei-Chung Lee, Gerit A. Linneweber, Gaby Maimon, Richard Mann, Stéphane Noselli, Michael Pankratz, Lucia Prieto-Godino, Jenny Read, Michael Reiser, Katie von Reyn, Carlos Ribeiro, Kristin Scott, Andrew M. Seeds, Mareike Selcho, Marion Silies, Julie Simpson, Scott Waddell, Mathias F. Wernet, Rachel I. Wilson, Fred W. Wolf, Zepeng Yao, Nilay Yapici, Meet Zandawala, Marta Costa, H. Sebastian Seung, Mala Murthy, Volker Hartenstein, Davi D. Bock, Gregory S. X. E. Jefferis
  </details>
- Arie Matsliah, Szi-chieh Yu, Krzysztof Kruk, Doug Bland, Austin T. Burke, Jay Gager, James Hebditch, Ben Silverman, Kyle Patrick Willie, Ryan Willie, … Gregory S. X. E. Jefferis (2024). *Neuronal parts list and wiring diagram for a visual system*. Nature, 634, 166-180. [doi:10.1038/s41586-024-07981-1](https://doi.org/10.1038/s41586-024-07981-1)
  <details><summary>All 44 authors</summary>

  Arie Matsliah, Szi-chieh Yu, Krzysztof Kruk, Doug Bland, Austin T. Burke, Jay Gager, James Hebditch, Ben Silverman, Kyle Patrick Willie, Ryan Willie, Marissa Sorek, Amy R. Sterling, Emil Kind, Dustin Garner, Gizem Sancer, Mathias F. Wernet, Sung Soo Kim, Mala Murthy, H. Sebastian Seung, The FlyWire Consortium, Celia David, Jenna Joroff, Anne Kristiansen, Thomas Stocks, Amalia Braun, Marion Silies, Jaime Skelton, Travis R. Aiken, Maria Ioannidou, Matt Collie, Gerit A. Linneweber, Sebastian Molina-Obando, Sven Dorkenwald, Nelsie Panes, Allien Mae Gogo, Dorfam Rastgarmoghaddam, Cathy Pilapil, Rey Adrian Candilada, Nikitas Serafetinidis, Wei-Chung Lee, Alexander Borst, Rachel I. Wilson, Philipp Schlegel, Gregory S. X. E. Jefferis
  </details>
- Albert Lin, Runzhe Yang, Sven Dorkenwald, Arie Matsliah, Amy R. Sterling, Philipp Schlegel, Szi-chieh Yu, Claire E. McKellar, Marta Costa, Katharina Eichler, … Mala Murthy (2024). *Network statistics of the whole-brain connectome of Drosophila*. Nature, 634, 153-165. [doi:10.1038/s41586-024-07968-y](https://doi.org/10.1038/s41586-024-07968-y)
  <details><summary>All 15 authors</summary>

  Albert Lin, Runzhe Yang, Sven Dorkenwald, Arie Matsliah, Amy R. Sterling, Philipp Schlegel, Szi-chieh Yu, Claire E. McKellar, Marta Costa, Katharina Eichler, Alexander Shakeel Bates, Nils Eckstein, Jan Funke, Gregory S. X. E. Jefferis, Mala Murthy
  </details>
- Nils Eckstein, Alexander Shakeel Bates, Andrew Champion, Michelle Du, Yijie Yin, Philipp Schlegel, Alicia Kun-Yang Lu, Thomson Rymer, Samantha Finley-May, Tyler Paterson, … Jan Funke (2024). *Neurotransmitter classification from electron microscopy images at synaptic sites in Drosophila melanogaster*. Cell, 187, 2574-2594.e23. [doi:10.1016/j.cell.2024.03.016](https://doi.org/10.1016/j.cell.2024.03.016)
  <details><summary>All 23 authors</summary>

  Nils Eckstein, Alexander Shakeel Bates, Andrew Champion, Michelle Du, Yijie Yin, Philipp Schlegel, Alicia Kun-Yang Lu, Thomson Rymer, Samantha Finley-May, Tyler Paterson, Ruchi Parekh, Sven Dorkenwald, Arie Matsliah, Szi-Chieh Yu, Claire McKellar, Amy Sterling, Katharina Eichler, Marta Costa, Sebastian Seung, Mala Murthy, Volker Hartenstein, Gregory S.X.E. Jefferis, Jan Funke
  </details>
- Julia Buhmann, Arlo Sheridan, Caroline Malin-Mayor, Philipp Schlegel, Stephan Gerhard, Tom Kazimiers, Renate Krause, Tri M. Nguyen, Larissa Heinrich, Wei-Chung Allen Lee, … Jan Funke (2021). *Automatic detection of synaptic partners in a whole-brain Drosophila electron microscopy data set*. Nature Methods, 18, 771-774. [doi:10.1038/s41592-021-01183-7](https://doi.org/10.1038/s41592-021-01183-7)
  <details><summary>All 17 authors</summary>

  Julia Buhmann, Arlo Sheridan, Caroline Malin-Mayor, Philipp Schlegel, Stephan Gerhard, Tom Kazimiers, Renate Krause, Tri M. Nguyen, Larissa Heinrich, Wei-Chung Allen Lee, Rachel Wilson, Stephan Saalfeld, Gregory S. X. E. Jefferis, Davi D. Bock, Srinivas C. Turaga, Matthew Cook, Jan Funke
  </details>
- Zhihao Zheng, J. Scott Lauritzen, Eric Perlman, Camenzind G. Robinson, Matthew Nichols, Daniel Milkie, Omar Torrens, John Price, Corey B. Fisher, Nadiya Sharifi, … Davi D. Bock (2018). *A Complete Electron Microscopy Volume of the Brain of Adult Drosophila melanogaster*. Cell, 174, 730-743.e22. [doi:10.1016/j.cell.2018.06.019](https://doi.org/10.1016/j.cell.2018.06.019)
  <details><summary>All 23 authors</summary>

  Zhihao Zheng, J. Scott Lauritzen, Eric Perlman, Camenzind G. Robinson, Matthew Nichols, Daniel Milkie, Omar Torrens, John Price, Corey B. Fisher, Nadiya Sharifi, Steven A. Calle-Schuler, Lucia Kmecova, Iqbal J. Ali, Bill Karsh, Eric T. Trautman, John A. Bogovic, Philipp Hanslovsky, Gregory S.X.E. Jefferis, Michael Kazhdan, Khaled Khairy, Stephan Saalfeld, Richard D. Fetter, Davi D. Bock
  </details>
- Stuart Berg, Isabella R. Beckett, Marta Costa, Philipp Schlegel, Michał Januszewski, Elizabeth C. Marin, Aljoscha Nern, Stephan Preibisch, Wei Qiu, Shin-ya Takemura, … Gregory S.X.E. Jefferis (2026). *Sexual dimorphism in the complete Drosophila male central nervous system connectome*. Cell, 189, 5504-5526.e15. [doi:10.1016/j.cell.2026.08.015](https://doi.org/10.1016/j.cell.2026.08.015)
  <details><summary>All 111 authors</summary>

  Stuart Berg, Isabella R. Beckett, Marta Costa, Philipp Schlegel, Michał Januszewski, Elizabeth C. Marin, Aljoscha Nern, Stephan Preibisch, Wei Qiu, Shin-ya Takemura, Alexandra M.C. Fragniere, Andrew S. Champion, Diane-Yayra Adjavon, Michael Cook, Marina Gkantia, Kenneth J. Hayworth, Gary B. Huang, William T. Katz, Florian Kämpf, Zhiyuan Lu, Christopher Ordish, Tyler Paterson, Tomke Stürner, Eric T. Trautman, Catherine R. Whittle, Laura E. Burnett, Judith Hoeller, Feng Li, Frank Loesche, Billy J. Morris, Tobias Pietzsch, Markus W. Pleijzier, Valeria Silva, Yijie Yin, Iris Ali, Griffin Badalamente, Alexander Shakeel Bates, Rory J. Beresford, John Bogovic, Paul Brooks, Sebastian Cachero, Brandon S. Canino, Bhumpanya Chaisrisawatsuk, Jody Clements, Arthur Crowe, Inês de Haan Vicente, Georgia Dempsey, Erika Donà, Márcia Dos Santos, Marisa Dreher, Christopher R. Dunne, Katharina Eichler, Samantha Finley-May, Miriam A. Flynn, Imran Hameed, Gary Patrick Hopkins, Philip M. Hubbard, Ladann Kiassat, Julie Kovalyak, Shirley A. Lauchie, Meghan Leonard, Alanna Lohff, Kit D. Longden, Charli A. Maldonado, Ilina Moitra, Sung Soo Moon, Caroline Mooney, Eva J. Munnelly, Nneoma Okeoma, Donald J. Olbris, Anika Pai, Birava Patel, Emily M. Phillips, Stephen M. Plaza, Alana Richards, Jennifer Rivas Salinas, Ruairí J.V. Roberts, Edward M. Rogers, Ashley L. Scott, Louis A. Scuderi, Pavithraa Seenivasan, Laia Serratosa Capdevila, Claire Smith, Rob Svirskas, Satoko Takemura, Ibrahim Tastekin, Alexander Thomson, Lowell Umayam, John J. Walsh, Holly Whittome, C. Shan Xu, Emily A. Yakal, Tansy Yang, Arthur Zhao, Reed George, Viren Jain, Vivek Jayaraman, Wyatt Korff, Geoffrey W. Meissner, Sandro Romani, Jan Funke, Christopher Knecht, Stephan Saalfeld, Louis K. Scheffer, Scott Waddell, Gwyneth M. Card, Carlos Ribeiro, Michael B. Reiser, Harald F. Hess, Gerald M. Rubin, Gregory S.X.E. Jefferis
  </details>
- Ibrahim Tastekin, Inês de Haan Vicente, Rory J. Beresford, Billy J. Morris, Isabella Beckett, Philipp Schlegel, Marina Gkantia, Elizabeth C. Marin, Marta Costa, Gregory S.X.E. Jefferis, Carlos Ribeiro (2026). *The complete gustatory connectome of adult Drosophila reveals how taste guides feeding, foraging, and social behavior*. Cell, 189, 5527-5551.e5. [doi:10.1016/j.cell.2026.08.016](https://doi.org/10.1016/j.cell.2026.08.016)
- FlyWire Consortium (2024). *FlyWire Whole-brain Connectome Connectivity Data (materialization v783)*. Zenodo (CC BY 4.0). [doi:10.5281/zenodo.10676866](https://doi.org/10.5281/zenodo.10676866)
- Philipp Schlegel, Gregory S. X. E. Jefferis, and contributors (2026). *flywire_annotations: neuron annotations for the FlyWire 783 release*. GitHub, flyconnectome/flywire_annotations. [https://github.com/flyconnectome/flywire_annotations](https://github.com/flyconnectome/flywire_annotations)

### Whole-brain model this builds on

- Philip K. Shiu, Gabriella R. Sterne, Nico Spiller, Romain Franconville, Andrea Sandoval, Joie Zhou, Neha Simha, Chan Hyuk Kang, Seongbong Yu, Jinseop S. Kim, … Kristin Scott (2024). *A Drosophila computational brain model reveals sensorimotor processing*. Nature, 634, 210-219. [doi:10.1038/s41586-024-07763-9](https://doi.org/10.1038/s41586-024-07763-9)
  <details><summary>All 27 authors</summary>

  Philip K. Shiu, Gabriella R. Sterne, Nico Spiller, Romain Franconville, Andrea Sandoval, Joie Zhou, Neha Simha, Chan Hyuk Kang, Seongbong Yu, Jinseop S. Kim, Sven Dorkenwald, Arie Matsliah, Philipp Schlegel, Szi-chieh Yu, Claire E. McKellar, Amy Sterling, Marta Costa, Katharina Eichler, Alexander Shakeel Bates, Nils Eckstein, Jan Funke, Gregory S. X. E. Jefferis, Mala Murthy, Salil S. Bidaye, Stefanie Hampel, Andrew M. Seeds, Kristin Scott
  </details>
- Philip K. Shiu, Nico Spiller (2023). *Drosophila_brain_model (Connectivity_783.parquet edge list; MIT licence)*. GitHub, philshiu/Drosophila_brain_model. [https://github.com/philshiu/Drosophila_brain_model](https://github.com/philshiu/Drosophila_brain_model)

### Circuits used for behaviour

- Catherine R von Reyn, Patrick Breads, Martin Y Peek, Grace Zhiyu Zheng, W Ryan Williamson, Alyson L Yee, Anthony Leonardo, Gwyneth M Card (2014). *A spike-timing mechanism for action selection*. Nature Neuroscience, 17, 962-970. [doi:10.1038/nn.3741](https://doi.org/10.1038/nn.3741)
- Jan M. Ache, Jason Polsky, Shada Alghailani, Ruchi Parekh, Patrick Breads, Martin Y. Peek, Davi D. Bock, Catherine R. von Reyn, Gwyneth M. Card (2019). *Neural Basis for Looming Size and Velocity Encoding in the Drosophila Giant Fiber Escape Pathway*. Current Biology, 29, 1073-1081.e4. [doi:10.1016/j.cub.2019.01.079](https://doi.org/10.1016/j.cub.2019.01.079)
- Salil S. Bidaye, Christian Machacek, Yang Wu, Barry J. Dickson (2014). *Neuronal Control of Drosophila Walking Direction*. Science, 344, 97-101. [doi:10.1126/science.1249964](https://doi.org/10.1126/science.1249964)
- Salil S. Bidaye, Meghan Laturney, Amy K. Chang, Yuejiang Liu, Till Bockemühl, Ansgar Büschges, Kristin Scott (2020). *Two Brain Pathways Initiate Distinct Forward Walking Programs in Drosophila*. Neuron, 108, 469-485.e8. [doi:10.1016/j.neuron.2020.07.032](https://doi.org/10.1016/j.neuron.2020.07.032)
- Elena A. Westeinde, Emily Kellogg, Paul M. Dawson, Jenny Lu, Lydia Hamburg, Benjamin Midler, Shaul Druckmann, Rachel I. Wilson (2024). *Transforming a head direction signal into a goal-oriented steering command*. Nature, 626, 819-826. [doi:10.1038/s41586-024-07039-2](https://doi.org/10.1038/s41586-024-07039-2)
- Peter Mussells Pires, Lingwei Zhang, Victoria Parache, L. F. Abbott, Gaby Maimon (2024). *Converting an allocentric goal into an egocentric steering signal*. Nature, 626, 808-818. [doi:10.1038/s41586-023-07006-3](https://doi.org/10.1038/s41586-023-07006-3)
- Susanne C. Hoyer, Andreas Eckart, Anthony Herrel, Troy Zars, Susanne A. Fischer, Shannon L. Hardie, Martin Heisenberg (2008). *Octopamine in Male Aggression of Drosophila*. Current Biology, 18, 159-167. [doi:10.1016/j.cub.2007.12.052](https://doi.org/10.1016/j.cub.2007.12.052)
- Chuan Zhou, Yong Rao, Yi Rao (2008). *A subset of octopaminergic neurons are important for Drosophila aggression*. Nature Neuroscience, 11, 1059-1067. [doi:10.1038/nn.2164](https://doi.org/10.1038/nn.2164)

### Game theory

- J. MAYNARD Smith, G. R. Price (1973). *The Logic of Animal Conflict*. Nature, 246, 15-18. [doi:10.1038/246015a0](https://doi.org/10.1038/246015a0)
- John Maynard Smith (1982). *Evolution and the Theory of Games*. Cambridge University Press. [doi:10.1017/CBO9780511806292](https://doi.org/10.1017/CBO9780511806292)
- Peter D. Taylor, Leo B. Jonker (1978). *Evolutionary stable strategies and game dynamics*. Mathematical Biosciences, 40, 145-156. [doi:10.1016/0025-5564(78)90077-9](https://doi.org/10.1016/0025-5564(78)90077-9)
- Josef Hofbauer, Karl Sigmund (1998). *Evolutionary Games and Population Dynamics*. Cambridge University Press. [doi:10.1017/CBO9781139173179](https://doi.org/10.1017/CBO9781139173179)
- John F. Nash (1950). *Equilibrium points in n -person games*. Proceedings of the National Academy of Sciences, 36, 48-49. [doi:10.1073/pnas.36.1.48](https://doi.org/10.1073/pnas.36.1.48)
- Arne Traulsen, Martin A. Nowak, Jorge M. Pacheco (2006). *Stochastic dynamics of invasion and fixation*. Physical Review E, 74. [doi:10.1103/PhysRevE.74.011909](https://doi.org/10.1103/PhysRevE.74.011909)
- Martin A. Nowak, Robert M. May (1992). *Evolutionary games and spatial chaos*. Nature, 359, 826-829. [doi:10.1038/359826a0](https://doi.org/10.1038/359826a0)
- Christoph Hauert, Michael Doebeli (2004). *Spatial structure often inhibits the evolution of cooperation in the snowdrift game*. Nature, 428, 643-646. [doi:10.1038/nature02360](https://doi.org/10.1038/nature02360)
- Erez Lieberman, Christoph Hauert, Martin A. Nowak (2005). *Evolutionary dynamics on graphs*. Nature, 433, 312-316. [doi:10.1038/nature03204](https://doi.org/10.1038/nature03204)
- Hisashi Ohtsuki, Christoph Hauert, Erez Lieberman, Martin A. Nowak (2006). *A simple rule for the evolution of cooperation on graphs and social networks*. Nature, 441, 502-505. [doi:10.1038/nature04605](https://doi.org/10.1038/nature04605)
- W.D. Hamilton (1971). *Geometry for the selfish herd*. Journal of Theoretical Biology, 31, 295-311. [doi:10.1016/0022-5193(71)90189-5](https://doi.org/10.1016/0022-5193(71)90189-5)

### Heuristics

- Peter Hart, Nils Nilsson, Bertram Raphael (1968). *A Formal Basis for the Heuristic Determination of Minimum Cost Paths*. IEEE Transactions on Systems Science and Cybernetics, 4, 100-107. [doi:10.1109/TSSC.1968.300136](https://doi.org/10.1109/TSSC.1968.300136)
- Gerd Gigerenzer, Daniel G. Goldstein (1996). *Reasoning the fast and frugal way: Models of bounded rationality.*. Psychological Review, 103, 650-669. [doi:10.1037/0033-295X.103.4.650](https://doi.org/10.1037/0033-295X.103.4.650)
- Herbert A. Simon (1955). *A Behavioral Model of Rational Choice*. The Quarterly Journal of Economics, 69, 99. [doi:10.2307/1884852](https://doi.org/10.2307/1884852)
- Eric L. Charnov (1976). *Optimal foraging, the marginal value theorem*. Theoretical Population Biology, 9, 129-136. [doi:10.1016/0040-5809(76)90040-X](https://doi.org/10.1016/0040-5809(76)90040-X)
- Craig W. Reynolds (1987). *Flocks, herds and schools: A distributed behavioral model*. ACM SIGGRAPH Computer Graphics, 21, 25-34. [doi:10.1145/37402.37406](https://doi.org/10.1145/37402.37406)

### Graph theory

- E. W. Dijkstra (1959). *A note on two problems in connexion with graphs*. Numerische Mathematik, 1, 269-271. [doi:10.1007/BF01386390](https://doi.org/10.1007/BF01386390)
- Lawrence Page, Sergey Brin, Rajeev Motwani, Terry Winograd (1999). *The PageRank citation ranking: bringing order to the web*. Stanford InfoLab Technical Report 1999-66. [http://ilpubs.stanford.edu:8090/422/](http://ilpubs.stanford.edu:8090/422/)
- Ulrik Brandes (2001). *A faster algorithm for betweenness centrality**. The Journal of Mathematical Sociology, 25, 163-177. [doi:10.1080/0022250X.2001.9990249](https://doi.org/10.1080/0022250X.2001.9990249)
- Duncan J. Watts, Steven H. Strogatz (1998). *Collective dynamics of ‘small-world’ networks*. Nature, 393, 440-442. [doi:10.1038/30918](https://doi.org/10.1038/30918)
- Vincent D Blondel, Jean-Loup Guillaume, Renaud Lambiotte, Etienne Lefebvre (2008). *Fast unfolding of communities in large networks*. Journal of Statistical Mechanics: Theory and Experiment, 2008, P10008. [doi:10.1088/1742-5468/2008/10/P10008](https://doi.org/10.1088/1742-5468/2008/10/P10008)
- M. E. J. Newman, M. Girvan (2004). *Finding and evaluating community structure in networks*. Physical Review E, 69. [doi:10.1103/PhysRevE.69.026113](https://doi.org/10.1103/PhysRevE.69.026113)

### Clustering

- Martin Ester, Hans-Peter Kriegel, Jörg Sander, Xiaowei Xu (1996). *A density-based algorithm for discovering clusters in large spatial databases with noise*. Proceedings of KDD-96, AAAI Press, 226–231. [https://cdn.aaai.org/KDD/1996/KDD96-037.pdf](https://cdn.aaai.org/KDD/1996/KDD96-037.pdf)
- S. Lloyd (1982). *Least squares quantization in PCM*. IEEE Transactions on Information Theory, 28, 129-137. [doi:10.1109/TIT.1982.1056489](https://doi.org/10.1109/TIT.1982.1056489)
- David Arthur, Sergei Vassilvitskii (2007). *k-means++: the advantages of careful seeding*. Proceedings of the 18th ACM-SIAM Symposium on Discrete Algorithms (SODA), 1027–1035. [https://dl.acm.org/doi/10.5555/1283383.1283494](https://dl.acm.org/doi/10.5555/1283383.1283494)
- Daniel Aloise, Amit Deshpande, Pierre Hansen, Preyas Popat (2009). *NP-hardness of Euclidean sum-of-squares clustering*. Machine Learning, 75, 245-248. [doi:10.1007/s10994-009-5103-0](https://doi.org/10.1007/s10994-009-5103-0)

### Software

- Ricardo Cabello (mrdoob), three.js contributors (2010). *three.js — JavaScript 3D library (MIT licence)*. threejs.org. [https://threejs.org](https://threejs.org)
