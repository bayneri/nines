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
      'Ignoring time, napkin math is right: 98.9%. But each request waits for the slowest of 100 shards, and the 300 ms shard timeout turns that tail into errors: about 1 in 6 requests fail. The p99 of successful requests still looks fine, because the slow ones became failures.',
    tryThis: 'Add fanout_require=95 to the shard edge. Tolerating 5 missing shards takes availability from 83% to about 99.8%, still short of 99.9%, and every one of those rescued answers is partial.',
    dot: searchDot,
    yaml: searchYaml,
  },
  {
    id: 'checkout',
    title: "Retries don't save you",
    lesson:
      "Retries recover payments' flaky errors, but not ledger outages, which last across every retry. Each retry also costs time: availability (99.9%) and p99 ≤ 800 ms are both met separately, while the promise that 99.9% of requests succeed within 800 ms is missed.",
    tryThis: 'Remove retries=3: availability falls to about 99.2%, because a payments call slower than its 800 ms timeout now fails outright. Then set ledger_db transient to 1 to see what napkin math assumed.',
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
