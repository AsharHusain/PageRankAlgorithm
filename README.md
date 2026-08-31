# PageRank Lab — CSS 311 Assignment I

Serial (C) and parallel (OpenMP, C) implementations of PageRank, plus an
interactive React UI that **sends your graph to those C programs and displays
what they return**.

The browser does not compute PageRank. It draws graphs, collects parameters,
and renders JSON that a `gcc`-compiled binary produced.

```
React UI  ──HTTP/JSON──▶  Node API  ──spawn + stdin──▶  ./bin/serial_pagerank
                                                        ./bin/openmp_pagerank
                                                              │
     UI renders  ◀──────  JSON  ◀──────────  stdout  ◀────────┘
```

---

## Quick start

Requires Node.js 18+ and `gcc` with OpenMP support.

```bash
npm install     # installs deps, syncs assets, compiles the C programs
npm run dev     # starts Vite + the PageRank API on http://localhost:5173
```

That's it — one command, one port. The API is mounted inside the Vite dev
server (see `vite.config.js`), so there is no second process to babysit and
no proxy to configure.

If `gcc` is missing, `npm install` says so explicitly and the UI shows
"C backend unavailable" in the top-right rather than silently faking results.

```bash
# Debian / Ubuntu / WSL
sudo apt install build-essential
```

### Other commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite + API, recompiles C if the sources changed |
| `npm run build` | Production bundle into `dist/` |
| `npm start` | Serves `dist/` + the API standalone (port 4173) |
| `npm run build:c` | Compile the C programs into `bin/` |
| `npm run rebuild:c` | Force a recompile |
| `npm run verify` | **Correctness suite** — 51 checks against the C binaries |
| `npm run smoke` | Server-renders every screen against the live API |
| `npm run capture-outputs` | Re-records the archived `outputs/*.txt` |

---

## What's in here

```
PDC_PageRank_Assignment/
├── c/
│   ├── serial_pagerank.c      <- serial implementation (Q4)
│   └── openmp_pagerank.c      <- OpenMP implementation (Q9)
├── bin/                       <- compiled binaries (generated, gitignored)
├── server/
│   ├── pagerank-service.mjs   <- compiles + spawns the C binaries
│   ├── api.mjs                <- HTTP endpoints (connect middleware)
│   └── standalone.mjs         <- production server
├── src/
│   ├── api/client.js          <- fetch wrappers
│   ├── components/            <- Lab, Benchmark, editor, results, player
│   ├── data/graphModel.js     <- graph construction + layout (no PageRank)
│   └── reference/             <- reference JS implementation (validator only)
├── scripts/
│   ├── build-c.mjs            <- compile helper
│   ├── sync-assets.mjs        <- copies c/ + outputs/ into src/generated/
│   ├── verify.mjs             <- correctness suite
│   └── capture-outputs.mjs    <- re-records outputs/*.txt
├── outputs/                   <- ARCHIVED terminal capture (historical)
└── report/PDC_Assignment1_PageRank.pdf
```

---

## The C programs have two modes

**1. No arguments** — the original assignment behaviour, unchanged: the 6-node
demonstration graph, the small/medium/large benchmark suite, and (for OpenMP)
the 1/2/4/8-thread speed-up study, all printed human-readably. This is what
`outputs/*.txt` captured, and it still reproduces.

```bash
gcc -O2 -o bin/serial_pagerank c/serial_pagerank.c -lm
./bin/serial_pagerank
```

**2. `--json`** — reads an arbitrary graph and prints one machine-readable
JSON object. This is the mode the web backend uses.

```bash
printf '6 8\n0 1\n0 2\n1 2\n2 0\n3 0\n3 2\n4 3\n4 5\n' \
  | ./bin/openmp_pagerank --json --threads 4
```

Input is `N M` followed by `M` lines of `u v`. Options:

| Option | Meaning |
| --- | --- |
| `--damping <d>` | damping factor (default 0.85) |
| `--tol <t>` | L1 convergence tolerance (default 1e-6) |
| `--max-iter <n>` | iteration cap (default 100) |
| `--repeat <n>` | solve n times, report the **fastest** wall time |
| `--history <0\|1>` | record per-iteration data (default 1) |
| `--history-cap <n>` | store full PR vectors only when N ≤ this (default 1000) |
| `--generate <N>` | build a seeded random graph instead of reading stdin |
| `--degree <d>` / `--seed <s>` | parameters for `--generate` |
| `--threads <t>` | OpenMP only: thread team size |

The JSON carries the PageRank vector, the full iteration history, timing,
convergence state, and — for OpenMP — the thread count the runtime actually
gave you plus the real `schedule(static)` work distribution.

### Two-phase execution, so timing stays honest

Recording per-iteration history costs memory traffic, which would inflate the
measured runtime. So the C programs solve **twice**:

1. **Timed phase** — the power iteration with zero instrumentation, repeated
   `--repeat` times, keeping the fastest wall time.
2. **Untimed replay** — the identical (deterministic) solve again, this time
   recording every iteration's vector and L1 difference.

Thread instrumentation (`omp_get_thread_num()` per node) likewise runs in its
own region, outside the timed solve. `timing_ms` therefore measures the
algorithm and nothing else.

---

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/system` | compiler, CPU count, OpenMP thread count, binary status |
| `POST /api/build` | force a recompile |
| `POST /api/pagerank/run` | run one implementation on one graph |
| `POST /api/pagerank/compare` | serial vs OpenMP across a thread ladder |

```bash
curl -s -X POST http://localhost:5173/api/pagerank/run \
  -H 'Content-Type: application/json' \
  -d '{"implementation":"openmp","threads":4,
       "graph":{"nodeIds":[0,1,2],"edges":[[0,1],[1,2],[2,0]]},
       "params":{"damping":0.85,"tolerance":1e-6,"maxIterations":100}}'
```

Safety: binaries are spawned with an argument array and `shell:false`, the
graph travels on **stdin** and never through `argv`, every numeric parameter is
validated and clamped before it becomes an argument, and child processes are
capped by a timeout and an output limit. Node ids may be sparse (the editor
produces gaps when you delete nodes); the server compacts them to `0..N-1` for
C and maps the results back.

---

## How to confirm the UI really is running C

Any one of these is conclusive:

1. **Delete the binaries mid-session.** `rm -rf bin/` then press Run. The
   request fails with a compile/spawn error — there is no JavaScript fallback.
2. **Break the C code on purpose.** Change `DAMPING` in `c/serial_pagerank.c`
   to `0.5`, restart `npm run dev`, and watch every number in the Lab change.
3. **Watch the process table.** `watch -n0.1 'pgrep -a pagerank'` while
   pressing Run.
4. **Expand "where did these numbers come from?"** in the results panel — it
   prints the binary path, the exact argv, and the host.
5. **Use the cross-check button.** It runs the reference JS implementation and
   reports max |PR_C − PR_JS|; agreement is ~1e-13, confirming C is correct
   *and* that the two are genuinely separate code paths.
6. **`npm run verify`** — 51 checks that go through the same service layer the
   HTTP API uses.

---

## About the JavaScript in `src/reference/`

`src/reference/pagerankReference.js` is a **reference implementation, used only
as a validator**. It is wired to exactly one thing: the "Independent
cross-check" button in the results panel, which reports how far it lands from
the C answer.

It is never rendered as though it came from C, and it is never used as a
fallback. Previously (v1 of this project) this code *was* the thing the UI
displayed — that is the confusion this version exists to remove.

---

## Archived vs live numbers

`outputs/*.txt` are a terminal capture from the original submission, recorded
on a machine that exposed a **single logical core** — which is why the OpenMP
speed-up in them sits at or below 1×. They are shown in the **Archive** tab and
labelled as historical.

Live speed-up is measured on demand in the **Benchmark** tab. On a 22-core
machine the same 100 000-node graph gives roughly:

| Threads | Speedup | Efficiency |
| --- | --- | --- |
| 2 | 2.0× | 100% |
| 4 | 3.5× | 88% |
| 8 | 3.8× | 48% |

Falling efficiency at high thread counts is expected: each iteration ends at an
implicit barrier and sparse PageRank is memory-bandwidth bound.

Numbers on your machine will differ. That is the point — they are measured, not
recorded.

---

## The report (`report/PDC_Assignment1_PageRank.pdf`)

Covers the handwritten-permitted questions (Q1, 2, 3, 5 from Module-I; Q6, 7, 8,
10 from Module-II) and deliberately contains no C code. Q4 and Q9 are satisfied
by `c/` and `outputs/` directly, and by the Code tab.

Fill in the `Name:` / `Roll No:` fields on the PDF cover and the
`<FILL_YOUR_NAME>` / `<FILL_YOUR_ROLL_NO>` placeholders at the top of both `.c`
files before submitting.
