# Claude brief: update the existing PageRank presentation with MPI

## Task and constraints

Update `PageRank_Algorithm_Redesign_Full_Page_Table (1).pptx`, but do **not** overwrite it. Save the completed presentation as `PageRank_Algorithm_Redesign_Full_Page_Table_MPI.pptx` in the project folder (choose another clearly named new copy if that already exists). Do not edit source code or this brief. This brief is the content authority for current implementation and measurements.

Preserve the deck's visual identity, useful visuals, title treatment, and original credits (Niranjan R Soorej · 2024BCS0117; Mohammed Ashar Husain · 2024BCS0137). Revise misleading slide copy and speaker notes. Tell a coherent story in this order: **serial algorithm → OpenMP shared-memory parallelization → MPI distributed-process design → measured comparison/caveats**. Insert slides as needed. Do not cram full source listings onto slides; use short verbatim excerpts in readable monospace, cite source paths on slides/notes, and move explanations/provenance into notes. Keep slide content readable.

## Technical truth and source facts

The code uses damping `d=0.85`, tolerance `ε=1e-6`, maximum 10,000 iterations; initial ranks are `1/N`. Incoming adjacency is CSR (`in_offsets`, `in_sources`) plus per-source out-degree. Serial, OpenMP and MPI each use two full rank vectors. A dangling node has out-degree zero; its rank mass is redistributed uniformly every iteration. The update is:

```text
D = Σ rank[j] for outdeg(j)=0
base = (1-d)/N + d*D/N
newPR[i] = base + d * Σ(rank[j]/outdeg(j)) for each edge j → i
error = Σ |newPR[i]-PR[i]|; PR = newPR
stop when error < ε, or at the iteration cap
```

Serial per-iteration work `O(N+E)`, total `O(I(N+E))`, storage `O(N+E)`. One iteration's destination updates are independent after dangling mass is known, but iterations are sequential. Per-destination work varies with in-degree; do not suggest equal node work.

### Original worked examples, confirmed against `c/shared_graph.h`

Keep original slide 8's no-dangling case (`--graph1`): nodes 0..3; edges `0→1, 0→2, 1→3, 2→3, 3→0`; out-degrees `(2,1,1,1)`. Start `(0.25,0.25,0.25,0.25)`. Iteration 1 `(0.2500,0.14375,0.14375,0.4625)`, error `0.4250`; iteration 2 approximately `(0.4306,0.1438,0.1438,0.2819)`, error `0.3613`; converges in 81 iterations to approximately `(0.3202,0.1736,0.1736,0.3326)`.

Keep original slide 9's dangling case (`--graph2`): edges `0→1, 1→2, 2→0, 1→3`; node 3 dangling; out-degrees `(1,2,1,0)`. Iteration 1 approximately `(0.303125,0.303125,0.196875,0.196875)`, error `0.2125`; iteration 2 `(0.2467,0.3370,0.2082,0.2082)`, error `0.1129`; converges in 32 iterations to `(0.2646,0.3079,0.2138,0.2138)`. The dangling contribution is `d*D/N` in addition to teleportation `(1-d)/N`. Keep slide display rounded to 4 decimals. Clarify iteration-state labels if currently ambiguous. Do not say parallel results “match exactly”; say they agree within tolerance.

### Serial and OpenMP excerpts and explanation

Use short verbatim excerpts, not whole listings. Serial source is `c/serial_pagerank.c`; shared constants/graph are `c/shared_graph.h`.

```c
const double base = (1.0 - PR_DAMPING) / (double)graph.n +
                    PR_DAMPING * dangling / (double)graph.n;
for (size_t v = 0; v < graph.n; ++v) {
    double incoming = 0.0;
    for (size_t p = graph.in_offsets[v]; p < graph.in_offsets[v + 1]; ++p) {
        const size_t src = (size_t)graph.in_sources[p];
        incoming += rank[src] / (double)graph.out_degree[src];
    }
    next[v] = base + PR_DAMPING * incoming;
    error += next[v] >= rank[v] ? next[v] - rank[v] : rank[v] - next[v];
}
```

Serial pseudocode (show as a flow, not one giant slide):

```text
rank[:] = 1/N
for iteration = 1..10000:
    dangling = sum(rank[v] where outdegree[v] == 0)
    base = (1-0.85)/N + 0.85*dangling/N
    for destination v = 0..N-1:
        next[v] = base + 0.85*sum(rank[src]/outdegree[src]
                                   for src in incoming[v])
    error = sum(abs(next[v]-rank[v]) for v = 0..N-1)
    swap(rank, next)
    if error < 1e-6: break
```

OpenMP source `c/openmp_pagerank.c`: shared graph/rank buffers, statically scheduled destination loop, reductions for dangling mass and error, implicit loop barriers before swap/next iteration. No atomic/critical update is used.

```c
#pragma omp parallel for reduction(+:dangling) schedule(static)
for (size_t v = 0; v < graph.n; ++v)
    if (graph.out_degree[v] == 0) dangling += rank[v];
...
#pragma omp parallel for schedule(static)
for (size_t v = 0; v < graph.n; ++v) {
    double incoming = 0.0;
    for (size_t p = graph.in_offsets[v]; p < graph.in_offsets[v + 1]; ++p) {
        const size_t src = (size_t)graph.in_sources[p];
        incoming += rank[src] / (double)graph.out_degree[src];
    }
    next[v] = base + PR_DAMPING * incoming;
}
#pragma omp parallel for reduction(+:error) schedule(static)
for (size_t v = 0; v < graph.n; ++v)
    error += next[v] >= rank[v] ? next[v] - rank[v] : rank[v] - next[v];
```

OpenMP pseudocode: in each iteration, `parallel_for reduction(+:dangling)` over vertices → compute base → `parallel_for schedule(static)` over destinations → `parallel_for reduction(+:error)` over vertices → swap/branch. Distinguish shared-memory threads and reductions from MPI's separate address spaces.

### MPI PCAM, communication sequence, memory

* **Partitioning:** contiguous destination ranges; rank `r` of `P`: `begin=floor(N*r/P)`, `end=floor(N*(r+1)/P)`. Only owned destinations updated; graph and rank vectors are not partitioned.
* **Communication:** global dangling sum, all new destination rank values so every process has the full vector, global L1 error; a final max-time reduction.
* **Agglomeration:** one contiguous range per process per iteration, not one task per node.
* **Mapping:** range `r` maps to MPI process `r` in `MPI_COMM_WORLD`.

Exact per-iteration collective order (all ranks call in the same order): (1) sum dangling rank over owned vertices; `MPI_Allreduce(... MPI_SUM ...)`; (2) compute owned destinations into `local_values`; (3) `MPI_Allgatherv` these ranges into the full `next` on every rank; (4) sum local absolute error and `MPI_Allreduce(... MPI_SUM ...)`; (5) swap full rank buffers and test common global error. The post-loop `MPI_Reduce(... MPI_MAX ...)` reports maximum elapsed time to rank 0; it is not part of the iteration. Timer starts after graph construction/allocations and barrier.

Verbatim source excerpts from `c/mpi_pagerank.c`:

```c
begin = graph.n * (size_t)rank_id / (size_t)world_size;
end = graph.n * (size_t)(rank_id + 1) / (size_t)world_size;
local_n = end - begin;
```

The following independent excerpts omit intervening update/error loops (`...` marks omission, not source code):

```c
if (MPI_Allreduce(&local_dangling, &dangling, 1, MPI_DOUBLE, MPI_SUM, MPI_COMM_WORLD) != MPI_SUCCESS)
    MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
...
if (MPI_Allgatherv(local_values, (int)local_n, MPI_DOUBLE, next, counts,
                   displacements, MPI_DOUBLE, MPI_COMM_WORLD) != MPI_SUCCESS)
    MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
...
if (MPI_Allreduce(&local_error, &error, 1, MPI_DOUBLE, MPI_SUM, MPI_COMM_WORLD) != MPI_SUCCESS)
    MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
...
if (MPI_Reduce(&local_elapsed, &elapsed, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD) != MPI_SUCCESS)
    MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
```

Use exact calls/order if splitting across slides. Do not imply `MPI_Scatter` or graph partitioning. `counts[p]=floor(N*(p+1)/P)-floor(N*p/P)`, `displacements[p]=floor(N*p/P)`.

MPI pseudocode (all ranks execute the same iteration/collective sequence):

```text
build identical graph on every process; rank[:] = 1/N
own destinations [floor(N*r/P), floor(N*(r+1)/P))
for iteration = 1..10000:
    local_dangling = sum(rank[v] for owned dangling vertices)
    dangling = Allreduce_SUM(local_dangling)
    base = (1-0.85)/N + 0.85*dangling/N
    for owned destination v:
        local_values[v-begin] = base + 0.85*sum(rank[src]/outdegree[src]
                                                 for src in incoming[v])
    next[:] = Allgatherv(local_values, counts, displacements)
    local_error = sum(abs(next[v]-rank[v]) for owned v)
    error = Allreduce_SUM(local_error)
    swap(rank, next)
    if error < 1e-6: break
elapsed = Reduce_MAX(local_elapsed) to process 0
```

Each MPI process independently constructs/stores the same full incoming CSR graph and out-degrees, plus two full N-element rank vectors. It also allocates `local_values[local_n]` and counts/displacements of length P. Thus memory per rank is `O(N+E)` plus local temporary/metadata; memory is replicated, not divided by P. Balanced update work is approximately `O(I(N+E)/P)` but collectives, synchronization, in-degree imbalance and all-gather traffic add costs. Do not make unsupported wall-time complexity claims.

### MPI diagram requirement: N=10, P=4

Draw IDs `0 1 2 3 4 5 6 7 8 9` in a strip split into: rank 0 `[0,2)` `{0,1}` (2 values); rank 1 `[2,5)` `{2,3,4}` (3); rank 2 `[5,7)` `{5,6}` (2); rank 3 `[7,10)` `{7,8,9}` (3). Show each rank's **replicated** full graph and old `rank[0..9]`; highlight only its owned destination slots being computed. Arrows from `local_values` to `MPI_Allgatherv` should produce full `next[0..9]` on all ranks; show dangling and error `MPI_Allreduce SUM`. Label these vector collectives, not graph movement. N10 is an explicit 11-edge fixture (`pr_graph_n10` in `c/shared_graph.h`); do not confuse it with four-node graph1/graph2.

## Current measured results (medians, seconds)

Five benchmark cases only: N10, N100, N1000, N10000, N100000. One warmup plus five successful timed runs per configuration. All figures below are current `outputs/comparison.csv` / `report.md`; do not reuse original deck performance tables as current.

| Case | N | E | Serial | MPI/1 | MPI/2 | MPI/4 |
|---|---:|---:|---:|---:|---:|---:|
| N10 | 10 | 11 | 0.000001587 | 0.000021303 | 0.000064743 | 0.000138717 |
| N100 | 100 | 594 | 0.000087861 | 0.000066340 | 0.000116308 | 0.000284884 |
| N1000 | 1,000 | 5,994 | 0.000441013 | 0.000296401 | 0.000256088 | 0.000350771 |
| N10000 | 10,000 | 59,995 | 0.001829857 | 0.001930254 | 0.001254603 | 0.001029242 |
| N100000 | 100,000 | 599,992 | 0.009252197 | 0.011137435 | 0.006543447 | 0.005660108 |

| Case | Serial median (s) | OMP/1 (s) | OMP/2 (s) | OMP/4 (s) | OMP/1 speedup | OMP/2 speedup | OMP/4 speedup |
|---|---:|---:|---:|---:|---:|---:|---:|
| N10 | 0.000001587 | 0.000021826 | 0.000423999 | 0.000554799 | 0.073× | 0.004× | 0.003× |
| N100 | 0.000087861 | 0.000113111 | 0.000875877 | 0.001007639 | 0.777× | 0.100× | 0.087× |
| N1000 | 0.000441013 | 0.000734089 | 0.001095093 | 0.001008721 | 0.601× | 0.403× | 0.437× |
| N10000 | 0.001829857 | 0.001853137 | 0.002191127 | 0.001990820 | 0.987× | 0.835× | 0.919× |
| N100000 | 0.009252197 | 0.010537474 | 0.007144673 | 0.008243165 | 0.878× | 1.295× | 1.122× |

| Case | MPI/1 speedup | MPI/2 speedup | MPI/4 speedup |
|---|---:|---:|---:|
| N10 | 0.074× | 0.025× | 0.011× |
| N100 | 1.324× | 0.755× | 0.308× |
| N1000 | 1.488× | 1.722× | 1.257× |
| N10000 | 0.948× | 1.459× | 1.778× |
| N100000 | 0.831× | 1.414× | 1.635× |

Formulae: `speedup(P)=serial median / parallel median(P)`; `efficiency(P)=speedup(P)/P × 100%`. Highlight N100000: MPI/4 `1.635×`, `40.9%`; OpenMP/2 `1.295×`, `64.7%`; OpenMP/4 `1.122×`, `28.1%`. Optionally N10000 MPI/4 `1.778×`. Small graphs can be slower with parallel overhead; increased workers do not always improve runtime. Do not imply MPI universally wins.

For a full speedup **and** efficiency comparison, include this compact pair table or equivalent (each cell is `speedup× / efficiency%`; values from `report.md` / `outputs/comparison.csv`):

| Case | OMP/1 | OMP/2 | OMP/4 | MPI/1 | MPI/2 | MPI/4 |
|---|---:|---:|---:|---:|---:|---:|
| N10 | 0.073× / 7.3% | 0.004× / 0.2% | 0.003× / 0.1% | 0.074× / 7.4% | 0.025× / 1.2% | 0.011× / 0.3% |
| N100 | 0.777× / 77.7% | 0.100× / 5.0% | 0.087× / 2.2% | 1.324× / 132.4% | 0.755× / 37.8% | 0.308× / 7.7% |
| N1000 | 0.601× / 60.1% | 0.403× / 20.1% | 0.437× / 10.9% | 1.488× / 148.8% | 1.722× / 86.1% | 1.257× / 31.4% |
| N10000 | 0.987× / 98.7% | 0.835× / 41.8% | 0.919× / 23.0% | 0.948× / 94.8% | 1.459× / 72.9% | 1.778× / 44.4% |
| N100000 | 0.878× / 87.8% | 1.295× / 64.7% | 1.122× / 28.1% | 0.831× / 83.1% | 1.414× / 70.7% | 1.635× / 40.9% |

Methodology/notes: single Intel Core Ultra 9 185H host, Linux x86_64, 22 logical CPUs available; GCC 16.2.1 and Open MPI 5.0.10. OpenMP 1/2/4 threads; MPI 1/2/4 processes. Build flags `-O2 -std=c11 -Wall -Wextra -pedantic`, OpenMP adds `-fopenmp`. One warmup and five successful timed runs/configuration (up to 10 attempts); displayed values are medians. Timing is application-reported compute time: graph creation and process startup excluded; MPI reports maximum rank elapsed. This is single-host evidence, **not cluster scaling**. `outputs/comparison.svg` is the current plot; exact data in `outputs/comparison.csv`, host/compiler details in `outputs/metadata.txt`.

Correctness checks: finite ranks, rank sum within `1e-8`, final L1 residual `<1e-6`, benchmark maximum rank delta against serial `<=1e-8` (demo `<=1e-10`). Reduction order may change floating point; iteration counts can differ; compare rank vectors within tolerance. Integration results: 6 tests, 0 failures, 0 errors, 0 skipped (`outputs/test_results.txt`). Suite covers the five benchmark cases across serial/OpenMP/MPI, output/ranks, N10 edges and one-step vector, N1 across serial/OpenMP/MPI (including MPI/4), invalid selectors, and an independent Python reference. Test per-rank tolerance is `5e-6`; residual must still be `<1e-6`. N1 is tested but is not a timed benchmark case.

## Original deck inventory and precise action per slide

Final order must be serial first, examples, OpenMP, MPI additions, performance, conclusion. Move original slide 7's OpenMP PCAM material after serial/examples. The entries below refer to original slide numbers.

| Original | Action | Exact guidance |
|---|---|---|
| 1 | EDIT/KEEP | Preserve title identity and both credits. Subtitle signals serial → OpenMP → MPI. Fix broken “PageRan k / Algorith m” wrapping. |
| 2 | EDIT/KEEP | Keep links-as-votes intuition and damping; simplify crowded text; retain d=.85. |
| 3 | REPLACE | Roadmap becomes serial → worked examples → OpenMP → MPI design → results → conclusion. |
| 4 | EDIT/KEEP | Preserve graph/objective visual. Qualify “any link structure”; PageRank is an importance signal, not a complete ranking. |
| 5 | EDIT/KEEP | Qualify “any graph”: teleportation supports convergence under the standard model; distinguish teleportation from dangling redistribution. Avoid categorical guarantee without assumptions. |
| 6 | EDIT/KEEP | Accurate serial recurrence/pseudocode including dangling sum, base, L1 error, swap, tolerance/cap. Cite `c/serial_pagerank.c`, `c/shared_graph.h`. |
| 7 | MOVE + EDIT | Move after serial. OpenMP transition/PCAM and shared-memory static ranges; explain work varies with in-degree. Not MPI. |
| 8 | EDIT/KEEP | Retain graph1, no dangling, 81 iterations, checked vectors/edges above. Clarify state numbering. |
| 9 | EDIT/KEEP | Retain graph2, dangling node, 32 iterations; correct `d*D/N` contribution and vectors above. |
| 10 | REPLACE | Delete old serial timing values, including suggested million/10-million rows. Replace with current five-case serial median baseline. |
| 11 | EDIT/KEEP | Preserve independent-node insight; clarify incoming-edge/in-degree variation; shared current vector/graph, distinct next, reductions/barrier. |
| 12 | EDIT/KEEP | Keep OpenMP pseudocode/excerpt; “within tolerance”, not “identical”; graph2 32-iteration result may remain. Cite source. |
| 13 | REMOVE from main deck; optional historical appendix | Separate old N=10,000/4-thread/55,000-edge/epsilon=1e-8/8-iteration run, not current five-case benchmark. Internally contradictory (“fastest observed” labels conflict). Do not reuse/blend. Prefer remove. If retained for provenance, label historical, unverified, non-comparable and note contradictions. |
| 14 | REPLACE | Remove stale/unverified six-size OpenMP table (N=5, 1M, 10M, 8/16-thread results). Use current five-case measurements. Keep speedup/efficiency definitions only. |
| 15 | EDIT/KEEP | Conclusion covers all three paradigms, tolerance correctness, replicated MPI memory and conditional measured scaling. Replace “match exactly”; don't claim universal speedup or unsupported causes. |
| 16 | EDIT/KEEP | Retain Graph ML relevance, PageRank as one feature/signal, not a full decision system. |
| 17 | KEEP | Preserve thank-you slide/treatment. |

### Insert after revised original slide 12

Insert six focused slides (or equivalent) before performance/conclusion:

1. **MPI: same recurrence, different memory model.** “The rank equation does not change. Each MPI process has a private address space. Every process stores the same graph and full rank vector; processes own different destination ranges.” Contrast OpenMP shared memory with MPI processes. Notes explain no shared-memory writes: gather targets distinct `next`.
2. **PCAM: destination vertices to ranks.** Four PCAM points above; show formulas and N=10/P=4 ownership. Note floor ranges differ by at most one vertex; P>N can produce empty ranges but is not benchmarked.
3. **Collectives are the communication plan.** Ordered swimlane: local dangling → Allreduce SUM → owned updates → Allgatherv full next → local L1 → Allreduce SUM → swap/common stop. Add post-loop Reduce MAX to rank 0. All ranks call collectives in identical order.
4. **N=10 on four ranks: who owns what?** Follow exact diagram specification above. Replicated graph/full old rank versus partitioned destination ownership must be visually unmistakable.
5. **MPI pseudocode and real C.** Pseudocode matches exact sequence. Short source excerpts for partition, dangling Allreduce, Allgatherv, error Allreduce and final Reduce, if legible. Cite `c/mpi_pagerank.c`; helper/constants/CSR `c/shared_graph.h`; never show all 112 lines.
6. **What is distributed—and what is not?** Idealized `O(I(N+E)/P)` update work plus collectives/synchronization/imbalance; `O(N+E)` graph and two rank vectors per rank; memory is replicated, not divided. Explain CSR and in-degree variation.

Replace original slide 14 with current comparison. Prefer a legible plot/table for five cases and serial/OpenMP/MPI 1/2/4 configurations; split runtime and speedup/efficiency into two slides if crowded. Do not cherry-pick the display or distort axes. Include units, median, worker type/count and footnote about timing scope.

## Build/run commands and references

Commands matching project docs/source:

```sh
gcc -O2 -std=c11 -Wall -Wextra -pedantic c/serial_pagerank.c -o outputs/bin/serial_pagerank
gcc -O2 -std=c11 -Wall -Wextra -pedantic -fopenmp c/openmp_pagerank.c -o outputs/bin/openmp_pagerank
mpicc -O2 -std=c11 -Wall -Wextra -pedantic c/mpi_pagerank.c -o outputs/bin/mpi_pagerank
./outputs/bin/serial_pagerank --case N1000
OMP_NUM_THREADS=4 OMP_DYNAMIC=FALSE ./outputs/bin/openmp_pagerank --case N1000
mpirun -np 4 ./outputs/bin/mpi_pagerank --case N1000
mpirun -np 4 ./outputs/bin/mpi_pagerank --graph1 --emit-ranks
mpirun -np 4 ./outputs/bin/mpi_pagerank --graph2 --emit-ranks
python3 scripts/benchmark.py
python3 tests/test_pagerank.py
```

Selectors: `--demo`, `--graph1`, `--graph2`, `--case N1|N10|N100|N1000|N10000|N100000|small|medium|large`, optional `--emit-ranks`. N1 is tested but is not a benchmark case. Large `--emit-ranks` can be verbose.

Name/link these project references in slide footers/notes: `c/serial_pagerank.c`, `c/openmp_pagerank.c`, `c/mpi_pagerank.c`, `c/shared_graph.h`, `report.md`, `outputs/comparison.csv`, `outputs/comparison.svg`, `outputs/metadata.txt`, `tests/test_pagerank.py`, `outputs/test_results.txt`. Original worked examples are `--graph1`/`--graph2`; benchmark N10 is a different explicit 10-node, 11-edge fixture.

## Notes and final consistency checklist

Use speaker notes for derivations, exact measurement provenance, source locations, why reductions/collectives exist, independently constructed MPI graph, and nuance that single-host evidence is not cluster scale. Replace old notes as well as on-slide claims. In particular, remove stale slide 10 serial timings, quarantine/remove contradictory old slide 13 synchronization measurements, remove stale/unverified slide 14 six-size results, qualify slide 5 “any graph”, explain varying per-node work, and replace “match exactly” with tolerance language.

Before saving the new PPTX, check final narrative order serial → OpenMP → MPI → comparison, updated numbering/references, no historical timing presented as current, all tables labeled seconds/medians/workers, code and collective order exact, graph examples aligned with source, and original PPTX untouched. Avoid cluster-scale claims. Preserve original credits.
