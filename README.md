# nines

Can your architecture keep the reliability promise you made? nines puts the promise ("99.99% of requests succeed within 300 ms") next to what the dependency graph actually delivers and what napkin math predicts. Then it ranks the changes that would close the gap.

**Try it:** [nines.hcet.me](https://nines.hcet.me/). It opens on five short lessons and needs no setup.

## What's inside

- **Learn mode:** five lessons where napkin math goes wrong: shared dependencies behind "redundant" regions, 100-way fan-out, retries against outages, optional vs. "add a nine", and a promise made before anyone checked.
- **Model mode:** build your own graph. A service's kind sets typical values, and everything else is under Advanced.
- **What would help most / Find a path to the promise:** ranked changes, then a greedy sequence of them, judged by the promise metric.

## How it computes

- Failures are **exact**. The engine enumerates combinations of simultaneous outages until the probability left is below 1e-9, and reports that bound ([src/model/availability.ts](src/model/availability.ts)).
- Time is **simulated** with lognormal latencies fitted to p50/p99, enforcing stages, timeouts, retries and failover, and shown with 95% intervals ([src/model/sampler.ts](src/model/sampler.ts), [src/model/latency.ts](src/model/latency.ts)).
- Napkin math is the same engine with every failure treated as independent.
- An independent per-request sampler cross-checks the engine on every scenario and on random graphs.

Topologies are Graphviz DOT with custom attributes, and measurements are YAML ([scenarios/](scenarios/)). The UI edits a structured document and generates both.

## Run locally

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```
