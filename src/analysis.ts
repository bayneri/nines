/**
 * Everything the UI shows for one topology + inputs pair, except the
 * latency simulation, which runs separately because it is slower.
 */
import { type AvailabilityResult, modelAvailability, napkinAvailability } from './model/availability';
import type { Diagnostic } from './model/diagnostics';
import { type Inputs, parseInputs } from './model/inputs';
import { napkinLatencyP99 } from './model/latency';
import { type Topology, parseTopology } from './model/topology';

export interface Analysis {
  diagnostics: Diagnostic[];
  /** Present when the topology parses, even if the inputs don't. */
  topology?: Topology;
  inputs?: Inputs;
  availability?: AvailabilityResult;
  napkin?: number;
  napkinP99?: number;
  /** Modeling caveats worth pointing out; not errors. */
  notes: string[];
}

export function analyze(dot: string, yaml: string): Analysis {
  const topology = parseTopology(dot);
  const diagnostics = [...topology.diagnostics];
  if (!topology.value) return { diagnostics, notes: [] };

  const inputs = parseInputs(yaml, topology.value);
  diagnostics.push(...inputs.diagnostics);
  const notes = topology.value.edges
    .filter((e) => e.dependency === 'soft' && e.timeoutMs === undefined)
    .map((e) => `${e.from} -> ${e.to} is soft but has no timeout_ms, so ${e.from} still waits for it in full.`);
  if (!inputs.value) return { diagnostics, topology: topology.value, notes };

  if (inputs.value.defaulted.length > 0) notes.push(`Using \`defaults\` for: ${inputs.value.defaulted.join(', ')}.`);
  return {
    diagnostics,
    topology: topology.value,
    inputs: inputs.value,
    availability: modelAvailability(topology.value, inputs.value),
    napkin: napkinAvailability(topology.value, inputs.value),
    napkinP99: napkinLatencyP99(topology.value, inputs.value),
    notes,
  };
}
