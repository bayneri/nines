import { type Doc, type DocNode, removeCall, removeNode, renameNode, setNodeType, updateCall, updateNode } from '../doc';
import type { NodeType } from '../model/topology';
import { Field, Segmented, Stepper, parseMs, parsePercent } from './controls';
import { inputPercent } from './format';

interface Common {
  doc: Doc;
  /**
   * Applies an edit; a string is an error to show. Edits sharing a `coalesce`
   * key in quick succession (a slider drag) become one undo step.
   */
  onEdit: (result: Doc | string, coalesce?: string) => void;
  onClose: () => void;
}

export function NodeInspector({ doc, id, onEdit, onRenamed, onClose, onCallAnother, onAddDependency }: Common & {
  id: string;
  onRenamed: (id: string) => void;
  onCallAnother: () => void;
  onAddDependency: () => void;
}) {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return null;
  const members = doc.calls.filter((c) => c.from === id).length;
  const isEntry = doc.entry === id;

  return (
    <div className="inspector" role="dialog" aria-label={`Edit ${id}`}>
      <header>
        <Field
          label="Name"
          value={node.id}
          onCommit={(text) => {
            const result = renameNode(doc, id, text);
            if (typeof result === 'string') return result;
            onEdit(result);
            onRenamed(text);
          }}
        />
        <button className="close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <Segmented<NodeType>
        label="Kind"
        value={node.type}
        options={[
          { value: 'service', label: 'Service' },
          { value: 'any', label: 'Either of' },
          { value: 'quorum', label: 'Quorum' },
        ]}
        onChange={(type) => onEdit(setNodeType(doc, id, type))}
      />
      {node.type === 'any' && <p className="note">Tries its calls in order and answers with the first that succeeds.</p>}
      {node.type === 'quorum' && (
        <Stepper
          label="Needs"
          value={node.require ?? 1}
          min={1}
          max={Math.max(1, members)}
          format={(v) => `${v} of ${members}`}
          onChange={(require) => onEdit(updateNode(doc, id, { require }))}
        />
      )}
      {node.type !== 'service' && members < 2 && <p className="note">Add at least two calls for this to be redundant.</p>}

      {node.type === 'service' && <ServiceFields doc={doc} node={node} onEdit={onEdit} />}

      <div className="actions">
        <button onClick={onAddDependency}>+ New dependency</button>
        <button onClick={onCallAnother}>Call existing…</button>
      </div>
      <div className="actions quiet">
        {isEntry ? (
          <span className="note">Requests arrive here.</span>
        ) : (
          <button onClick={() => onEdit({ ...doc, entry: id })}>Make requests arrive here</button>
        )}
        {!isEntry && (
          <button className="danger" onClick={() => onEdit(removeNode(doc, id))}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function ServiceFields({ doc, node, onEdit }: { doc: Doc; node: DocNode; onEdit: Common['onEdit'] }) {
  const flaky = Math.round(node.transient * 100);
  return (
    <>
      <Field
        label="Availability"
        value={inputPercent(node.availability).replace('%', '')}
        suffix="%"
        width={84}
        hint="Its own success rate, not counting what it calls."
        onCommit={(text) => {
          const value = parsePercent(text);
          if (typeof value === 'string') return value;
          onEdit(updateNode(doc, node.id, { availability: value }));
        }}
      />
      <div className="field">
        <label htmlFor={`mix-${node.id}`}>When it fails</label>
        <input
          id={`mix-${node.id}`}
          type="range"
          min={0}
          max={100}
          step={5}
          value={flaky}
          onChange={(e) => onEdit(updateNode(doc, node.id, { transient: Number(e.target.value) / 100 }), `mix:${node.id}`)}
        />
        <span className="range-labels">
          <span>outages</span>
          <strong>{flaky === 0 ? 'all outages' : flaky === 100 ? 'all flaky' : `${flaky}% flaky`}</strong>
          <span>flaky</span>
        </span>
        <span className="field-hint">Outages last the whole request, retries included. Flaky failures pass on retry.</span>
      </div>
      {node.latency ? (
        <div className="pair">
          <Field
            label="p50"
            value={String(node.latency.p50Ms)}
            suffix="ms"
            width={64}
            onCommit={(text) => {
              const v = parseMs(text, false);
              if (typeof v !== 'number') return v;
              if (v > node.latency!.p99Ms) return 'p50 can\'t exceed p99.';
              onEdit(updateNode(doc, node.id, { latency: { ...node.latency!, p50Ms: v } }));
            }}
          />
          <Field
            label="p99"
            value={String(node.latency.p99Ms)}
            suffix="ms"
            width={64}
            onCommit={(text) => {
              const v = parseMs(text, false);
              if (typeof v !== 'number') return v;
              if (v < node.latency!.p50Ms) return 'p99 can\'t be below p50.';
              onEdit(updateNode(doc, node.id, { latency: { ...node.latency!, p99Ms: v } }));
            }}
          />
        </div>
      ) : (
        <button className="link" onClick={() => onEdit(updateNode(doc, node.id, { latency: { p50Ms: 20, p99Ms: 100 } }))}>
          + Add latency
        </button>
      )}
      <label className="check">
        <input type="checkbox" checked={node.infra} onChange={(e) => onEdit(updateNode(doc, node.id, { infra: e.target.checked }))} />
        Shared infrastructure
      </label>
    </>
  );
}

export function CallInspector({ doc, index, onEdit, onClose }: Common & { index: number }) {
  const call = doc.calls[index];
  if (!call) return null;
  const caller = doc.nodes.find((n) => n.id === call.from)!;
  const isMember = caller.type !== 'service';
  const siblings = doc.calls.filter((c) => c.from === call.from).length;
  const update = (patch: Parameters<typeof updateCall>[2]) => onEdit(updateCall(doc, index, patch));

  return (
    <div className="inspector" role="dialog" aria-label={`Edit the call from ${call.from} to ${call.to}`}>
      <header>
        <h3>
          {call.from} <span aria-hidden="true">→</span> {call.to}
        </h3>
        <button className="close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {isMember ? (
        <p className="note">
          {caller.type === 'any'
            ? `Option ${doc.calls.filter((c) => c.from === call.from).indexOf(call) + 1} of ${siblings} that ${call.from} tries, in order.`
            : `One of ${siblings} members ${call.from} calls in parallel; it needs ${caller.require} to answer.`}
        </p>
      ) : (
        <Segmented
          label="If it fails"
          value={call.dependency}
          options={[
            { value: 'hard', label: 'Request fails' },
            { value: 'soft', label: 'Answer degrades' },
          ]}
          onChange={(dependency) => update({ dependency })}
        />
      )}
      <Stepper label="Retries" value={call.retries} min={0} max={5} onChange={(retries) => update({ retries })} />
      <Field
        label="Timeout"
        value={call.timeoutMs === undefined ? '' : String(call.timeoutMs)}
        suffix="ms"
        placeholder="none"
        width={72}
        hint={call.timeoutMs === undefined ? (call.dependency === 'soft' ? 'Without one, the caller still waits for it in full.' : 'Without one, the caller waits as long as it takes.') : undefined}
        onCommit={(text) => {
          const v = parseMs(text, true);
          if (typeof v === 'string') return v;
          update({ timeoutMs: v });
        }}
      />
      {!isMember && (
        <>
          <Field
            label="Fan-out"
            value={String(call.fanout)}
            suffix={call.fanout === 1 ? 'instance' : 'instances'}
            width={64}
            hint="Calls this many instances in parallel and waits for all of them."
            onCommit={(text) => {
              const n = Number(text);
              if (!Number.isInteger(n) || n < 1 || n > 10_000) return 'Enter a whole number from 1 to 10,000.';
              update({ fanout: n });
            }}
          />
          {call.fanout > 1 && (
            <Field
              label="Needs"
              value={String(call.fanoutRequire)}
              suffix={`of ${call.fanout}`}
              width={64}
              hint={call.fanoutRequire < call.fanout ? 'Answers partially when some instances fail.' : 'Every instance must answer.'}
              onCommit={(text) => {
                const n = Number(text);
                if (!Number.isInteger(n) || n < 1 || n > call.fanout) return `Enter a whole number from 1 to ${call.fanout}.`;
                update({ fanoutRequire: n });
              }}
            />
          )}
          {siblings > 1 && (
            <Stepper
              label="Step"
              value={call.stage}
              min={0}
              max={9}
              format={(v) => `${v + 1}`}
              onChange={(stage) => update({ stage })}
            />
          )}
          {siblings > 1 && <p className="note">Calls in the same step run in parallel; steps run one after another.</p>}
        </>
      )}
      <div className="actions quiet">
        <span />
        <button className="danger" onClick={() => onEdit(removeCall(doc, index))}>
          Delete call
        </button>
      </div>
    </div>
  );
}
