// Parses the ACTUAL program output text (from src/generated/serialOutput.js
// and openmpOutput.js, which are themselves synced verbatim from
// outputs/*.txt) into structured rows. This is the only place numbers cross
// from "text the C program printed" into "data the UI charts" -- nothing is
// hand-transcribed, so the UI cannot silently drift from the real run.

// Matches rows like: "     small       1000       5994         13       0.000164"
export function parseSizeTable(text) {
  const re = /^\s*(small|medium|large)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s*$/gm;
  const rows = [];
  let m;
  while ((m = re.exec(text))) {
    rows.push({ size: m[1], N: +m[2], E: +m[3], iters: +m[4], time: parseFloat(m[5]) });
  }
  return rows;
}

// Matches rows in the "Speed-up study" section like: "   4       0.021590       0.98"
export function parseThreadTable(text) {
  const idx = text.indexOf('Speed-up study');
  if (idx === -1) return [];
  const section = text.slice(idx);
  const re = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s*$/gm;
  const rows = [];
  let m;
  while ((m = re.exec(section))) {
    rows.push({ threads: +m[1], time: parseFloat(m[2]), speedup: parseFloat(m[3]) });
  }
  return rows;
}

// Extracts the demonstration-graph converged PR line values, e.g. "  PR[0] = 0.348745"
export function parseDemoPR(text) {
  const re = /PR\[(\d+)\]\s*=\s*([\d.]+)/g;
  const rows = [];
  let m;
  while ((m = re.exec(text))) rows.push({ node: +m[1], pr: parseFloat(m[2]) });
  return rows;
}

// Extracts "Converged in N iterations" from the demonstration-graph section.
export function parseConvergedIters(text) {
  const m = text.match(/Converged in (\d+) iterations/);
  return m ? +m[1] : null;
}

// Extracts max hardware threads line from the OpenMP output, e.g.
// " Max hardware threads available : 1"
export function parseMaxThreads(text) {
  const m = text.match(/Max hardware threads available\s*:\s*(\d+)/);
  return m ? +m[1] : null;
}
