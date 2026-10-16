import type { eventWithTime } from '@rrweb/types';
import { beforeEach, expect, test, vi } from 'vitest';
import { MutationLimiter } from './limiter.ts';

const nodes = new Map<number, Node>();
const getNode = (id: number): Node | null => nodes.get(id) ?? null;

function attributeChanges(ids: number[], extra: { texts?: { id: number; value: string }[] } = {}) {
  return {
    type: 3,
    timestamp: 0,
    data: {
      source: 0,
      texts: extra.texts ?? [],
      attributes: ids.map((id) => ({ id, attributes: { width: '1' } })),
      removes: [],
      adds: [],
    },
  } as unknown as eventWithTime;
}

function keptIds(event: eventWithTime | undefined): number[] {
  return (
    (event?.data as { attributes: { id: number }[] } | undefined)?.attributes.map((a) => a.id) ?? []
  );
}

beforeEach(() => {
  nodes.clear();
  document.body.innerHTML = '<div id="box"></div><svg><g><rect></rect><circle></circle></g></svg>';
  nodes.set(1, document.querySelector('#box') as Node);
  nodes.set(2, document.querySelector('rect') as Node);
  nodes.set(3, document.querySelector('circle') as Node);
});

test('a node passes 100 changes, then 10 a second', () => {
  const onBlocked = vi.fn();
  const limiter = new MutationLimiter(onBlocked);

  for (let i = 0; i < 100; i++) {
    expect(keptIds(limiter.filter(attributeChanges([1]), getNode, 0))).toEqual([1]);
  }

  expect(limiter.filter(attributeChanges([1]), getNode, 0)).toBeUndefined();
  expect(onBlocked).toHaveBeenCalledOnce();

  let passed = 0;
  for (let t = 0; t < 1000; t += 10) {
    passed += keptIds(limiter.filter(attributeChanges([1]), getNode, t)).length;
  }

  expect(passed).toBeGreaterThanOrEqual(9);
  expect(passed).toBeLessThanOrEqual(10);
});

test('nodes of one svg share its budget', () => {
  const limiter = new MutationLimiter(() => undefined);

  for (let i = 0; i < 50; i++) {
    limiter.filter(attributeChanges([2, 3]), getNode, 0);
  }

  expect(keptIds(limiter.filter(attributeChanges([2, 3, 1]), getNode, 0))).toEqual([1]);
});

test('keeps other mutations and other events, and never mutates the input', () => {
  const limiter = new MutationLimiter(() => undefined);

  for (let i = 0; i < 100; i++) {
    limiter.filter(attributeChanges([1]), getNode, 0);
  }

  const event = attributeChanges([1], { texts: [{ id: 9, value: 'x' }] });
  const kept = limiter.filter(event, getNode, 0);
  expect(kept?.data).toMatchObject({ attributes: [], texts: [{ id: 9 }] });
  expect(keptIds(event)).toEqual([1]);

  const click = { type: 3, timestamp: 0, data: { source: 2 } } as unknown as eventWithTime;
  expect(limiter.filter(click, getNode, 0)).toBe(click);
});

test('reset refills every budget', () => {
  const limiter = new MutationLimiter(() => undefined);

  for (let i = 0; i < 101; i++) {
    limiter.filter(attributeChanges([1]), getNode, 0);
  }

  limiter.reset();

  expect(keptIds(limiter.filter(attributeChanges([1]), getNode, 0))).toEqual([1]);
});
