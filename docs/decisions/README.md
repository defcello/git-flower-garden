# Architecture decision records

Each record captures one decision, why it was made, and when to revisit it. The
[roadmap](../../ROADMAP.md) remains the full specification; records here explain
and pin the choices it depends on. To change a decision, add a new record that
supersedes the old one and update the roadmap, examples, schema, and tests together
(roadmap section 15).

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-local-browser-architecture.md) | Local loopback service with a browser UI | Accepted |
| [0002](0002-read-only-source-policy.md) | Monitored repositories are read-only | Accepted |
| [0003](0003-best-common-ancestor-interpretation.md) | "Every common ancestor" means best common ancestors of every head subset | Accepted |
| [0004](0004-business-day-window.md) | Recent history is a continuous lookback of N business dates | Accepted |
| [0005](0005-initial-rendering-stack.md) | SVG technical renderer first; Canvas 2D for the garden | Accepted |
| [0006](0006-toolchain-baseline.md) | Node.js 24, TypeScript 6.0, Vitest, ESLint, Prettier; Git 2.36 or newer | Accepted |
| [0007](0007-ancestor-selector-evidence.md) | Evidence: bitset ancestor selector matches oracle and Git; time and memory measured | Accepted |
| [0008](0008-git-read-and-fetch-evidence.md) | Evidence: Git machine-readable output and app-owned fetch isolation | Accepted |
| [0009](0009-visible-graph-and-static-svg.md) | Visible graph, reduced edges, layout, and static SVG | Accepted |
| [0010](0010-quiet-history-and-pipeline-benchmark.md) | Evidence: quiet repositories and graph pipeline cost | Accepted |
| [0011](0011-interactive-technical-renderer.md) | Interactive technical renderer and browser tests | Accepted |

Benchmark and probe evidence (roadmap P0-B onward) also belongs in this directory.
