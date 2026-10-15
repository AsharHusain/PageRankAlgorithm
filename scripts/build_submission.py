#!/usr/bin/env python3
"""Build an honest typed companion PDF from the checked-in assignment materials."""

from html import escape
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "submission"
PDF = OUT_DIR / "Module_III_PageRank_Mohammed_Ashar_Husain_2024bcs0137.pdf"
HTML = OUT_DIR / "Module_III_PageRank_Mohammed_Ashar_Husain_2024bcs0137.html"
IDENTITY = "Mohammed Ashar Husain — Roll No. 2024bcs0137"


def inline(text):
    def link(match):
        target = match.group(2).split("#", 1)[0]
        return f"{match.group(1)} ({target})" if target else match.group(1)

    text = re.sub(r"\[([^]]+)\]\(([^)]+)\)", link, text)
    text = escape(text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", text)
    return text


def render_markdown(markdown):
    """Render the local report's headings, paragraphs, lists, tables and code fences."""
    lines = markdown.splitlines()
    result = []
    i = 0
    graph_emitted = False
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i])
                i += 1
            result.append("<pre><code>" + escape("\n".join(code)) + "</code></pre>")
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                row = [cell.strip() for cell in lines[i].strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in row):
                    rows.append(row)
                i += 1
            if rows:
                result.append("<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in rows[0]) + "</tr></thead><tbody>")
                result.extend("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>" for row in rows[1:])
                result.append("</tbody></table>")
            continue
        elif line.startswith("#"):
            level = min(len(line) - len(line.lstrip("#")), 6)
            result.append(f"<h{level}>{inline(line[level:].strip())}</h{level}>")
        elif line.startswith("!["):
            match = re.match(r"!\[([^]]*)\]\(([^)]+)\)", line)
            if match and not graph_emitted:
                source = (ROOT / match.group(2)).resolve().as_uri()
                result.append(f'<figure><img src="{source}"><figcaption>{inline(match.group(1))}</figcaption></figure>')
                graph_emitted = True
        elif re.match(r"\d+\.\s", line):
            result.append("<p class=\"list-item\">" + inline(line.split(". ", 1)[1]) + "</p>")
        elif line.strip():
            result.append("<p>" + inline(line) + "</p>")
        i += 1
    return "\n".join(result)


def recorded_output(path, implementation, workers, attempt):
    lines = path.read_text(encoding="utf-8").splitlines()
    expected = f"[case=N10 implementation={implementation} workers={workers} attempt={attempt}]"
    start = next((i for i, line in enumerate(lines) if line.startswith(expected)), None)
    if start is None:
        raise RuntimeError(f"Recorded N10 attempt missing: {expected} in {path}")
    begin = next(i for i in range(start, len(lines)) if lines[i] == "--- stdout begin ---")
    end = next(i for i in range(begin + 1, len(lines)) if lines[i] == "--- stdout end ---")
    return "\n".join(lines[begin + 1:end])


def section(title, body):
    return f'<section><h2>{title}</h2><p class="identity">{IDENTITY}</p>{body}</section>'


def main():
    OUT_DIR.mkdir(exist_ok=True)
    module = render_markdown((ROOT / "module3.md").read_text(encoding="utf-8"))
    preface = f"""
      <section class="cover"><h1>Assignment 2 — PageRank</h1>
      <h2>Module III: MPI</h2><p class="identity">{IDENTITY}</p>
      <p>Typed companion submission containing the existing Module III answers (Q6–Q11),
      current project source listings, recorded N=10 execution output, and the current
      comparison graph.</p></section>
      <section class="notice"><h2>Submission scope and required manual attachments</h2>
      <p>This PDF is a typed companion, not a substitute for handwritten work. The original
      handwritten Module I/III answers (including Q1, Q2, Q3, Q5, Q6, Q7, Q8 and Q10)
      and the signed hardcopy must be manually attached for official compliance. They are
      not reproduced here because no handwritten originals or historical Assignment 1
      source are available. The serial listing below is the current project implementation,
      not a claim that it is the historical Assignment 1 source.</p></section>
      <section><h2>Module III answers — Questions 6–11</h2>{module}</section>
    """
    serial = (ROOT / "c/serial_pagerank.c").read_text(encoding="utf-8")
    mpi = (ROOT / "c/mpi_pagerank.c").read_text(encoding="utf-8")
    serial_out = recorded_output(ROOT / "outputs/serial_output.txt", "serial", 1, 1)
    mpi_out = recorded_output(ROOT / "outputs/mpi_output.txt", "mpi", 2, 3)
    content = preface
    content += section("Current serial C source listing — c/serial_pagerank.c",
                       "<p>Identity is printed in this page header; it is not program stdout.</p><pre><code>" + escape(serial) + "</code></pre>")
    content += section("Current MPI C source listing — c/mpi_pagerank.c",
                       "<p>Identity is printed in this page header; it is not program stdout.</p><pre><code>" + escape(mpi) + "</code></pre>")
    content += section("Recorded serial N=10 output — outputs/serial_output.txt, attempt 1",
                       "<p>Actual captured stdout, selected from the saved output log; identity is this printed section label, not stdout.</p><pre><code>" + escape(serial_out) + "</code></pre>")
    content += section("Recorded MPI N=10 output — outputs/mpi_output.txt, 2 processes, attempt 3",
                       "<p>Actual captured stdout, selected from the saved output log; identity is this printed section label, not stdout.</p><pre><code>" + escape(mpi_out) + "</code></pre>")
    style = """
      @page { size: A4; margin: 18mm 16mm 20mm; @top-center { content: "Mohammed Ashar Husain | Roll No. 2024bcs0137"; font: 8pt Arial; color: #555; } }
      body { font: 10pt Arial, sans-serif; color: #20252b; line-height: 1.45; }
      h1 { font-size: 27pt; } h2 { font-size: 17pt; margin-top: 20pt; }
      h3 { font-size: 13pt; } p { margin: 6pt 0; } .identity { font-weight: bold; border-bottom: 1px solid #888; padding-bottom: 5pt; }
      .cover { page-break-after: always; padding-top: 90mm; } .notice { page-break-after: always; }
      section { page-break-inside: auto; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 7.2pt "DejaVu Sans Mono", monospace; background: #f2f4f6; padding: 8pt; }
      code { font-family: "DejaVu Sans Mono", monospace; } table { border-collapse: collapse; width: 100%; font-size: 8pt; margin: 8pt 0; }
      th, td { border: 1px solid #9aa1a8; padding: 4pt; vertical-align: top; } th { background: #e9edf1; }
      img { max-width: 100%; max-height: 170mm; } figure { text-align: center; } figcaption { font-size: 8pt; }
      .list-item { margin-left: 18pt; } .notice { border: 1px solid #9a6b00; padding: 10pt; }
    """
    HTML.write_text(f"<!doctype html><html><head><meta charset='utf-8'><style>{style}</style></head><body>{content}</body></html>", encoding="utf-8")
    subprocess.run([
        "/usr/bin/chromium", "--headless", "--no-sandbox", "--disable-gpu",
        "--allow-file-access-from-files", "--no-pdf-header-footer",
        f"--print-to-pdf={PDF}", HTML.resolve().as_uri(),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not PDF.is_file() or PDF.stat().st_size == 0:
        raise RuntimeError(f"Chromium did not create a PDF at {PDF}")
    print(f"Wrote {PDF}")


if __name__ == "__main__":
    main()
