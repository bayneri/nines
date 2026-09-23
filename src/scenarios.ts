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
  /** What the scenario shows as loaded. */
  lesson: string;
  /** One edit worth trying: applied by a button, then explained. */
  tryIt: { label: string; apply: (doc: Doc) => Doc; result: string };
  dot: string;
  yaml: string;
}

/** The index of the call from -> to, which the scenario files guarantee exists. */
const callIndex = (doc: Doc, from: string, to: string) => doc.calls.findIndex((c) => c.from === from && c.to === to);

const SOURCES: Scenario[] = [
  {
    id: 'multi_region',
    title: "Multi-region that isn't",
    lesson:
      'Two 99.9% regions look like six nines of redundancy, and napkin math agrees. But both regions depend on one control plane whose failures are outages, so the pair can never beat it.',
    tryIt: {
      label: 'Make control-plane failures flaky',
      apply: (doc) => updateNode(doc, 'control_plane', { transient: 1 }),
      result:
        'Flaky failures are independent per attempt, so the regions really do cover for each other and the model reaches the napkin number. Same availability on paper, very different failure mode.',
    },
    dot: multiRegionDot,
    yaml: multiRegionYaml,
  },
  {
    id: 'search',
    title: 'The 100-shard fan-out',
    lesson:
      'Ignoring time, napkin math is right: 98.9%. But each request waits for the slowest of 100 shards, and the 300 ms shard timeout turns that tail into errors: about 1 in 6 requests fail. The p99 promise still passes, because the slow requests became failures.',
    tryIt: {
      label: 'Tolerate 5 missing shards',
      apply: (doc) => updateCall(doc, callIndex(doc, 'search_api', 'shard'), { fanoutRequire: 95 }),
      result:
        'Availability goes from 83% to about 99.8%, still short of 99.9%. And the rescued answers are partial: full-fidelity success stays where it was.',
    },
    dot: searchDot,
    yaml: searchYaml,
  },
  {
    id: 'checkout',
    title: "Retries don't save you",
    lesson:
      "Retries recover payments' flaky errors, but not ledger outages, which last across every retry. Each retry also costs time: 99.9% availability and p99 ≤ 800 ms are both met, yet the promise that 99.9% of requests succeed within 800 ms is missed.",
    tryIt: {
      label: 'Remove the retries',
      apply: (doc) => updateCall(doc, callIndex(doc, 'checkout', 'payments'), { retries: 0 }),
      result:
        'Availability falls to about 99.2%: a payments call slower than its 800 ms timeout now fails outright instead of getting a second chance.',
    },
    dot: checkoutDot,
    yaml: checkoutYaml,
  },
  {
    id: 'product_page',
    title: 'Soft dependency beats a nine',
    lesson:
      'Napkin math is pessimistic here: it counts the shared auth dependency once per caller, three times, as if each call could fail independently. Inventory is a hard dependency only because the page shows "in stock".',
    tryIt: {
      label: 'Make inventory soft',
      apply: (doc) => updateCall(doc, callIndex(doc, 'product_page', 'inventory'), { dependency: 'soft', timeoutMs: 150 }),
      result:
        "Availability rises to 99.84%, more than making inventory 99.99% available would give (99.82%). The price is fidelity: more pages render without stock information, so full-fidelity answers within 300 ms drop from 95.6% to 94.6%.",
    },
    dot: productPageDot,
    yaml: productPageYaml,
  },
  {
    id: 'product_page_promise',
    title: 'The promise came first',
    lesson:
      'Same product page, same inputs. Sales promised 99.99% before anyone checked the dependency graph. The model is about 1.4 nines short, and no single improvement closes the gap.',
    tryIt: {
      label: 'Promise what it can keep',
      apply: (doc) => ({ ...doc, objectives: { ...doc.objectives, availability: 0.997 } }),
      result:
        'At 99.7%, the promise matches what this graph delivers today. Getting to 99.99% takes several changes at once; the best single one, making inventory soft, reaches 99.84%.',
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
