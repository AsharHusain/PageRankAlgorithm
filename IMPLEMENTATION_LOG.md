# Module III implementation log

- **Baseline (before edits):** Built serial, OpenMP and MPI with `-O2 -std=c11 -Wall -Wextra -pedantic` (plus `-fopenmp` for OpenMP). On `--graph2 --emit-ranks`, serial, OpenMP/2 and MPI/2 produced the same four ranks and converged in 32 iterations. No pre-existing automated tests were found. Earlier three-size outputs were not assumed to match current source.
- **Source:** Preserved damping `0.85`, L1 tolerance `1e-6`, iteration cap `10000`, uniform dangling redistribution, replicated incoming CSR and MPI collective order. Added an explicit N10 graph with dangling and isolated vertices, deterministic N100 case, retained aliases and demos, rejected conflicting selectors, checked allocation arithmetic, graph structure and MPI `int` counts/displacements. Added `N1` and a compile-time cap override for edge-case tests.
- **Tests:** First expanded run: 3 passed, 1 failed, 1 skipped; the failure was a mistaken test expectation for graph 1's out-degree (`[1,1,1,1]` instead of `[2,1,1,1]`). Corrected that test and reran. Final run: **6 passed, 0 failed, 0 skipped**, including N1, all five benchmark sizes, serial/OpenMP/MPI agreement, MPI/1/2/4, 12 ranks on N10, invalid selectors and a one-iteration capped build that checks the actual first update and nonconvergence status. See `outputs/test_results.txt` and `tests/test_pagerank.py`.
- **Benchmark:** Ran `python3 scripts/benchmark.py` locally after building and tests: five graph sizes, one warmup and five successful timed runs per serial/1, OpenMP/1/2/4 and MPI/1/2/4 configuration; **0 failed attempts**. Prior outputs copied to `outputs/archive/20261015T093943446895/`. Active authoritative records are `outputs/*_results.csv`, `outputs/comparison.csv`, `outputs/metadata.txt` and the new plots. The archived `*_benchmarks.csv`, `demos.csv`, and `ranks/` were confirmed byte-for-byte before removing their stale active copies; they should not be mixed with this run.
- **Validation:** `python3 scripts/generate_report.py --self-test`, `--check` and the report-generation command passed. Independent final review found and corrected one MPI/4 efficiency entry and a hard-coded temporary path; all six tests then passed again. A capped MPI/4 N10 first-iteration run was retained in `outputs/n10_first_iteration.txt`. Generated plot and medians derive from current CSV results; no optimization was added without a measured bottleneck. The serial/OpenMP/MPI timings are compute-only and exclude graph construction and process launch.
- **Typed PDF companion:** `python3 scripts/build_submission.py` generated the A4, 12-page `submission/Module_III_PageRank_Mohammed_Ashar_Husain_2024bcs0137.pdf` (and HTML intermediate). PDF text audit confirmed identity, Q6–Q11, serial/MPI source listings, actual recorded N10 output, graph and handwritten-work disclosure; this is not a substitute for the assignment's handwritten originals and hardcopy.

## Reproduce

From this directory with GCC, Open MPI, Python 3 and `rsvg-convert` available:

```sh
gcc -O2 -std=c11 -Wall -Wextra -pedantic c/serial_pagerank.c -o outputs/bin/serial_pagerank
gcc -O2 -std=c11 -Wall -Wextra -pedantic -fopenmp c/openmp_pagerank.c -o outputs/bin/openmp_pagerank
mpicc -O2 -std=c11 -Wall -Wextra -pedantic c/mpi_pagerank.c -o outputs/bin/mpi_pagerank
python3 tests/test_pagerank.py
python3 scripts/benchmark.py
python3 scripts/generate_report.py --check
python3 scripts/generate_report.py
python3 scripts/build_submission.py
```

The benchmark command rebuilds binaries and archives recognized prior outputs before writing new results. Exact timings vary by machine and run; microsecond-scale cases are not reliable scalability evidence. The local folder is not a Git checkout, so no commit or push was made for this work.
