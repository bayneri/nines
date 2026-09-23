import { useMemo, useState } from 'react';
import { type Doc, fromParsed, toDot, toYaml } from '../doc';
import type { Diagnostic } from '../model/diagnostics';
import { parseInputs } from '../model/inputs';
import { parseTopology } from '../model/topology';
import { Editor, type FileTab } from './Editor';

/** The model as DOT and YAML: generated from the graph, or edited and applied back. */
export function CodeView({ doc, onApply }: { doc: Doc; onApply: (doc: Doc) => void }) {
  const [tab, setTab] = useState<FileTab>('dot');
  const [draft, setDraft] = useState<{ dot: string; yaml: string }>();
  const dot = draft?.dot ?? toDot(doc);
  const yaml = draft?.yaml ?? toYaml(doc);

  const parsed = useMemo(() => {
    if (!draft) return undefined;
    const topology = parseTopology(draft.dot);
    const diagnostics: Diagnostic[] = [...topology.diagnostics];
    if (!topology.value) return { diagnostics };
    const inputs = parseInputs(draft.yaml, topology.value);
    diagnostics.push(...inputs.diagnostics);
    return { diagnostics, doc: inputs.value && fromParsed(topology.value, inputs.value) };
  }, [draft]);

  return (
    <div className="code-view">
      <p className="code-intro">
        {draft
          ? 'Editing the model as text. Apply to replace the graph; the code is regenerated from it afterwards, so comments and layout are not kept.'
          : 'The graph, as the engine reads it: a DOT topology and YAML inputs.'}
      </p>
      <Editor
        tab={tab}
        onTab={setTab}
        dot={dot}
        yaml={yaml}
        readOnly={!draft}
        onChange={(t, v) => setDraft({ dot: t === 'dot' ? v : dot, yaml: t === 'yaml' ? v : yaml })}
        diagnostics={parsed?.diagnostics ?? []}
      />
      <div className="actions">
        {draft ? (
          <>
            <button onClick={() => setDraft(undefined)}>Cancel</button>
            <button
              className="primary"
              onClick={() => {
                if (!parsed?.doc) return;
                onApply(parsed.doc);
                setDraft(undefined);
              }}
              aria-disabled={!parsed?.doc}
              title={parsed?.doc ? undefined : 'Fix the errors first'}
            >
              Apply
            </button>
          </>
        ) : (
          <>
            <button onClick={() => navigator.clipboard?.writeText(tab === 'dot' ? dot : yaml)}>Copy {tab === 'dot' ? 'topology.dot' : 'inputs.yaml'}</button>
            <button onClick={() => setDraft({ dot, yaml })}>Edit as code</button>
          </>
        )}
      </div>
    </div>
  );
}
