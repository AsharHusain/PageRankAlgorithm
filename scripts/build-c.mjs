// Compiles c/*.c into bin/ using the same logic the running server uses,
// so `npm run build:c` and an incoming HTTP request can never disagree
// about how the binaries were produced.
//
// Called automatically from the "postinstall" and "predev" hooks; safe to
// run by hand at any time. Exits non-zero if a compile fails.

import { ensureAllBinaries, systemInfo } from '../server/pagerank-service.mjs';

const force = process.argv.includes('--force');

const info = await systemInfo();
if (!info.gccAvailable) {
  console.error('\n  gcc was not found on PATH.');
  console.error('  The web UI needs it to compile the C PageRank programs.');
  console.error('  Debian/Ubuntu:  sudo apt install build-essential');
  console.error('  macOS:          xcode-select --install  (then `brew install libomp` for OpenMP)\n');
  process.exit(1);
}

console.log(`Compiling C PageRank programs (${info.gcc}) ...`);
const results = await ensureAllBinaries({ force });

let failed = false;
for (const [name, r] of Object.entries(results)) {
  if (r.ok) {
    console.log(`  ${name.padEnd(7)} ${r.rebuilt ? 'compiled' : 'up to date'} -> ${r.binary.replace(process.cwd() + '/', '')}`);
    if (r.warnings?.trim()) console.log(r.warnings.trim().replace(/^/gm, '      '));
  } else {
    failed = true;
    console.error(`  ${name.padEnd(7)} FAILED: ${r.error}`);
    if (r.detail) console.error(r.detail.replace(/^/gm, '      '));
  }
}

if (failed) process.exit(1);

// Re-probe after building: the thread count comes from running the OpenMP
// binary, which may not have existed when `info` was gathered above.
const after = await systemInfo();
console.log(`Done. OpenMP reports ${after.ompMaxThreads ?? '?'} available threads on this machine.`);
