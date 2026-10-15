#!/usr/bin/env python3
"""Compile, validate, and benchmark the PageRank implementations."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import platform
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "c"
OUTPUTS = ROOT / "outputs"
BINDIR = OUTPUTS / "bin"
CASE_SPECS = (("N10", 10, 11), ("N100", 100, 594),
              ("N1000", 1_000, 5_994), ("N10000", 10_000, 59_995),
              ("N100000", 100_000, 599_992))
DEMOS = (("graph1", ("--graph1",), 4, 5),
         ("graph2", ("--graph2",), 4, 4),
         ("demo", ("--demo",), 6, 8))
WORKERS = {"serial": (1,), "openmp": (1, 2, 4), "mpi": (1, 2, 4)}
REPETITIONS = 5
MAX_ATTEMPTS = 10
RANK_SUM_TOLERANCE = 1e-8
BENCHMARK_RANK_DELTA_TOLERANCE = 1e-8
DEMO_RANK_DELTA_TOLERANCE = 1e-10
ERROR_TOLERANCE = 1e-6


def run(command: list[str], *, env: dict[str, str] | None = None,
        timeout: int = 1800) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=ROOT, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout)
    if result.returncode:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(command)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def compiler_info(command: list[str]) -> str:
    lines = run(command).stdout.splitlines()
    return lines[0] if lines else "unknown"


def parse_result(output: str) -> tuple[int, int, int, float, str, float, tuple[float, ...]]:
    lines = output.splitlines()
    if not lines:
        raise ValueError("Empty application output")
    fields = lines[0].split(",")
    if len(fields) != 6:
        raise ValueError(f"Expected six result columns (N,E,I,time,status,error): {lines[0]!r}")
    n, e, iterations = map(int, fields[:3])
    elapsed = float(fields[3])
    status = fields[4]
    final_error = float(fields[5])
    rank_lines = [line for line in lines[1:] if line.startswith("ranks,")]
    if len(rank_lines) != 1:
        raise ValueError(f"Expected exactly one ranks line: {output!r}")
    rank_fields = rank_lines[0].split(",")
    if rank_fields[0] != "ranks":
        raise ValueError(f"Unexpected rank line: {rank_lines[0]!r}")
    ranks = tuple(map(float, rank_fields[1:]))
    if n <= 0 or e < 0 or iterations <= 0:
        raise ValueError(f"Invalid N, E, or iteration count: {lines[0]!r}")
    if not math.isfinite(elapsed) or elapsed < 0:
        raise ValueError(f"Invalid computation time: {fields[3]!r}")
    if not math.isfinite(final_error):
        raise ValueError(f"Invalid final L1 error: {fields[5]!r}")
    if len(ranks) != n or any(not math.isfinite(value) for value in ranks):
        raise ValueError(f"Expected {n} finite ranks, got {len(ranks)}")
    if abs(sum(ranks) - 1.0) > RANK_SUM_TOLERANCE:
        raise ValueError(f"Rank sum {sum(ranks):.17g} is outside tolerance")
    if final_error >= ERROR_TOLERANCE:
        raise ValueError(f"Final L1 error {final_error:.17g} is not below {ERROR_TOLERANCE}")
    if status != "success":
        raise ValueError(f"Application status is {status!r}, not 'success'")
    return n, e, iterations, elapsed, status, final_error, ranks


def mpi_env() -> dict[str, str]:
    env = os.environ.copy()
    if os.geteuid() == 0:
        env["OMPI_ALLOW_RUN_AS_ROOT"] = "1"
        env["OMPI_ALLOW_RUN_AS_ROOT_CONFIRM"] = "1"
    return env


def make_command(impl: str, workers: int, args: list[str]) -> tuple[list[str], dict[str, str] | None]:
    if impl == "serial":
        return [str(BINDIR / "serial_pagerank"), *args], None
    if impl == "openmp":
        env = os.environ.copy()
        env["OMP_NUM_THREADS"] = str(workers)
        env["OMP_DYNAMIC"] = "FALSE"
        return [str(BINDIR / "openmp_pagerank"), *args], env
    env = mpi_env()
    return ["mpirun", "-np", str(workers), str(BINDIR / "mpi_pagerank"), *args], env


def rank_digest(ranks: tuple[float, ...]) -> str:
    canonical = ",".join(format(value, ".17g") for value in ranks).encode("ascii")
    return hashlib.sha256(canonical).hexdigest()


def check_match(label: str, result: tuple[int, int, int, float, str, float, tuple[float, ...]],
                expected_n: int, expected_e: int,
                reference: tuple[int, tuple[float, ...]] | None,
                rank_tolerance: float) -> float:
    n, e, iterations, _, _, _, ranks = result
    if (n, e) != (expected_n, expected_e):
        raise RuntimeError(f"{label}: expected N,E={expected_n},{expected_e}; got {n},{e}")
    if reference is None:
        return 0.0
    _, reference_ranks = reference
    delta = max((abs(value - ref) for value, ref in zip(ranks, reference_ranks)), default=0.0)
    if delta > rank_tolerance:
        raise RuntimeError(f"{label}: max rank delta {delta:.17g} exceeds {rank_tolerance}")
    return delta


def median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def execute_run(impl: str, workers: int, args: list[str], label: str
                ) -> tuple[tuple[int, int, int, float, str, float, tuple[float, ...]], str]:
    command_args = [*args, "--emit-ranks"]
    command, env = make_command(impl, workers, command_args)
    completed = run(command, env=env)
    result = parse_result(completed.stdout)
    raw = (f"[{label}] command={' '.join(command)}\n"
           f"--- stdout begin ---\n{completed.stdout}"
           f"--- stdout end ---\n")
    return result, raw


def cpu_model() -> str:
    info = Path("/proc/cpuinfo")
    if info.exists():
        for line in info.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.lower().startswith(("model name", "hardware")) and ":" in line:
                return line.split(":", 1)[1].strip()
    return platform.processor() or "unknown"


def archive_existing() -> Path | None:
    files = [*OUTPUTS.glob("*_output.txt"), *OUTPUTS.glob("*_benchmarks.csv"),
             *[OUTPUTS / name for name in
               ("comparison.csv", "comparison.svg", "comparison.png", "metadata.txt",
                "demos.csv", "serial_results.csv", "openmp_results.csv", "mpi_results.csv")]]
    ranks = OUTPUTS / "ranks"
    existing = [path for path in files if path.is_file()]
    if ranks.is_dir():
        existing.append(ranks)
    if not existing:
        return None
    archive_root = OUTPUTS / "archive"
    archive = archive_root / datetime.now().strftime("%Y%m%dT%H%M%S%f")
    archive.mkdir(parents=True, exist_ok=False)
    for path in existing:
        target = archive / path.name
        if path.is_dir():
            shutil.copytree(path, target)
        else:
            shutil.copy2(path, target)
    return archive


def write_csv(path: Path, columns: list[str], rows: list[dict[str, object]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def make_metadata(compile_commands: list[str], available_cpus: int) -> list[str]:
    gcc_version = compiler_info(["gcc", "--version"])
    mpicc_version = compiler_info(["mpicc", "--version"])
    mpirun_version = compiler_info(["mpirun", "--version"])
    mpi_override = ("yes (OMPI_ALLOW_RUN_AS_ROOT=1 and OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1)"
                   if os.geteuid() == 0 else "no")
    return [
        f"Machine: {platform.platform()}", f"CPU model: {cpu_model()}",
        f"Architecture: {platform.machine()}",
        f"Logical CPUs reported by Python: {os.cpu_count()}",
        f"CPUs available to this process: {available_cpus}",
        f"GCC: {gcc_version}", f"MPI compiler: {mpicc_version}",
        f"MPI launcher: {mpirun_version}", f"Root MPI override used: {mpi_override}",
        f"Benchmark command: python3 scripts/benchmark.py (working directory {ROOT})",
        "Compilation commands:", *[f"  {command}" for command in compile_commands],
        "Timing scope: application-reported compute_elapsed; graph generation and process startup excluded.",
        "MPI timing is the maximum elapsed time across ranks.",
        "All executions use -O2 -std=c11 -Wall -Wextra -pedantic; OpenMP adds -fopenmp.",
        "Invocation patterns include --graph1, --graph2, --demo, --case CASE, and --emit-ranks.",
        "Demos: graph1 N=4 E=5; graph2 N=4 E=4; demo N=6 E=8.",
        "Cases: N10 (explicit fixture, E=11), N100 (E=594), N1000 (E=5994), N10000 (E=59995), N100000 (E=599992).",
        f"Each configuration has one warmup and at least {REPETITIONS} successful timed readings; at most {MAX_ATTEMPTS} timed attempts.",
        "Generated cases use affine pair(k)=((N+1)*k+17) mod N^2; offset/seed=17, self-loops skipped, directed pairs unique. N10 is an explicit E=11 fixture (seed not applicable).",
        "OpenMP threads: 1,2,4; MPI processes: 1,2,4.",
        "OpenMP environment: OMP_NUM_THREADS=worker count, OMP_DYNAMIC=FALSE; MPI root override is recorded above when used.",
        f"Validation: finite ranks, rank sum within {RANK_SUM_TOLERANCE}, "
        f"final L1 error < {ERROR_TOLERANCE}; benchmark max rank delta <= "
        f"{BENCHMARK_RANK_DELTA_TOLERANCE}, demo delta <= {DEMO_RANK_DELTA_TOLERANCE}; "
        "Iterations may differ; rank vectors are compared by maximum absolute delta.",
    ]


def main() -> None:
    OUTPUTS.mkdir(exist_ok=True)
    BINDIR.mkdir(exist_ok=True)
    compilers = {
        "serial": ("gcc", "serial_pagerank.c", []),
        "openmp": ("gcc", "openmp_pagerank.c", ["-fopenmp"]),
        "mpi": ("mpicc", "mpi_pagerank.c", []),
    }
    compile_commands: list[str] = []
    for name, (compiler, source, extra) in compilers.items():
        command = [compiler, "-O2", "-std=c11", "-Wall", "-Wextra", "-pedantic",
                   *extra, str(SOURCE / source), "-o", str(BINDIR / f"{name}_pagerank")]
        compile_commands.append(" ".join(command))
        run(command)

    available_cpus = (len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity")
                      else (os.cpu_count() or 1))
    raw_logs: dict[str, list[str]] = {name: [] for name in compilers}
    rows: dict[str, list[dict[str, object]]] = {name: [] for name in compilers}
    references: dict[str, tuple[int, tuple[float, ...]]] = {}
    medians: dict[tuple[str, str, int], float] = {}
    failures = 0

    # Legacy demo switches remain exercised as a compatibility smoke test.
    for impl in compilers:
        for workers in WORKERS[impl]:
            for demo, args, expected_n, expected_e in DEMOS:
                label = f"demo={demo} implementation={impl} workers={workers}"
                try:
                    result, raw = execute_run(impl, workers, list(args), label)
                    check_match(label, result, expected_n, expected_e, None,
                                DEMO_RANK_DELTA_TOLERANCE)
                    raw_logs[impl].append(raw)
                except (RuntimeError, ValueError, subprocess.SubprocessError) as exc:
                    failures += 1
                    raw_logs[impl].append(f"[{label}] FAILURE: {exc}\n")

    configurations = [(impl, workers) for impl in compilers for workers in WORKERS[impl]]
    for case, expected_n, expected_e in CASE_SPECS:
        for impl, workers in configurations:
            label = f"case={case} implementation={impl} workers={workers}"
            reference = references.get(case)
            # One untimed warmup per configuration; preserve its output/failure too.
            try:
                warmup, raw = execute_run(impl, workers, ["--case", case], label + " warmup")
                delta = check_match(label + " warmup", warmup, expected_n, expected_e,
                                    reference, BENCHMARK_RANK_DELTA_TOLERANCE)
                if reference is None:
                    references[case] = (warmup[2], warmup[6])
                raw_logs[impl].append(raw)
                rows[impl].append(result_row(case, expected_n, expected_e, impl, workers,
                                             0, "warmup", warmup, delta, ""))
            except (RuntimeError, ValueError, subprocess.SubprocessError) as exc:
                failures += 1
                raw_logs[impl].append(f"[{label} warmup] FAILURE: {exc}\n")
                rows[impl].append(result_row(case, expected_n, expected_e, impl, workers,
                                             0, "warmup", None, "", str(exc)))

            successful = 0
            for attempt in range(1, MAX_ATTEMPTS + 1):
                if successful >= REPETITIONS:
                    break
                run_label = f"{label} attempt={attempt}"
                try:
                    result, raw = execute_run(impl, workers, ["--case", case], run_label)
                    delta = check_match(run_label, result, expected_n, expected_e,
                                        references.get(case), BENCHMARK_RANK_DELTA_TOLERANCE)
                    if case not in references:
                        references[case] = (result[2], result[6])
                    successful += 1
                    rows[impl].append(result_row(case, expected_n, expected_e, impl, workers,
                                                 attempt, "timed", result, delta, ""))
                    raw_logs[impl].append(raw)
                except (RuntimeError, ValueError, subprocess.SubprocessError) as exc:
                    failures += 1
                    rows[impl].append(result_row(case, expected_n, expected_e, impl, workers,
                                                 attempt, "timed", None, "", str(exc)))
                    raw_logs[impl].append(f"[{run_label}] FAILURE: {exc}\n")
            samples = [float(str(r["elapsed_seconds"])) for r in rows[impl]
                       if r["case"] == case and r["workers"] == workers
                       and r["run_type"] == "timed" and r["status"] == "success"]
            if len(samples) >= REPETITIONS:
                medians[(case, impl, workers)] = median(samples)
            else:
                failures += 1
                raw_logs[impl].append(f"[{label}] only {len(samples)} successful timed readings; required {REPETITIONS}\n")

    comparison_rows: list[dict[str, object]] = []
    for case, n, e in CASE_SPECS:
        baseline = medians.get((case, "serial", 1))
        for impl, workers in configurations:
            valid = [r for r in rows[impl] if r["case"] == case and r["workers"] == workers
                     and r["run_type"] == "timed" and r["status"] == "success"]
            for row in [r for r in rows[impl] if r["case"] == case and r["workers"] == workers]:
                comparison_rows.append({**row, "row_type": "reading", "speedup_vs_serial": "",
                                        "efficiency_vs_serial": "", "minimum_seconds": "",
                                        "q1_seconds": "", "q3_seconds": "", "iqr_seconds": ""})
            if not valid:
                continue
            samples = sorted(float(str(r["elapsed_seconds"])) for r in valid)
            med = median(samples)
            medians[(case, impl, workers)] = med
            q1, q3 = percentile(samples, .25), percentile(samples, .75)
            speedup = baseline / med if baseline is not None and med > 0 else ""
            comparison_rows.append({
                "row_type": "summary", "case": case, "graph_id": f"{case}:E{e}",
                "implementation": impl, "workers": workers, "run": "summary", "run_type": "summary",
                "N": n, "E": e, "iterations": "variable", "elapsed_seconds": med,
                "status": f"{len(valid)} successful timed readings", "error": "",
                "final_l1_error": "", "rank_sum": "", "max_rank_delta_vs_serial": "",
                "rank_sha256": "", "minimum_seconds": min(samples), "q1_seconds": q1,
                "q3_seconds": q3, "iqr_seconds": q3-q1,
                "speedup_vs_serial": speedup,
                "efficiency_vs_serial": speedup / workers if speedup != "" else "",
            })

    columns = ["case", "graph_id", "N", "E", "implementation", "workers", "run", "run_type",
               "iterations", "elapsed_seconds", "status", "error", "final_l1_error", "rank_sum",
               "max_rank_delta_vs_serial", "rank_sha256"]
    comp_columns = ["row_type", "case", "graph_id", "N", "E", "implementation", "workers",
                    "run", "run_type", "iterations", "elapsed_seconds", "status", "error",
                    "final_l1_error", "rank_sum", "max_rank_delta_vs_serial", "rank_sha256",
                    "minimum_seconds", "q1_seconds", "q3_seconds", "iqr_seconds",
                    "speedup_vs_serial", "efficiency_vs_serial"]
    pending = {f"{impl}_results.csv": csv_text(columns, rows[impl]) for impl in compilers}
    pending["comparison.csv"] = csv_text(comp_columns, comparison_rows)
    pending["metadata.txt"] = "\n".join(make_metadata(compile_commands, available_cpus)) + "\n"
    for impl in compilers:
        pending[f"{impl}_output.txt"] = "\n".join(raw_logs[impl])
    archive = archive_existing()
    if archive:
        print(f"Archived previous reports: {archive.relative_to(ROOT)}")
    for filename, contents in pending.items():
        (OUTPUTS / filename).write_text(contents, encoding="utf-8")
    create_svg(medians)
    converter = "/usr/bin/rsvg-convert"
    run([converter, "-o", str(OUTPUTS / "comparison.png"), str(OUTPUTS / "comparison.svg")])
    print(f"Benchmark complete: {OUTPUTS / 'comparison.csv'} ({failures} failed checks/attempts)")
    if failures:
        raise RuntimeError(f"{failures} benchmark checks/attempts failed; see outputs/*_output.txt and result CSVs")


def result_row(case: str, n: int, e: int, impl: str, workers: int, attempt: int,
               run_type: str, result: tuple | None, delta: float | str, error: str
               ) -> dict[str, object]:
    row: dict[str, object] = {"case": case, "graph_id": f"{case}:E{e}", "N": n, "E": e,
        "implementation": impl, "workers": workers, "run": attempt, "run_type": run_type,
        "iterations": "", "elapsed_seconds": "", "status": "failure" if error else "success",
        "error": error, "final_l1_error": "", "rank_sum": "",
        "max_rank_delta_vs_serial": delta, "rank_sha256": ""}
    if result is not None:
        row.update(iterations=result[2], elapsed_seconds=result[3], status=result[4],
                   final_l1_error=result[5], rank_sum=sum(result[6]), rank_sha256=rank_digest(result[6]))
    return row


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def csv_text(columns: list[str], rows: list[dict[str, object]]) -> str:
    from io import StringIO
    stream = StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=columns)
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def create_svg(medians: dict[tuple[str, str, int], float]) -> None:
    width, height = 960, 560
    left, right, top, bottom = 112, 38, 78, 116
    plot_w, plot_h = width - left - right, height - top - bottom
    series = (("Serial", "serial", 1, "#2455a4"),
              ("OpenMP · 4 threads", "openmp", 4, "#b86618"),
              ("MPI · 4 processes", "mpi", 4, "#28785d"))
    values = [medians[(case, impl, workers)] for case, _, _ in CASE_SPECS
              for _, impl, workers, _ in series]
    if any(value <= 0 for value in values):
        raise ValueError("Log-scale chart requires positive elapsed times")
    positive = [value for value in values if value > 0]
    if not positive:
        raise ValueError("No positive elapsed times available for chart")
    low = 10 ** math.floor(math.log10(min(positive)))
    high = 10 ** math.ceil(math.log10(max(positive)))
    if low == high:
        low, high = low / 10, high * 10
    y_for = lambda value: top + (math.log10(high) - math.log10(value)) / (math.log10(high) - math.log10(low)) * plot_h
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
             '<rect width="100%" height="100%" fill="#fbfaf7"/>',
             '<text x="112" y="31" font-family="Georgia, serif" font-size="23" fill="#182b3a">PageRank runtime by graph size</text>',
              f'<text x="112" y="54" font-family="sans-serif" font-size="12" fill="#586773">Median elapsed time · at least {REPETITIONS} successful runs per configuration</text>']
    for exponent in range(math.floor(math.log10(low)), math.ceil(math.log10(high)) + 1):
        value = 10.0 ** exponent
        y = y_for(value)
        parts.append(f'<line x1="{left}" y1="{y:.1f}" x2="{width-right}" y2="{y:.1f}" stroke="#d9dedf" stroke-width="1"/>')
        parts.append(f'<text x="{left-12}" y="{y+4:.1f}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#586773">10<tspan baseline-shift="super" font-size="9">{exponent}</tspan></text>')
    parts.append(f'<line x1="{left}" y1="{top}" x2="{left}" y2="{top+plot_h}" stroke="#7b878b"/>')
    parts.append(f'<line x1="{left}" y1="{top+plot_h}" x2="{width-right}" y2="{top+plot_h}" stroke="#7b878b"/>')
    parts.append(f'<text x="28" y="{top + plot_h/2:.1f}" transform="rotate(-90 28 {top + plot_h/2:.1f})" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#344854">Elapsed time (seconds, log₁₀ scale)</text>')
    case_sizes = {case: (n, e) for case, n, e in CASE_SPECS}
    for idx, (case, _, _) in enumerate(CASE_SPECS):
        center = left + plot_w * (idx + 0.5) / len(CASE_SPECS)
        n, e = case_sizes[case]
        parts.append(f'<text x="{center:.1f}" y="{top+plot_h+24}" text-anchor="middle" font-family="Georgia, serif" font-size="17" fill="#182b3a">{case.title()}</text>')
        parts.append(f'<text x="{center:.1f}" y="{top+plot_h+43}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#586773">N = {n:,}  ·  E = {e:,}</text>')
        bar_w, gap = 42, 10
        group_w = len(series) * bar_w + (len(series) - 1) * gap
        for j, (label, impl, workers, color) in enumerate(series):
            value = medians[(case, impl, workers)]
            x = center - group_w / 2 + j * (bar_w + gap)
            y = y_for(value)
            parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w}" height="{top+plot_h-y:.1f}" rx="2" fill="{color}"/>')
            parts.append(f'<text x="{x+bar_w/2:.1f}" y="{y-7:.1f}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#263a45">{value:.3g}</text>')
    parts.append(f'<text x="{left+plot_w/2:.1f}" y="{height-49}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#344854">Graph case (N = vertices, E = edges)</text>')
    legend_y = height - 18
    for j, (label, _, _, color) in enumerate(series):
        x = 166 + j * 238
        parts.append(f'<rect x="{x}" y="{legend_y-13}" width="13" height="13" rx="2" fill="{color}"/>')
        parts.append(f'<text x="{x+20}" y="{legend_y-2}" font-family="sans-serif" font-size="12" fill="#344854">{label}</text>')
    parts.append('</svg>')
    (OUTPUTS / "comparison.svg").write_text("\n".join(parts) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"benchmark failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
