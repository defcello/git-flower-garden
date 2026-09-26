# 0005: SVG technical renderer first; Canvas 2D for the garden

- Status: Accepted; UI dependencies are not installed until P1-C
- Date: 2026-09-26
- Roadmap: sections 3, 7, 10

## Context

The first release must be a correct, inspectable Git graph with hover, pinned
details, keyboard and touch focus controls, and an accessible node list. The later
garden needs curved tapered stems, sprite compositing, and ambient animation on
an all-day display. Both must show exactly the same graph.

## Decision

- Renderer-independent layout: graph selection and layout produce plain data
  (positions, edge curves, hit targets). Renderers only draw it.
- Phase 1 draws the graph as SVG, with HTML controls and details, in a React UI
  built with Vite. SVG gives native hit testing, DOM accessibility, and easy
  inspection at the initial supported size.
- Phase 2 draws the garden with Canvas 2D plus an HTML accessibility and
  interaction layer. WebGL needs a measured bottleneck and its own ADR.
- The technical view stays shipped after the garden exists, as the diagnostic
  reference for graph truth.

## Status of implementation

P0-A sets up TypeScript, linting, and unit tests only. Vite, React, and a
browser-test runner are added with the first real UI in P1-C (or the static SVG
probe in P0-B), rather than as an empty framework now. Until then the roadmap's
"browser-test command" item stays open.

## Consequences

- Hit targets and focus order come from the shared layout, so both renderers
  select the same nodes.
- A very large SVG graph may be slow; focus view, culling, and the semantic list
  handle scale before any renderer change.

## Revisit

At P2-A, when Canvas 2D and SVG are compared on identical geometry.
