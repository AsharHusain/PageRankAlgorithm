#!/usr/bin/env python3
"""Build a printable Module III code/output packet from current project artifacts."""

import csv
from html import escape
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SUBMISSION = ROOT / "submission"
HTML = SUBMISSION / "Module_III_PRINT_Code_Outputs_Graph.html"
PDF = SUBMISSION / "Module_III_PRINT_Code_Outputs_Graph.pdf"
IDENTITY = "Mohammed Ashar Husain | Roll No. 2024bcs0137"
CASES = ("N10", "N100", "N1000", "N10000", "N100000")
SERIES = (("serial", "1", "Serial"), ("openmp", "4", "OpenMP / 4"),
          ("mpi", "2", "MPI / 2"), ("mpi", "4", "MPI / 4"))


def code_section(title, source):
    return (f'<section class="code-section"><h2>{escape(title)}</h2>'
            f'<p class="identity">{IDENTITY}</p><pre><code>{escape(source)}</code></pre></section>')


def captured_run(case, attempt=1):
    log = (ROOT / "outputs/mpi_output.txt").read_text(encoding="utf-8").splitlines()
    marker = f"[case={case} implementation=mpi workers=2 attempt={attempt}]"
    start = next((i for i, line in enumerate(log) if line.startswith(marker)), None)
    if start is None:
        raise RuntimeError(f"Missing recorded run marker {marker}")
    command = log[start].split(" command=", 1)[1]
    begin = next(i for i in range(start, len(log)) if log[i] == "--- stdout begin ---")
    end = next(i for i in range(begin + 1, len(log)) if log[i] == "--- stdout end ---")
    stdout = log[begin + 1:end]
    if not stdout or not re.match(r"^\d+,\d+,\d+,\d", stdout[0]):
        raise RuntimeError(f"No captured result row for {marker}")
    fields = stdout[0].split(",")
    if fields[4] != "success":
        raise RuntimeError(f"Selected run did not succeed: {marker}")
    return command, stdout


def comparison_rows():
    path = ROOT / "outputs/comparison.csv"
    with path.open(newline="", encoding="utf-8") as source:
        records = list(csv.DictReader(source))
    summaries = {(r["case"], r["implementation"], r["workers"]): r
                 for r in records if r["row_type"] == "summary"}
    rows = []
    for case in CASES:
        sample = next((r for r in records if r["case"] == case and r["row_type"] == "summary"), None)
        if sample is None:
            raise RuntimeError(f"No summary row in comparison.csv for {case}")
        cells = [case, f'{int(sample["N"]):,}', f'{int(sample["E"]):,}']
        for implementation, workers, _label in SERIES:
            summary = summaries.get((case, implementation, workers))
            if summary is None or summary["status"] != "5 successful timed readings":
                raise RuntimeError(f"Missing five-run summary for {case}/{implementation}/{workers}")
            # Summary rows store the median in elapsed_seconds.
            cells.append(summary["elapsed_seconds"])
        rows.append(cells)
    return rows


def result_section(case, attempt=1):
    command, stdout = captured_run(case, attempt)
    shown = stdout if case == "N10" else stdout[:1]
    note = ("Both the captured result row and all ten actual rank values are shown."
            if case == "N10" else
            "Only the captured result row is shown; the logged rank vector is intentionally omitted to avoid a large output listing.")
    body = (f'<p class="identity">{IDENTITY}</p>'
            f'<p><strong>Run:</strong> attempt {attempt}; MPI processes: 2</p>'
            f'<p><strong>Recorded command:</strong></p><pre class="command"><code>{escape(command)}</code></pre>'
            f'<p>{note} Result and timing below are copied from captured stdout; identity is not inserted into program output.</p>'
            f'<pre class="output"><code>{escape(chr(10).join(shown))}</code></pre>')
    return f'<section class="output-section"><h2>Recorded MPI {case} output</h2>{body}</section>'


def main():
    SUBMISSION.mkdir(exist_ok=True)
    mpi_source = (ROOT / "c/mpi_pagerank.c").read_text(encoding="utf-8")
    header_source = (ROOT / "c/shared_graph.h").read_text(encoding="utf-8")
    rows = comparison_rows()
    heading = "".join(f"<th>{escape(label)} (median seconds)</th>" for _, _, label in SERIES)
    table = "<table><thead><tr><th>Case</th><th>N</th><th>E</th>" + heading + "</tr></thead><tbody>"
    table += "".join("<tr>" + "".join(f"<td>{escape(cell)}</td>" for cell in row) + "</tr>" for row in rows)
    table += "</tbody></table>"
    graph_uri = (ROOT / "outputs/comparison.png").resolve().as_uri()
    graph = f'<figure><img src="{graph_uri}" alt="Current PageRank runtime comparison graph"><figcaption>Current project graph from outputs/comparison.png (includes serial, OpenMP/4 and MPI/4 series).</figcaption></figure>'
    content = f'''
      <section class="cover"><h1>Module III — Printable Code &amp; Outputs Packet</h1>
        <h2>Q9 / Q11 supporting material</h2><p class="identity">{IDENTITY}</p>
        <p>Current MPI implementation, shared graph header, captured MPI results, current comparison summary, and graph.</p>
        <p>This packet reproduces current project artifacts only. It does not claim historical Assignment 1 source or handwritten answers.</p>
      </section>
      {code_section("Q9 — Current MPI source: c/mpi_pagerank.c", mpi_source)}
      {code_section("Q9 — Shared implementation header: c/shared_graph.h", header_source)}
      {result_section("N10")}
      {result_section("N1000")}
      {result_section("N100000")}
      <section class="summary-section"><h2>Q11 — Five-size execution-time comparison</h2>
        <p class="identity">{IDENTITY}</p>
        <p>Medians are read from summary rows in outputs/comparison.csv. Each summary is the median of five successful timed runs for that configuration (one warmup is excluded).</p>
        {table}{graph}
      </section>
    '''
    css = '''
      @page { size: A4; margin: 17mm 15mm 18mm; @top-center { content: "Mohammed Ashar Husain | Roll No. 2024bcs0137"; font: 8pt Arial; color: #444; } }
      body { font: 10pt Arial, sans-serif; color: #20252b; line-height: 1.35; }
      h1 { font-size: 25pt; } h2 { font-size: 16pt; margin-bottom: 4pt; }
      .identity { font-weight: bold; border-bottom: 1px solid #888; padding-bottom: 5pt; }
      .cover { page-break-after: always; padding-top: 78mm; }
      .code-section, .output-section, .summary-section { page-break-before: always; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font: 7pt/1.28 "DejaVu Sans Mono", monospace; background: #f1f3f5; padding: 7pt; }
      pre.command { font-size: 7.5pt; } pre.output { font-size: 8pt; }
      table { width: 100%; border-collapse: collapse; font-size: 8pt; margin: 10pt 0; }
      th, td { border: 1px solid #777; padding: 5pt 4pt; text-align: left; overflow-wrap: anywhere; }
      th { background: #e9edf1; } figure { margin: 15pt 0; text-align: center; }
      img { max-width: 100%; max-height: 160mm; } figcaption { font-size: 8pt; }
    '''
    HTML.write_text(f"<!doctype html><html><head><meta charset='utf-8'><title>Module III Print Packet</title><style>{css}</style></head><body>{content}</body></html>", encoding="utf-8")
    subprocess.run([
        "/usr/bin/chromium", "--headless", "--no-sandbox", "--disable-gpu",
        "--allow-file-access-from-files", "--no-pdf-header-footer",
        f"--print-to-pdf={PDF}", HTML.resolve().as_uri(),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not PDF.is_file() or PDF.stat().st_size == 0:
        raise RuntimeError(f"Chromium did not create {PDF}")
    print(f"Wrote {HTML}")
    print(f"Wrote {PDF}")


if __name__ == "__main__":
    main()
