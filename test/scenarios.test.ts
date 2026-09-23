import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseInputs } from '../src/model/inputs';
import { parseTopology } from '../src/model/topology';

const dir = join(import.meta.dirname, '..', 'scenarios');
const read = (file: string) => readFileSync(join(dir, file), 'utf8');

describe('bundled scenarios', () => {
  const inputFiles = readdirSync(dir).filter((f) => f.endsWith('.yaml'));

  it('has at least one input set per topology', () => {
    const topologies = readdirSync(dir).filter((f) => f.endsWith('.dot'));
    const referenced = new Set(inputFiles.map((f) => /^topology: (.+)$/m.exec(read(f))?.[1]));
    expect(topologies.filter((t) => !referenced.has(t))).toEqual([]);
  });

  it.each(inputFiles)('%s parses cleanly against its topology', (file) => {
    const source = read(file);
    const topologyFile = /^topology: (.+)$/m.exec(source)?.[1];
    expect(topologyFile).toBeDefined();

    const topology = parseTopology(read(topologyFile!));
    expect(topology.diagnostics).toEqual([]);

    const inputs = parseInputs(source, topology.value!);
    expect(inputs.diagnostics).toEqual([]);
    expect(inputs.value!.topology).toBe(topologyFile);
  });
});
