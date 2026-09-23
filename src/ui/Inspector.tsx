import type { ReactNode } from 'react';
import type { Analysis } from '../analysis';
import { type Doc, type DocNode, displayName, iconFor, removeCall, removeNode, renameNode, setNodeType, updateCall, updateNode } from '../doc';
import type { Evaluation } from '../model/slo';
import { NODE_ICONS, type NodeType } from '../model/topology';
import { Field, Segmented, Stepper, parseMs, parsePercent } from './controls';
import { inputPercent } from './format';
import { Icon } from './icons';
import { callName, nodeName, share } from './words';

interface Common {
  doc: Doc;
  analysis?: Analysis;
  evaluation?: Evaluation;
  /**
   * Applies an edit; a string is an error to show. Edits sharing a `coalesce`
   * key in quick succession (a slider drag) become one undo step.
   */
  onEdit: (result: Doc | string, coalesce?: string) => void;
  onBack: () => void;
}

const pct = share;

function Frame({ title, subtitle, onBack, onDelete, deleteLabel, children }: { title: ReactNode; subtitle?: ReactNode; onBack: () => void; onDelete?: () => void; deleteLabel: string; children: ReactNode }) {
  return (
    <div className="inspector">
      <div className="inspector-nav">
        <button className="text-button" onClick={onBack}>
          <Icon name="back" size={14} /> Results
        </button>
        {onDelete && (
          <button className="icon-button danger" onClick={onDelete} aria-label={deleteLabel} title={deleteLabel}>
            <Icon name="trash" />
          </button>
        )}
      </div>
      <h2 className="inspector-title">{title}</h2>
      {subtitle && <p className="inspector-subtitle">{subtitle}</p>}
      {children}
    </div>
  );
}

export function NodeInspector({ doc, analysis, evaluation, id, onEdit, onBack, onSelectCall, onRenamed, onCallAnother, onAddDependency }: Common & {
  id: string;
  onSelectCall: (index: number) => void;
  onRenamed: (id: string) => void;
  onCallAnother: () => void;
  onAddDependency: () => void;
}) {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return null;
  const isEntry = doc.entry === id;
  const calls = doc.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.from === id);
  const lever = analysis?.levers?.find((l) => l.id === id);
  const timedOut = (evaluation?.timeoutLosses ?? []).filter((l) => l.to === id).reduce((sum, l) => sum + l.share.value, 0);

  return (
    <Frame
      title={node.type === 'service' ? displayName(node) : 'Redundant group'}
      subtitle={isEntry ? 'Requests arrive here.' : undefined}
      onBack={onBack}
      onDelete={isEntry ? undefined : () => onEdit(removeNode(doc, id))}
      deleteLabel={`Delete ${displayName(node)}`}
    >
      {lever && (
        <p className="lever">
          If {displayName(node)} never failed, <strong>{pct(lever.ifPerfect)}</strong> more requests would succeed.{' '}
          {lever.ifNoFlaky < 0.1 * lever.ifNoOutages
            ? 'Almost all of that is outages, which retries can’t fix.'
            : lever.ifNoOutages < 0.1 * lever.ifNoFlaky
              ? 'Almost all of that is flaky failures.'
              : `Outages account for ${pct(lever.ifNoOutages)}, flaky failures for ${pct(lever.ifNoFlaky)}.`}
        </p>
      )}
      {timedOut >= 0.0001 && (
        <p className="lever">
          Timeouts on calls into {displayName(node)} lose another <strong>{pct(timedOut)}</strong>: it answers, but too slowly.
        </p>
      )}

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

      {node.type === 'service' ? (
        <ServiceFields doc={doc} node={node} onEdit={onEdit} />
      ) : (
        <>
          <p className="note">
            {node.type === 'any'
              ? 'Tries the services it calls in order and answers with the first that succeeds.'
              : 'Calls every service in parallel and answers once enough of them have.'}
          </p>
          {node.type === 'quorum' && (
            <Stepper
              label="Needs"
              value={node.require ?? 1}
              min={1}
              max={Math.max(1, calls.length)}
              format={(v) => `${v} of ${calls.length}`}
              onChange={(require) => onEdit(updateNode(doc, id, { require }))}
            />
          )}
          <Field label="Label" value={node.label ?? ''} placeholder="Either succeeds" onCommit={(t) => onEdit(updateNode(doc, id, { label: t || undefined }))} />
        </>
      )}

      <div className="field">
        <span className="label">{node.type === 'service' ? 'Calls' : 'Options, in order'}</span>
        {calls.length > 0 && (
          <ul className="call-list">
            {calls.map(({ c, i }) => (
              <li key={i}>
                <button className="text-button" onClick={() => onSelectCall(i)}>
                  {nodeName(doc, c.to)}
                  <Icon name="chevron" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row-actions start">
          <button onClick={onAddDependency}>
            <Icon name="plus" size={14} /> New service
          </button>
          <button onClick={onCallAnother}>
            <Icon name="link" size={14} /> Existing…
          </button>
        </div>
      </div>

      <details className="more">
        <summary>
          <Icon name="chevron" size={13} /> More
        </summary>
        <Field
          label="Id, used in code"
          value={node.id}
          onCommit={(text) => {
            const result = renameNode(doc, id, text);
            if (typeof result === 'string') return result;
            onEdit(result);
            onRenamed(text);
          }}
        />
        {!isEntry && (
          <button className="text-button" onClick={() => onEdit({ ...doc, entry: id })}>
            Make requests arrive here instead
          </button>
        )}
      </details>
    </Frame>
  );
}

function ServiceFields({ doc, node, onEdit }: { doc: Doc; node: DocNode; onEdit: Common['onEdit'] }) {
  const flaky = Math.round(node.transient * 100);
  const icon = iconFor(doc, node);
  return (
    <>
      <div className="name-row">
        <Field label="Name" value={displayName(node)} onCommit={(t) => onEdit(updateNode(doc, node.id, { label: t || undefined }))} />
        <div className="field">
          <span className="label">Icon</span>
          <span className="icon-picker" role="radiogroup" aria-label="Icon">
            {NODE_ICONS.map((name) => (
              <button key={name} role="radio" aria-checked={icon === name} aria-label={name} title={name} onClick={() => onEdit(updateNode(doc, node.id, { icon: name }))}>
                <Icon name={name} />
              </button>
            ))}
          </span>
        </div>
      </div>
      <Field
        label="Availability"
        value={inputPercent(node.availability).replace('%', '')}
        suffix="%"
        width={80}
        hint="Its own success rate, not counting the services it calls."
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
          <span>Outages</span>
          <strong>{flaky === 0 ? 'all outages' : flaky === 100 ? 'all flaky' : `${flaky}% flaky`}</strong>
          <span>Flaky</span>
        </span>
        <span className="field-hint">An outage lasts the whole request, retries included. A flaky failure passes on retry.</span>
      </div>
      {node.latency ? (
        <div className="pair">
          <Field
            label="Latency p50"
            value={String(node.latency.p50Ms)}
            suffix="ms"
            width={60}
            onCommit={(text) => {
              const v = parseMs(text, false);
              if (typeof v !== 'number') return v;
              if (v > node.latency!.p99Ms) return "p50 can't exceed p99.";
              onEdit(updateNode(doc, node.id, { latency: { ...node.latency!, p50Ms: v } }));
            }}
          />
          <Field
            label="p99"
            value={String(node.latency.p99Ms)}
            suffix="ms"
            width={60}
            onCommit={(text) => {
              const v = parseMs(text, false);
              if (typeof v !== 'number') return v;
              if (v < node.latency!.p50Ms) return "p99 can't be below p50.";
              onEdit(updateNode(doc, node.id, { latency: { ...node.latency!, p99Ms: v } }));
            }}
          />
        </div>
      ) : (
        <button className="text-button" onClick={() => onEdit(updateNode(doc, node.id, { latency: { p50Ms: 20, p99Ms: 100 } }))}>
          <Icon name="plus" size={14} /> Add latency
        </button>
      )}
      <label className="check">
        <input type="checkbox" checked={node.infra} onChange={(e) => onEdit(updateNode(doc, node.id, { infra: e.target.checked }))} />
        Shared infrastructure
      </label>
    </>
  );
}

export function CallInspector({ doc, evaluation, index, onEdit, onBack }: Common & { index: number }) {
  const call = doc.calls[index];
  if (!call) return null;
  const caller = doc.nodes.find((n) => n.id === call.from)!;
  const isMember = caller.type !== 'service';
  const siblings = doc.calls.filter((c) => c.from === call.from);
  const update = (patch: Parameters<typeof updateCall>[2]) => onEdit(updateCall(doc, index, patch));
  const loss = evaluation?.timeoutLosses.find((l) => l.edge === index);

  return (
    <Frame title={callName(doc, index)} onBack={onBack} onDelete={() => onEdit(removeCall(doc, index))} deleteLabel="Delete this call">
      {loss && (
        <p className="lever">
          Its timeout cuts off <strong>{pct(loss.share.value)}</strong> of requests that would otherwise succeed.
        </p>
      )}
      {isMember ? (
        <p className="note">
          {caller.type === 'any'
            ? `Option ${siblings.indexOf(call) + 1} of ${siblings.length}, tried in order.`
            : `One of ${siblings.length} called in parallel; ${caller.require} must answer.`}
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
      <Field
        label="Timeout"
        value={call.timeoutMs === undefined ? '' : String(call.timeoutMs)}
        suffix="ms"
        placeholder="none"
        width={70}
        hint={call.timeoutMs === undefined ? (call.dependency === 'soft' ? 'Without one, the caller still waits for it in full.' : 'Without one, the caller waits as long as it takes.') : undefined}
        onCommit={(text) => {
          const v = parseMs(text, true);
          if (typeof v === 'string') return v;
          update({ timeoutMs: v });
        }}
      />
      <Stepper label="Retries" value={call.retries} min={0} max={5} onChange={(retries) => update({ retries })} />
      {!isMember && (
        <details className="more" open={call.fanout > 1 || call.stage > 0}>
          <summary>
            <Icon name="chevron" size={13} /> Fan-out and order
          </summary>
          <Field
            label="Instances called"
            value={String(call.fanout)}
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
              hint={call.fanoutRequire < call.fanout ? 'Answers with partial results when some instances fail.' : 'Every instance must answer.'}
              onCommit={(text) => {
                const n = Number(text);
                if (!Number.isInteger(n) || n < 1 || n > call.fanout) return `Enter a whole number from 1 to ${call.fanout}.`;
                update({ fanoutRequire: n });
              }}
            />
          )}
          {siblings.length > 1 && (
            <>
              <Stepper label="Step" value={call.stage} min={0} max={9} format={(v) => `${v + 1}`} onChange={(stage) => update({ stage })} />
              <p className="note">Calls in the same step run in parallel; steps run one after another.</p>
            </>
          )}
        </details>
      )}
    </Frame>
  );
}
