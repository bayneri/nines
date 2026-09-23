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
  /** What the default inputs show. */
  lesson: string;
  /** An edit worth trying, and what it reveals. */
  tryThis: string;
  dot: string;
  yaml: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'multi_region',
    title: "Multi-region that isn't",
    lesson:
      'Two 99.9% regions look like six nines of redundancy, and napkin math agrees. But both regions depend on one control plane whose failures are outages, so the pair can never beat it.',
    tryThis: 'Set control_plane transient to 1 (flaky requests instead of outages) and modeled availability jumps to the napkin number.',
    dot: multiRegionDot,
    yaml: multiRegionYaml,
  },
  {
    id: 'search',
    title: 'The 100-shard fan-out',
    lesson:
      'Napkin math gets availability right here. Latency is where it breaks: adding up p99s gives 275 ms against a 400 ms target, but the request waits for the slowest of 100 shards, and about 1 in 6 requests misses.',
    tryThis: 'Add fanout_require=95 to the shard edge. Partial results rescue the latency target, at the cost of full-fidelity answers.',
    dot: searchDot,
    yaml: searchYaml,
  },
  {
    id: 'checkout',
    title: "Retries don't save you",
    lesson:
      "Napkin math treats a retry as a fresh roll of everything below it. Retries do recover payments' flaky errors, but the ledger fails by outage, which lasts across every retry. And each retry costs time.",
    tryThis: 'Remove retries=3 to see what they actually buy, then change ledger_db transient to 1 to see what napkin math assumed.',
    dot: checkoutDot,
    yaml: checkoutYaml,
  },
  {
    id: 'product_page',
    title: 'Soft dependency beats a nine',
    lesson:
      'Napkin math is pessimistic here: it counts the shared auth dependency once per caller, three times, as if each call could fail independently. Inventory is a hard dependency only because the page shows "in stock".',
    tryThis:
      'Compare inventory at 99.99% with making product_page -> inventory soft (add dependency=soft, timeout_ms=150). Going soft wins on availability but costs full-fidelity answers.',
    dot: productPageDot,
    yaml: productPageYaml,
  },
  {
    id: 'product_page_promise',
    title: 'The promise came first',
    lesson:
      'Same product page, same inputs. Sales promised 99.99% before anyone checked the dependency graph. The model is about 1.4 nines short, and no single node improvement closes the gap.',
    tryThis: 'Look for the set of changes that reaches 99.99%, or the promise this topology can actually keep.',
    dot: productPageDot,
    yaml: productPagePromiseYaml,
  },
];
