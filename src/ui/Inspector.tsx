import type { ReactNode } from 'react';
import type { Analysis } from '../analysis';
import {
  type Doc,
  type DocNode,
  TYPICAL,
  displayName,
  iconFor,
  isTypical,
  removeCall,
  removeNode,
  renameNode,
  resetToTypical,
  setKind,
  setNodeType,
  updateCall,
  updateNode,
} from '../doc';
import type { Evaluation } from '../model/slo';
import { NODE_ICONS, type NodeIcon } from '../model/topology';
import { Chips, Field, Segmented, Stepper, parseMs, parsePercent } from './controls';
import { inputPercent } from './format';
import { Icon } from './icons';
import { callName, groupText, nodeName, share } from './words';

interface Common {
  doc: Doc;
  analysis?: Analysis;
  evaluation?: Evaluation;
  /** Advanced sections start open. */
  advanced: boolean;
  /**
   * Applies an edit; a string is an error to show. Edits sharing a `coalesce`
   * key in quick succession (a slider drag) become one undo step.
   */
  onEdit: (result: Doc | string, coalesce?: string) => void;
  onBack: () => void;
}

const KIND_NAMES: Record<NodeIcon, string> = { web: 'Web app', service: 'Service', database: 'Database', queue: 'Queue', infra: 'Infrastructure' };
const AVAILABILITIES = [0.99, 0.999, 0.9995, 0.9999];

function Frame({ title, onBack, onDelete, deleteLabel, children }: { title: ReactNode; onBack: () => void; onDelete?: () => void; deleteLabel: string; children: ReactNode }) {
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
      {children}
    </div>
  );
}

function Advanced({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <details className="more" open={open || undefined}>
      <summary>
        <Icon name="chevron" size={13} /> Advanced
      </summary>
      {children}
    </details>
  );
}

export function NodeInspector(props: Common & {
  id: string;
  onSelectCall: (index: number) => void;
  onRenamed: (id: string) => void;
  onCallAnother: () => void;
  onAddDependency: () => void;
  onMakeRedundant: () => void;
}) {
  const { doc, id } = props;
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return null;
  return node.type === 'service' ? <ServiceInspector {...props} node={node} /> : <GroupInspector {...props} node={node} />;
}

function ServiceInspector({ doc, analysis, evaluation, advanced, node, onEdit, onBack, onRenamed, onCallAnother, onAddDependency, onMakeRedundant }: Common & {
  node: DocNode;
  onRenamed: (id: string) => void;
  onCallAnother: () => void;
  onAddDependency: () => void;
  onMakeRedundant: () => void;
}) {
  const id = node.id;
  const kind = iconFor(doc, node);
  const typical = isTypical(node, kind);
  const isEntry = doc.entry === id;
  const lever = analysis?.levers?.find((l) => l.id === id);
  const timedOut = (evaluation?.timeoutLosses ?? []).filter((l) => l.to === id).reduce((sum, l) => sum + l.share.value, 0);
  const callers = doc.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.to === id);
  const flaky = Math.round(node.transient * 100);

  return (
    <Frame title={displayName(node)} onBack={onBack} onDelete={isEntry ? undefined : () => onEdit(removeNode(doc, id))} deleteLabel={`Delete ${displayName(node)}`}>
      {(lever || timedOut >= 0.0001) && (
        <p className="lever">
          {lever && (
            <>
              Its failures cost <strong>{share(lever.ifPerfect)}</strong> of requests.{' '}
            </>
          )}
          {timedOut >= 0.0001 && (
            <>
              Answering too late costs another <strong>{share(timedOut)}</strong>.
            </>
          )}
        </p>
      )}

      <Field label="Name" value={displayName(node)} onCommit={(t) => onEdit(updateNode(doc, id, { label: t || undefined }))} />

      <div className="field">
        <span className="label">What is it?</span>
        <span className="kind-picker" role="radiogroup" aria-label="What is it?">
          {NODE_ICONS.map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} title={KIND_NAMES[k]} onClick={() => onEdit(setKind(doc, id, k))}>
              <Icon name={k} size={17} />
              <span>{KIND_NAMES[k]}</span>
            </button>
          ))}
        </span>
        {typical ? (
          <span className="field-hint">Typical for a {KIND_NAMES[kind].toLowerCase()}: {TYPICAL[kind].summary}.</span>
        ) : (
          <span className="field-hint">
            Your own numbers.{' '}
            <button className="text-button" onClick={() => onEdit(resetToTypical(doc, id))}>
              Use typical ones
            </button>
          </span>
        )}
      </div>

      <Chips key={id} label="Availability" value={node.availability} options={AVAILABILITIES} format={inputPercent} suffix="%" parse={parsePercent} onChange={(availability) => onEdit(updateNode(doc, id, { availability }))} />

      {callers.length > 0 && (
        <div className="field">
          <span className="label">If it fails</span>
          {callers.map(({ c, i }) => {
            const caller = doc.nodes.find((n) => n.id === c.from)!;
            if (caller.type !== 'service') return <span key={i} className="field-hint">{groupText(doc, caller)}: another option takes over.</span>;
            return (
              <div key={i} className="needed-by">
                <span>{displayName(caller)}</span>
                <span className="segmented small" role="radiogroup" aria-label={`If it fails, ${displayName(caller)}`}>
                  <button role="radio" aria-checked={c.dependency === 'hard'} onClick={() => onEdit(updateCall(doc, i, { dependency: 'hard' }))}>
                    fails too
                  </button>
                  <button role="radio" aria-checked={c.dependency === 'soft'} onClick={() => onEdit(updateCall(doc, i, { dependency: 'soft' }))}>
                    carries on
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="row-actions start wrap">
        <button onClick={onAddDependency}>
          <Icon name="plus" size={14} /> Add a dependency
        </button>
        <button onClick={onCallAnother}>
          <Icon name="link" size={14} /> Connect to…
        </button>
        <button onClick={onMakeRedundant} title="Add a fallback that takes over when this fails">
          <Icon name="group" size={14} /> Add a fallback
        </button>
      </div>

      <Advanced open={advanced}>
        <div className="field">
          <label htmlFor={`mix-${id}`}>How it fails</label>
          <input id={`mix-${id}`} type="range" min={0} max={100} step={5} value={flaky} onChange={(e) => onEdit(updateNode(doc, id, { transient: Number(e.target.value) / 100 }), `mix:${id}`)} />
          <span className="range-labels">
            <span>Outages</span>
            <strong>{flaky === 0 ? 'all outages' : flaky === 100 ? 'all flaky' : `${flaky}% flaky`}</strong>
            <span>Flaky</span>
          </span>
          <span className="field-hint">An outage lasts through every retry; a flaky failure passes on the next try.</span>
        </div>
        {node.latency && (
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
                onEdit(updateNode(doc, id, { latency: { ...node.latency!, p50Ms: v } }));
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
                onEdit(updateNode(doc, id, { latency: { ...node.latency!, p99Ms: v } }));
              }}
            />
          </div>
        )}
        <Field
          label="Id, used in code"
          value={id}
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
      </Advanced>
    </Frame>
  );
}

function GroupInspector({ doc, advanced, node, onEdit, onBack, onSelectCall, onCallAnother }: Common & { node: DocNode; onSelectCall: (index: number) => void; onCallAnother: () => void }) {
  const options = doc.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.from === node.id);
  return (
    <Frame title={groupText(doc, node)} onBack={onBack} onDelete={doc.entry === node.id ? undefined : () => onEdit(removeNode(doc, node.id))} deleteLabel="Delete this group">
      <p className="note">
        {node.type === 'any'
          ? 'Tries each option in order and answers with the first that succeeds.'
          : `Calls every option at once and answers once ${node.require} of ${options.length} have.`}
      </p>
      <div className="field">
        <span className="label">Options</span>
        <ul className="call-list">
          {options.map(({ c, i }, n) => (
            <li key={i}>
              <button className="text-button" onClick={() => onSelectCall(i)}>
                <span>
                  {node.type === 'any' ? `${n + 1}. ` : ''}
                  {nodeName(doc, c.to)}
                </span>
                <Icon name="chevron" size={13} />
              </button>
            </li>
          ))}
        </ul>
        <div className="row-actions start">
          <button onClick={onCallAnother}>
            <Icon name="link" size={14} /> Add an option…
          </button>
        </div>
      </div>
      <Advanced open={advanced}>
        <Segmented
          label="Answers when"
          value={node.type}
          options={[
            { value: 'any', label: 'one succeeds' },
            { value: 'quorum', label: 'enough agree' },
          ]}
          onChange={(type) => onEdit(setNodeType(doc, node.id, type))}
        />
        {node.type === 'quorum' && (
          <Stepper label="Needs" value={node.require ?? 1} min={1} max={Math.max(1, options.length)} format={(v) => `${v} of ${options.length}`} onChange={(require) => onEdit(updateNode(doc, node.id, { require }))} />
        )}
        <Field label="Label" value={node.label ?? ''} placeholder={groupText(doc, { ...node, label: undefined })} onCommit={(t) => onEdit(updateNode(doc, node.id, { label: t || undefined }))} />
      </Advanced>
    </Frame>
  );
}

export function CallInspector({ doc, evaluation, advanced, index, onEdit, onBack }: Common & { index: number }) {
  const call = doc.calls[index];
  if (!call) return null;
  const caller = doc.nodes.find((n) => n.id === call.from)!;
  const isMember = caller.type !== 'service';
  const siblings = doc.calls.filter((c) => c.from === call.from);
  const update = (patch: Parameters<typeof updateCall>[2]) => onEdit(updateCall(doc, index, patch));
  const loss = evaluation?.timeoutLosses.find((l) => l.edge === index);
  const callee = nodeName(doc, call.to);

  return (
    <Frame title={callName(doc, index)} onBack={onBack} onDelete={() => onEdit(removeCall(doc, index))} deleteLabel="Delete this call">
      {loss && (
        <p className="lever">
          Its timeout cuts off <strong>{share(loss.share.value)}</strong> of requests that would otherwise succeed.
        </p>
      )}
      {isMember ? (
        <p className="note">{caller.type === 'any' ? `Option ${siblings.indexOf(call) + 1} of ${siblings.length}, tried in order.` : `One of ${siblings.length} options called at once.`}</p>
      ) : (
        <Segmented
          label={`If ${callee} fails, ${displayName(caller)}`}
          value={call.dependency}
          options={[
            { value: 'hard', label: 'fails too' },
            { value: 'soft', label: 'carries on' },
          ]}
          onChange={(dependency) => update({ dependency })}
        />
      )}
      <Advanced open={advanced || call.retries > 0 || call.timeoutMs !== undefined || call.fanout > 1}>
        <Field
          label="Timeout"
          value={call.timeoutMs === undefined ? '' : String(call.timeoutMs)}
          suffix="ms"
          placeholder="none"
          width={70}
          hint={call.timeoutMs === undefined ? 'Without one, the caller waits as long as it takes.' : undefined}
          onCommit={(text) => {
            const v = parseMs(text, true);
            if (typeof v === 'string') return v;
            update({ timeoutMs: v });
          }}
        />
        <Stepper label="Retries" value={call.retries} min={0} max={5} onChange={(retries) => update({ retries })} />
        {!isMember && (
          <>
            <Field
              label="Copies called at once"
              value={String(call.fanout)}
              width={64}
              hint="For sharded or replicated services: calls this many copies in parallel and waits for them."
              onCommit={(text) => {
                const n = Number(text);
                if (!Number.isInteger(n) || n < 1 || n > 10_000) return 'Enter a whole number from 1 to 10,000.';
                update({ fanout: n });
              }}
            />
            {call.fanout > 1 && (
              <Field
                label="Needs answers from"
                value={String(call.fanoutRequire)}
                suffix={`of ${call.fanout}`}
                width={64}
                hint={call.fanoutRequire < call.fanout ? 'Answers with partial results when some copies fail.' : 'Every copy must answer.'}
                onCommit={(text) => {
                  const n = Number(text);
                  if (!Number.isInteger(n) || n < 1 || n > call.fanout) return `Enter a whole number from 1 to ${call.fanout}.`;
                  update({ fanoutRequire: n });
                }}
              />
            )}
            {siblings.length > 1 && (
              <>
                <Stepper label="Order" value={call.stage} min={0} max={9} format={(v) => `step ${v + 1}`} onChange={(stage) => update({ stage })} />
                <p className="note">Calls in the same step happen at the same time; a later step waits for earlier ones.</p>
              </>
            )}
          </>
        )}
      </Advanced>
    </Frame>
  );
}
