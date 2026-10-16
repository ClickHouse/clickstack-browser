import type { eventWithTime } from '@rrweb/types';
import { EVENT_INCREMENTAL_SNAPSHOT, SOURCE_MUTATION } from './constants.ts';

const BUCKET_SIZE = 100;
const REFILL_PER_MS = 10 / 1000;

/**
 * Drops attribute mutations of nodes that change faster than 10 times a second after a burst of
 * 100 so an element animated through its attributes cannot flood the replay. rrweb's `sampling`
 * options throttle input, scroll, and mouse events, but have no equivalent for mutations.
 *
 * @remarks
 * A node inside an SVG shares the bucket of its `svg` element since SVG animations
 * change many child nodes at once. Text/add/remove mutations always pass. Buckets refill from
 * the elapsed time when used, so the limiter needs no timer.
 *
 * @internal
 */
export class MutationLimiter {
  // Keyed by node. Removed nodes are collected with their buckets
  #buckets = new WeakMap<Node, { tokens: number; at: number }>();
  readonly #onBlocked: () => void;

  /**
   * Creates a limiter with every bucket full.
   *
   * @param onBlocked Called whenever a mutation is dropped, so the recorder can schedule a full
   * snapshot that repairs the dropped state.
   */
  constructor(onBlocked: () => void) {
    this.#onBlocked = onBlocked;
  }

  /**
   * Applies the limit to one rrweb event without mutating it.
   *
   * @param event The event rrweb emitted.
   * @param getNode Looks up the live node of an rrweb mirror ID.
   * @param now The current time in milliseconds.
   * @returns A copy of the event without the dropped attribute mutations, or `undefined` when nothing
   * is left of it.
   */
  filter(
    event: eventWithTime,
    getNode: (id: number) => Node | null,
    now: number,
  ): eventWithTime | undefined {
    if (event.type !== EVENT_INCREMENTAL_SNAPSHOT || event.data.source !== SOURCE_MUTATION) {
      return event;
    }

    const { attributes, adds, removes, texts } = event.data;
    const kept = attributes.filter((mutation) => {
      const node = getNode(mutation.id);

      return node === null || this.#take((node as Element).closest('svg') ?? node, now);
    });

    if (kept.length === attributes.length) {
      return event;
    }

    this.#onBlocked();

    if (kept.length + adds.length + removes.length + texts.length === 0) {
      return undefined;
    }

    return { ...event, data: { ...event.data, attributes: kept } };
  }

  /** Refills every bucket */
  reset(): void {
    this.#buckets = new WeakMap();
  }

  #take(key: Node, now: number): boolean {
    const bucket = this.#buckets.get(key) ?? { tokens: BUCKET_SIZE, at: now };
    bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + (now - bucket.at) * REFILL_PER_MS);
    bucket.at = now;
    this.#buckets.set(key, bucket);

    if (bucket.tokens < 1) {
      return false;
    }

    bucket.tokens -= 1;

    return true;
  }
}
