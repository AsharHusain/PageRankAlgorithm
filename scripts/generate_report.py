#!/usr/bin/env python3
"""Validate current benchmark artifacts and generate report.md."""

from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path
from statistics import median


ROOT = Path(__file__).resolve().parents[1]
OUTPUTS = ROOT / "outputs"
CASES = (("N10", 10, 11), ("N100", 100, 594), ("N1000", 1_000, 5_994),
         ("N10000", 10_000, 59_995), ("N100000", 100_000, 599_992))
WORKERS = {"serial": (1,), "openmp": (1, 2, 4), "mpi": (1, 2, 4)}
IMPLEMENTATIONS = tuple(WORKERS)
REPETITIONS = 5
SUMMARY_FIELDS = ("elapsed_seconds", "minimum_seconds", "q1_seconds", "q3_seconds",
                  "iqr_seconds", "speedup_vs_serial", "efficiency_vs_serial")


class ReportError(ValueError):
    pass


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise ReportError(f"Required input is missing: {path.relative_to(ROOT)}")
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames:
            raise ReportError(f"CSV has no header: {path.relative_to(ROOT)}")
        return list(reader)


def value(row: dict[str, str], key: str, context: str) -> float:
    try:
        result = float(row[key])
    except (KeyError, TypeError, ValueError) as exc:
        raise ReportError(f"{context}: missing or invalid {key}") from exc
    if not math.isfinite(result):
        raise ReportError(f"{context}: {key} is not finite")
    return result


def percentile(samples: list[float], fraction: float) -> float:
    ordered = sorted(samples)
    position = (len(ordered) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def close(actual: float, expected: float) -> bool:
    return math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-15)


def validate_summary(summary: dict[str, str], readings: list[dict[str, str]], context: str) -> None:
    successful = [row for row in readings if row.get("run_type") == "timed" and row.get("status") == "success"]
    samples = [value(row, "elapsed_seconds", context) for row in successful]
    if len(samples) < REPETITIONS:
        raise ReportError(f"{context}: summary has fewer than {REPETITIONS} successful timed raw readings")
    expected = {"elapsed_seconds": median(samples), "minimum_seconds": min(samples),
                "q1_seconds": percentile(samples, .25), "q3_seconds": percentile(samples, .75)}
    expected["iqr_seconds"] = expected["q3_seconds"] - expected["q1_seconds"]
    for key, calculated in expected.items():
        if not close(value(summary, key, context), calculated):
            raise ReportError(f"{context}: {key} does not match successful timed readings")
    if summary.get("status") != f"{len(samples)} successful timed readings":
        raise ReportError(f"{context}: summary status disagrees with successful raw reading count")


def validate() -> dict:
    source_rows: dict[tuple[str, str, int, str, str], dict[str, str]] = {}
    for impl in IMPLEMENTATIONS:
        rows = read_csv(OUTPUTS / f"{impl}_results.csv")
        for row in rows:
            case = row.get("case", "")
            context = f"{case}/{impl}/{row.get('workers')}/{row.get('run_type')}/{row.get('run')}"
            if case not in dict((case, (n, e)) for case, n, e in CASES) or row.get("implementation") != impl:
                raise ReportError(f"Unexpected result row {context}")
            worker, run_type, run = row.get("workers", ""), row.get("run_type", ""), row.get("run", "")
            if worker not in tuple(map(str, WORKERS[impl])) or run_type not in ("warmup", "timed"):
                raise ReportError(f"Unexpected result configuration {context}")
            key = (case, impl, int(worker), run_type, run)
            if key in source_rows:
                raise ReportError(f"Duplicate result row {context}")
            n, e = dict((name, (vertices, edges)) for name, vertices, edges in CASES)[case]
            if (int(row.get("N", "-1")), int(row.get("E", "-1"))) != (n, e):
                raise ReportError(f"Wrong graph size in {context}")
            if run_type == "timed" and row.get("status") == "success":
                if value(row, "elapsed_seconds", context) < 0:
                    raise ReportError(f"Negative timing in {context}")
                if not row.get("rank_sha256"):
                    raise ReportError(f"Missing rank digest in {context}")
            source_rows[key] = row

    comparison_rows = read_csv(OUTPUTS / "comparison.csv")
    readings: dict[tuple[str, str, int], list[dict[str, str]]] = {}
    summaries: dict[tuple[str, str, int], dict[str, str]] = {}
    for row in comparison_rows:
        try:
            key = (row["case"], row["implementation"], int(row["workers"]))
        except (KeyError, ValueError) as exc:
            raise ReportError("Malformed comparison row key") from exc
        if row.get("row_type") == "reading":
            readings.setdefault(key, []).append(row)
        elif row.get("row_type") == "summary":
            if key in summaries:
                raise ReportError(f"Duplicate comparison summary {key}")
            summaries[key] = row
        else:
            raise ReportError(f"Unknown comparison row_type for {key}")

    medians: dict[tuple[str, str, int], float] = {}
    expected_keys = {(case, impl, worker) for case, _, _ in CASES
                     for impl in IMPLEMENTATIONS for worker in WORKERS[impl]}
    if set(summaries) != expected_keys or set(readings) != expected_keys:
        raise ReportError("comparison.csv has missing or unexpected configurations")
    for key in expected_keys:
        case, impl, worker = key
        context = f"comparison summary {case}/{impl}/{worker}"
        source_config = [row for row in source_rows.values()
                         if row["case"] == case and row["implementation"] == impl
                         and int(row["workers"]) == worker]
        by_run = {(row["run_type"], row["run"]): row for row in source_config}
        comparison_config = readings[key]
        if len(comparison_config) != len(by_run):
            raise ReportError(f"{context}: reading count differs from result CSV")
        for reading in comparison_config:
            source = by_run.get((reading.get("run_type", ""), reading.get("run", "")))
            if source is None:
                raise ReportError(f"{context}: comparison contains a fabricated reading")
            for field in ("N", "E", "iterations", "status", "elapsed_seconds"):
                if reading.get(field) != source.get(field):
                    raise ReportError(f"{context}: comparison reading differs from {field} in result CSV")
        summary = summaries[key]
        validate_summary(summary, comparison_config, context)
        medians[key] = value(summary, "elapsed_seconds", context)

    for case, _, _ in CASES:
        baseline = medians[(case, "serial", 1)]
        for impl in IMPLEMENTATIONS:
            for worker in WORKERS[impl]:
                row = summaries[(case, impl, worker)]
                speedup = baseline / medians[(case, impl, worker)]
                if not close(value(row, "speedup_vs_serial", f"{case}/{impl}/{worker}"), speedup):
                    raise ReportError(f"Speedup mismatch for {case}/{impl}/{worker}")
                if not close(value(row, "efficiency_vs_serial", f"{case}/{impl}/{worker}"), speedup / worker):
                    raise ReportError(f"Efficiency mismatch for {case}/{impl}/{worker}")

    metadata_path = OUTPUTS / "metadata.txt"
    if not metadata_path.is_file():
        raise ReportError("Required input is missing: outputs/metadata.txt")
    metadata = metadata_path.read_text(encoding="utf-8")
    raw_logs = {}
    for impl in IMPLEMENTATIONS:
        path = OUTPUTS / f"{impl}_output.txt"
        if not path.is_file():
            raise ReportError(f"Required raw test log is missing: {path.relative_to(ROOT)}")
        raw_logs[impl] = path.read_text(encoding="utf-8")
    for name in ("comparison.svg", "comparison.png"):
        if not (OUTPUTS / name).is_file():
            raise ReportError(f"Benchmark plot is missing: outputs/{name}")
    return {"medians": medians, "metadata": metadata, "raw_logs": raw_logs,
            "summaries": summaries}


def render(data: dict) -> str:
    medians = data["medians"]
    metadata = data["metadata"]
    md = ["# PageRank benchmark report", "",
          "## Module I — Serial PageRank context", "",
          "PageRank iteratively distributes rank through incoming edges. With incoming CSR, each iteration "
          "scans vertices and edges, giving O(N + E) work and O(N + E) graph storage. The benchmark uses "
          "the five graph cases below; each listed timing is derived from successful timed result rows, "
          "excluding warmups.", "",
          "| Case | N | E | Serial median (s) |", "|---|---:|---:|---:|"]
    for case, n, e in CASES:
        md.append(f"| {case} | {n:,} | {e:,} | {medians[(case, 'serial', 1)]:.8g} |")
    md += ["", "## Module III — MPI", "", "### Q6. Foster PCAM", "",
           "Partition destination vertices among processes. Communicate global dangling mass, new rank "
           "values, and convergence error through collective reductions and an all-gather. Agglomerate each "
           "process's destination range into one work unit; map those ranges to MPI processes. This describes "
           "the algorithmic model; implementation details should be checked against the current source.", "",
           "### Q7. Execution outline", "",
           "Initialize the graph and ranks, repeatedly reduce dangling mass, update owned destinations, "
           "exchange the new vector, reduce convergence error, then stop at convergence. Timing summaries "
           "below come from the benchmark comparison data.", "",
           "### Q8. Benchmark configurations", "",
           "The benchmark suite exercises N10, N100, N1000, N10000, and N100000. Per-configuration "
           "summaries require at least five successful timed readings; warmups and unsuccessful attempts "
           "are not used in summary statistics.", "",
           "### Q9. MPI results", "",
           "| Case | Serial (s) | MPI/1 (s) | MPI/2 (s) | MPI/4 (s) |", "|---|---:|---:|---:|---:|"]
    for case, _, _ in CASES:
        md.append("| " + case + " | " + " | ".join(
            f"{medians[(case, impl, worker)]:.8g}" for impl, worker in
            (("serial", 1), ("mpi", 1), ("mpi", 2), ("mpi", 4))) + " |")
    md += ["", "### Q10. Complexity", "",
           "For N vertices, E edges, I iterations, and P processes, balanced local update work is "
           "approximately O(I(N + E)/P); collective costs and load imbalance add overhead. Confirm exact "
           "memory distribution and collectives against the implementation before making source-specific claims.", "",
           "### Q11. Timing, speedup and efficiency", "",
           "Elapsed time is the benchmark's application-reported compute time. Speedup is serial median / "
           "configuration median; efficiency is speedup / worker count. The SVG and PNG are produced by "
           "scripts/benchmark.py and are referenced, not redrawn here.", "",
           "| Case | OMP/1 | OMP/2 | OMP/4 | MPI/1 | MPI/2 | MPI/4 |", "|---|---:|---:|---:|---:|---:|---:|"]
    for case, _, _ in CASES:
        baseline = medians[(case, "serial", 1)]
        values = [f"{baseline / medians[(case, impl, worker)]:.3f}× / "
                  f"{baseline / medians[(case, impl, worker)] / worker:.3f}"
                  for impl, worker in (("openmp", 1), ("openmp", 2), ("openmp", 4),
                                       ("mpi", 1), ("mpi", 2), ("mpi", 4))]
        md.append(f"| {case} | " + " | ".join(values) + " |")
    md += ["", "![Benchmark median runtime](outputs/comparison.svg)", "",
           "![Benchmark median runtime PNG](outputs/comparison.png)", "",
           "### Provenance", "", "```text", metadata.rstrip(), "```", "",
           "Validated inputs: per-implementation `*_results.csv`, `comparison.csv`, `metadata.txt`, and "
           "the benchmark's raw `*_output.txt` smoke-test logs. Summary statistics are recomputed from "
           "successful timed readings; no timing or machine values are embedded in this generator.", ""]
    return "\n".join(md)


def self_test() -> None:
    readings = [{"run_type": "timed", "status": "success", "elapsed_seconds": str(x)}
                for x in (1, 2, 3, 4, 5)]
    summary = {"elapsed_seconds": "3", "minimum_seconds": "1", "q1_seconds": "2",
               "q3_seconds": "4", "iqr_seconds": "2", "status": "5 successful timed readings"}
    validate_summary(summary, readings, "synthetic self-test")
    summary["elapsed_seconds"] = "99"
    try:
        validate_summary(summary, readings, "synthetic self-test")
    except ReportError:
        return
    raise AssertionError("summary validator accepted fabricated timing")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run summary-schema checks on synthetic data")
    parser.add_argument("--check", action="store_true", help="validate artifacts without writing report.md")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("Schema self-test passed")
        return
    report = render(validate())
    if not args.check:
        (ROOT / "report.md").write_text(report, encoding="utf-8")
        print("Generated report.md")
    else:
        print("Benchmark artifacts validated; report.md not written")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"report generation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
