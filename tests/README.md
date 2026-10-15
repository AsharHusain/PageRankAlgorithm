# PageRank integration tests

Build the three binaries expected by the suite, then run it from the repository
root:

```sh
mkdir -p outputs/bin
gcc -O2 -std=c11 -Wall -Wextra -pedantic c/serial_pagerank.c -o outputs/bin/serial_pagerank
gcc -O2 -std=c11 -Wall -Wextra -pedantic -fopenmp c/openmp_pagerank.c -o outputs/bin/openmp_pagerank
mpicc -O2 -std=c11 -Wall -Wextra -pedantic c/mpi_pagerank.c -o outputs/bin/mpi_pagerank
python3 tests/test_pagerank.py
```

The runner tests `N10`, `N100`, `N1000`, `N10000`, and `N100000` across
serial/OpenMP/MPI, validates result and `ranks` CSV rows, checks N10's fixed
edges and one-step vector, and compares implementations against an independent
Python PageRank reference. The per-rank tolerance is `5e-6` (five times the
`1e-6` stopping threshold) to allow floating-point summation-order differences;
the reported final L1 residual itself must remain below `1e-6`. MPI runs set
Open MPI's root/oversubscription environment options and have 120-second
timeouts. The suite writes its machine-readable test counts to
`outputs/test_results.txt` when invoked. Single-vertex coverage is explicitly
skipped because the source contract has no one-vertex graph option.
