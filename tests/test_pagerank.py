"""Integration tests for the compiled PageRank programs in outputs/bin."""

import csv
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
BINS = ROOT / "outputs" / "bin"
DAMPING = 0.85
RESIDUAL_TOLERANCE = 1e-6
# A few stopping thresholds allow for floating-point reduction order differences.
RANK_TOLERANCE = 5e-6
CASES = {"N10": (10, 11), "N100": (100, None), "N1000": (1000, None),
         "N10000": (10000, None), "N100000": (100000, None)}
N10_EDGES = [(0, 1), (0, 2), (1, 2), (2, 0), (3, 0), (3, 2), (4, 3),
             (4, 5), (6, 7), (7, 8), (8, 6)]
N10_FIRST = [0.1595, 0.0745, 0.202, 0.0745, 0.032, 0.0745, 0.117, 0.117,
             0.117, 0.032]
DEMO_EDGES = [(0, 1), (0, 2), (1, 2), (2, 0), (3, 0), (3, 2), (4, 3), (4, 5)]
GRAPH1_EDGES = [(0, 1), (0, 2), (1, 3), (2, 3), (3, 0)]
GRAPH2_EDGES = [(0, 1), (1, 2), (2, 0), (1, 3)]


def mpi_environment():
    env = os.environ.copy()
    env["OMPI_ALLOW_RUN_AS_ROOT"] = "1"
    env["OMPI_ALLOW_RUN_AS_ROOT_CONFIRM"] = "1"
    env["OMPI_MCA_rmaps_base_oversubscribe"] = "1"
    return env


def graph_edges(n, e):
    if n == 10:
        return N10_EDGES
    # Independent reproduction of the documented collision-free affine generator.
    edges, k = [], 0
    while len(edges) < e:
        pair = ((n + 1) * k + 17) % (n * n)
        src, dst = divmod(pair, n)
        k += 1
        if src != dst:
            edges.append((src, dst))
    return edges


def reference_ranks(n, edges):
    outgoing = [0] * n
    incoming = [[] for _ in range(n)]
    for src, dst in edges:
        outgoing[src] += 1
        incoming[dst].append(src)
    ranks = [1.0 / n] * n
    for _ in range(10000):
        dangling = sum(ranks[v] for v in range(n) if outgoing[v] == 0)
        base = (1 - DAMPING) / n + DAMPING * dangling / n
        updated = [base + DAMPING * sum(ranks[src] / outgoing[src]
                                        for src in incoming[v]) for v in range(n)]
        error = sum(abs(a - b) for a, b in zip(updated, ranks))
        ranks = updated
        if error < RESIDUAL_TOLERANCE:
            return ranks
    raise AssertionError("Python reference did not converge")


def command(implementation, args, workers=1, binary=None):
    binary = binary or BINS / f"{implementation}_pagerank"
    if implementation == "mpi":
        return ["mpirun", "-np", str(workers), str(binary), *args]
    return [str(binary), *args]


def run_program(implementation, args, workers=1, binary=None, max_iterations=False):
    env = mpi_environment() if implementation == "mpi" else os.environ.copy()
    if implementation == "openmp":
        env["OMP_NUM_THREADS"] = str(workers)
        env["OMP_DYNAMIC"] = "FALSE"
    try:
        proc = subprocess.run(command(implementation, args, workers, binary), cwd=ROOT, env=env,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=120, check=False)
    except subprocess.TimeoutExpired as exc:
        raise AssertionError(f"{implementation} timed out for {args} ({workers} workers)") from exc
    expected_returncode = 1 if max_iterations else 0
    if proc.returncode != expected_returncode:
        raise AssertionError(f"command failed ({proc.returncode}): {proc.stderr}")
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if len(lines) != 2:
        raise AssertionError(f"expected result CSV and ranks row, got stdout: {proc.stdout!r}")
    row = next(csv.reader([lines[0]]))
    rank_row = next(csv.reader([lines[1]]))
    if len(row) != 6 or rank_row[0] != "ranks":
        raise AssertionError(f"unexpected CSV output: {proc.stdout!r}")
    n, e, iterations = map(int, row[:3])
    elapsed, status, residual = float(row[3]), row[4], float(row[5])
    ranks = [float(value) for value in rank_row[1:]]
    expected_status = "max_iterations" if max_iterations else "success"
    if status != expected_status or iterations < 1 or not math.isfinite(elapsed) or elapsed < 0:
        raise AssertionError(f"invalid completion fields: {row}")
    if (not math.isfinite(residual) or residual < 0 or
            (not max_iterations and residual >= RESIDUAL_TOLERANCE)):
        raise AssertionError(f"invalid final residual: {residual}")
    if len(ranks) != n or any(not math.isfinite(rank) or rank < 0 for rank in ranks):
        raise AssertionError(f"expected {n} finite nonnegative ranks, got {len(ranks)}")
    if abs(sum(ranks) - 1.0) > 1e-9:
        raise AssertionError(f"rank sum is {sum(ranks):.17g}")
    return n, e, iterations, residual, ranks


class PageRankIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [str(BINS / f"{name}_pagerank") for name in ("serial", "openmp", "mpi")
                   if not (BINS / f"{name}_pagerank").is_file()]
        if missing:
            raise unittest.SkipTest("compiled binaries missing: " + ", ".join(missing))

    def check_case(self, implementation, case, workers=1):
        expected_n, expected_e = CASES[case]
        result = run_program(implementation, ["--case", case, "--emit-ranks"], workers)
        n, e, _, _, ranks = result
        self.assertEqual(n, expected_n)
        if expected_e is not None:
            self.assertEqual(e, expected_e)
        self.assertGreater(e, 0)
        reference = reference_ranks(n, graph_edges(n, e))
        self.assertLessEqual(max(abs(a - b) for a, b in zip(ranks, reference)), RANK_TOLERANCE)
        return result

    def test_n10_first_iteration_reference_and_parallel_agreement(self):
        self.assertEqual(len(N10_EDGES), 11)
        out_degree = [sum(src == v for src, _ in N10_EDGES) for v in range(10)]
        in_degree = [sum(dst == v for _, dst in N10_EDGES) for v in range(10)]
        self.assertEqual(out_degree[5], 0)  # Dangling vertex.
        self.assertEqual((out_degree[9], in_degree[9]), (0, 0))  # Isolated vertex.
        dangling_mass = sum(1 / 10 for degree in out_degree if degree == 0)
        base = (1 - DAMPING) / 10 + DAMPING * dangling_mass / 10
        first = [base + DAMPING * sum(
            (1 / 10) / out_degree[src] for src, dst in N10_EDGES if dst == v)
                 for v in range(10)]
        self.assertEqual([round(rank, 4) for rank in first], N10_FIRST)
        results = [self.check_case("serial", "N10")]
        results += [self.check_case("openmp", "N10", w) for w in (1, 2, 4)]
        results += [self.check_case("mpi", "N10", w) for w in (1, 2, 4)]
        for result in results[1:]:
            self.assertLessEqual(max(abs(a - b) for a, b in zip(results[0][4], result[4])),
                                 RANK_TOLERANCE)

    def test_all_five_sizes_across_implementations(self):
        for case in CASES:
            with self.subTest(case=case):
                serial = self.check_case("serial", case)
                for implementation, workers in (("openmp", 2), ("mpi", 1), ("mpi", 2),
                                                ("mpi", 4)):
                    result = self.check_case(implementation, case, workers)
                    self.assertLessEqual(max(abs(a - b) for a, b in
                                             zip(serial[4], result[4])), RANK_TOLERANCE)

    def test_retained_graphs_dangling_isolated_and_oversubscribed_mpi(self):
        for name, edges, n in (("graph1", GRAPH1_EDGES, 4),
                               ("graph2", GRAPH2_EDGES, 4),
                               ("demo", DEMO_EDGES, 6)):
            with self.subTest(graph=name):
                n_out, e, _, _, ranks = run_program("serial", [f"--{name}", "--emit-ranks"])
                self.assertEqual((n_out, e), (n, len(edges)))
                self.assertLessEqual(max(abs(a - b) for a, b in
                                         zip(ranks, reference_ranks(n, edges))), RANK_TOLERANCE)
        self.assertEqual([sum(src == v for src, _ in GRAPH1_EDGES) for v in range(4)],
                         [2, 1, 1, 1])
        self.assertEqual([sum(src == v for src, _ in GRAPH2_EDGES) for v in range(4)][3], 0)
        self.assertEqual([sum(src == v for src, _ in DEMO_EDGES) for v in range(6)][5], 0)
        parallel = run_program("mpi", ["--demo", "--emit-ranks"], workers=12)
        self.assertEqual((parallel[0], parallel[1]), (6, 8))
        self.assertLessEqual(max(abs(a - b) for a, b in zip(parallel[4],
                             reference_ranks(6, DEMO_EDGES))), RANK_TOLERANCE)

    def test_bad_options_rejected(self):
        for implementation in ("serial", "openmp", "mpi"):
            with self.subTest(implementation=implementation):
                env = mpi_environment() if implementation == "mpi" else os.environ.copy()
                if implementation == "openmp":
                    env["OMP_NUM_THREADS"] = "1"
                for args in (("--case", "invalid"), ("--case", "N10", "--graph1"),
                             ("--case",)):
                    with self.subTest(args=args):
                        proc = subprocess.run(
                            command(implementation, list(args),
                                    workers=2 if implementation == "mpi" else 1),
                            cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=30, check=False)
                        self.assertNotEqual(proc.returncode, 0)

    def test_single_vertex(self):
        for implementation, workers in (("serial", 1), ("openmp", 1), ("mpi", 1),
                                         ("mpi", 4)):
            with self.subTest(implementation=implementation, workers=workers):
                n, e, _, _, ranks = run_program(
                    implementation, ["--case", "N1", "--emit-ranks"], workers)
                self.assertEqual((n, e, ranks), (1, 0, [1.0]))

    def test_one_iteration_builds_emit_first_update_and_max_iterations(self):
        with tempfile.TemporaryDirectory(prefix="pagerank-one-iteration-") as temp:
            tempdir = Path(temp)
            binaries = {}
            for implementation, compiler in (("serial", "gcc"), ("mpi", "mpicc")):
                binary = tempdir / f"{implementation}_pagerank"
                source = ROOT / "c" / f"{implementation}_pagerank.c"
                proc = subprocess.run(
                    [compiler, "-O2", "-std=c11", "-DPR_MAX_ITERATIONS=1",
                     str(source), "-o", str(binary)], cwd=ROOT, text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
                self.assertEqual(proc.returncode, 0, f"compile failed: {proc.stderr}")
                binaries[implementation] = binary

            for implementation, workers in (("serial", 1), ("mpi", 1), ("mpi", 4)):
                with self.subTest(implementation=implementation, workers=workers):
                    n, e, iterations, _, ranks = run_program(
                        implementation, ["--case", "N10", "--emit-ranks"], workers,
                        binary=binaries[implementation], max_iterations=True)
                    self.assertEqual((n, e, iterations), (10, 11, 1))
                    for actual, expected in zip(ranks, N10_FIRST):
                        self.assertAlmostEqual(actual, expected, places=12)


def main():
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PageRankIntegrationTests)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    summary = (f"tests_run={result.testsRun}\nfailures={len(result.failures)}\n"
               f"errors={len(result.errors)}\nskipped={len(result.skipped)}\n"
               f"successful={result.wasSuccessful()}\n")
    output = ROOT / "outputs" / "test_results.txt"
    output.write_text(summary, encoding="utf-8")
    print(f"Machine-readable summary: {output}")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
