// Re-records outputs/serial_output.txt and outputs/openmp_output.txt by
// running the two C programs in their original no-argument demo mode.
//
//     npm run capture-outputs
//
// Those files are the ARCHIVED lab capture referenced by the printed
// report; they are not used as live results anywhere in the UI. Re-run
// this only when you deliberately want to refresh the archive with a
// capture from the machine you are on now.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAllBinaries, TARGETS } from '../server/pagerank-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function capture(binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { shell: false });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${binary} exited with ${code}`));
      else resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

const built = await ensureAllBinaries();
for (const [name, r] of Object.entries(built)) {
  if (!r.ok) { console.error(`cannot build ${name}: ${r.error}`); process.exit(1); }
}

console.log('Running the C programs in demo/benchmark mode ...');
for (const [name, file] of [['serial', 'serial_output.txt'], ['openmp', 'openmp_output.txt']]) {
  const text = await capture(TARGETS[name].binary);
  const dest = path.join(ROOT, 'outputs', file);
  await fs.writeFile(dest, text, 'utf8');
  console.log(`  wrote outputs/${file} (${text.split('\n').length} lines)`);
}

console.log('Done. Run `npm run sync-assets` (or just `npm run dev`) to surface them in the UI.');
