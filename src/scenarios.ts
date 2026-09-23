import { type Doc, fromParsed, updateCall, updateNode } from './doc';
import { parseInputs } from './model/inputs';
import { parseTopology } from './model/topology';
import checkoutDot from '../scenarios/checkout.dot?raw';
import checkoutYaml from '../scenarios/checkout.yaml?raw';
import multiRegionDot from '../scenarios/multi_region.dot?raw';
import multiRegionYaml from '../scenarios/multi_region.yaml?raw';
import productPageDot from '../scenarios/product_page.dot?raw';
import productPageYaml from '../scenarios/product_page.yaml?raw';
import productPagePromiseYaml from '../scenarios/product_page_promise.yaml?raw';
import searchDot from '../scenarios/search.dot?raw';
import searchYaml from '../scenarios/search.yaml?raw';

export interface Scenario {
  id: string;
  title: string;
  /** Two sentences at most: what this lesson shows. */
  summary: string;
  /** The deeper explanation, revealed on request. */
  more: string;
  /** One experiment: applied by a button, then explained. */
  tryIt: { label: string; apply: (doc: Doc) => Doc; result: string; more?: string };
  dot: string;
  yaml: string;
}

/** The index of the call from -> to, which the scenario files guarantee exists. */
const callIndex = (doc: Doc, from: string, to: string) => doc.calls.findIndex((c) => c.from === from && c.to === to);

const SOURCES: Scenario[] = [
  {
    id: 'multi_region',
    title: "Multi-region that isn't",
    summary: 'Two 99.9% regions should cover for each other. They can’t: both depend on one control plane.',
    more: 'Napkin math multiplies the regions’ failure rates and predicts six nines. But the control plane fails by outage, which takes out both regions at once, so the pair can never be more available than it is. Redundancy only multiplies away failures that are independent.',
    tryIt: {
      label: 'Make control-plane failures flaky',
      apply: (doc) => updateNode(doc, 'control_plane', { transient: 1 }),
      result: 'Now the regions really do cover for each other, and availability matches napkin math.',
      more: 'Flaky failures are independent from one request to the next, so a failure behind one region rarely lines up with one behind the other. Same 99.95% on paper, a very different way of failing.',
    },
    dot: multiRegionDot,
    yaml: multiRegionYaml,
  },
  {
    id: 'search',
    title: 'The 100-shard fan-out',
    summary: 'Every request waits for the slowest of 100 shards, so a rare slow shard becomes the common case.',
    more: 'Ignoring time, napkin math is right: 98.9% of requests succeed. But a shard is slower than its 300 ms timeout about once in 600 calls, and with 100 shards per request that happens to about 1 request in 6, which then fails. The p99 of successful requests still looks healthy, because the slow requests became failures instead.',
    tryIt: {
      label: 'Tolerate 5 missing shards',
      apply: (doc) => updateCall(doc, callIndex(doc, 'search_api', 'shard'), { fanoutRequire: 95 }),
      result: 'Success jumps from 83% to about 99.8%, but those answers are now partial.',
      more: 'Waiting for 95 of 100 shards absorbs the slow tail. It still falls short of 99.9%, and answers with every shard included don’t improve at all.',
    },
    dot: searchDot,
    yaml: searchYaml,
  },
  {
    id: 'checkout',
    title: "Retries don't save you",
    summary: 'Retries fix flaky errors, not outages, and every retry costs time.',
    more: 'Payments fails mostly in flaky ways, so three retries recover it. The ledger fails by outage, which lasts through every retry. The retries also add latency: 99.9% availability and a p99 under 800 ms both hold, yet only about 99.25% of requests succeed within 800 ms.',
    tryIt: {
      label: 'Remove the retries',
      apply: (doc) => updateCall(doc, callIndex(doc, 'checkout', 'payments'), { retries: 0 }),
      result: 'Availability drops to about 99.2%: slow payments calls now fail at the 800 ms timeout.',
      more: 'Without a second attempt, any payments call slower than its timeout becomes an error.',
    },
    dot: checkoutDot,
    yaml: checkoutYaml,
  },
  {
    id: 'product_page',
    title: 'Optional beats a nine',
    summary: 'Making inventory optional wins more than making it ten times more reliable.',
    more: 'Inventory is required only because the page shows stock. If the page can load without it, availability rises to 99.84%, versus 99.82% if inventory were 99.99% available. Napkin math is pessimistic here: it counts the shared auth service three times, once per caller.',
    tryIt: {
      label: 'Make inventory optional',
      apply: (doc) => updateCall(doc, callIndex(doc, 'product_page', 'inventory'), { dependency: 'soft', timeoutMs: 150 }),
      result: 'More requests succeed. The price: more pages load without stock information.',
      more: 'Complete answers within 300 ms drop from 95.6% to 94.6%. An optional call trades completeness for availability.',
    },
    dot: productPageDot,
    yaml: productPageYaml,
  },
  {
    id: 'product_page_promise',
    title: 'The promise came first',
    summary: 'Sales promised 99.99%. This system delivers about 99.7%.',
    more: 'That’s 1.4 nines short. The best single change, making inventory optional, reaches 99.84%. Getting to 99.99% takes several changes at once, or a different promise.',
    tryIt: {
      label: 'Promise what it can keep',
      apply: (doc) => ({ ...doc, objectives: { ...doc.objectives, availability: 0.997, succeedWithin: { ms: 300, target: 0.996 } } }),
      result: 'A promise of 99.6% within 300 ms is one this system keeps today.',
    },
    dot: productPageDot,
    yaml: productPagePromiseYaml,
  },
];

export interface LoadedScenario extends Scenario {
  doc: Doc;
}

/** Scenarios parsed into editable docs. The bundled files are validated by tests. */
export const SCENARIOS: LoadedScenario[] = SOURCES.map((scenario) => {
  const topology = parseTopology(scenario.dot).value!;
  return { ...scenario, doc: fromParsed(topology, parseInputs(scenario.yaml, topology).value!) };
});
