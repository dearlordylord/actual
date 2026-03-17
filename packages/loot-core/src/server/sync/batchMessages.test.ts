import { Timestamp } from '@actual-app/crdt';

import * as db from '../db';

import { batchMessages, sendMessages, setSyncingMode } from './index';

beforeEach(() => {
  setSyncingMode('disabled');
  return global.emptyDatabase()();
});

afterEach(() => {
  global.resetTime();
  setSyncingMode('disabled');
});

describe('batchMessages concurrency', () => {
  it('preserves nested batch messages when outer batch fails', async () => {
    // Regression test: nested batch messages must not be silently lost
    // when the outer batch throws after the inner batch completes.
    //
    // Trace: A starts outer batch, sends msgA, yields. B starts nested
    // batch, sends msgB, completes. A resumes and throws. Fix: messages
    // are sent before rethrowing.

    let resolveYield: () => void;
    const yieldPromise = new Promise<void>(resolve => {
      resolveYield = resolve;
    });

    let innerBatchReturned = false;

    // Start operation A - it will yield, allowing B to interleave
    const operationA = batchMessages(async () => {
      await sendMessages([
        {
          dataset: 'transactions',
          row: 'row-a',
          column: 'amount',
          value: 100,
          timestamp: Timestamp.send(),
        },
      ]);

      // Yield to event loop - B will run during this await
      await yieldPromise;

      // A fails after B has completed
      throw new Error('operation A failed');
    });

    global.stepForwardInTime();

    // B runs while A is yielded. IS_BATCHING is true, so B is nested.
    await batchMessages(async () => {
      await sendMessages([
        {
          dataset: 'transactions',
          row: 'row-b',
          column: 'amount',
          value: 200,
          timestamp: Timestamp.send(),
        },
      ]);
    });
    innerBatchReturned = true;

    // Resume A, which will throw
    resolveYield();

    // A still fails
    await expect(operationA).rejects.toThrow('operation A failed');

    // B returned successfully
    expect(innerBatchReturned).toBe(true);

    // FIX: B's message IS applied despite outer batch failure.
    // All accumulated messages are sent before the error is rethrown.
    const rowB = await db.first<{ id: string }>(
      'SELECT * FROM transactions WHERE id = ?',
      ['row-b'],
    );
    expect(rowB).not.toBeNull();

    // A's message is also applied (consistent with non-batched behavior
    // where each sendMessages call applies immediately)
    const rowA = await db.first<{ id: string }>(
      'SELECT * FROM transactions WHERE id = ?',
      ['row-a'],
    );
    expect(rowA).not.toBeNull();
  });

  it('applies all messages when outer batch succeeds', async () => {
    let resolveYield: () => void;
    const yieldPromise = new Promise<void>(resolve => {
      resolveYield = resolve;
    });

    const operationA = batchMessages(async () => {
      await sendMessages([
        {
          dataset: 'transactions',
          row: 'row-a',
          column: 'amount',
          value: 100,
          timestamp: Timestamp.send(),
        },
      ]);

      // Yield to event loop
      await yieldPromise;
    });

    global.stepForwardInTime();

    // B runs as nested batch
    await batchMessages(async () => {
      await sendMessages([
        {
          dataset: 'transactions',
          row: 'row-b',
          column: 'amount',
          value: 200,
          timestamp: Timestamp.send(),
        },
      ]);
    });

    // Resume A (succeeds)
    resolveYield();
    await operationA;

    // Both messages should be applied
    const rowA = await db.first<{ id: string; amount: number }>(
      'SELECT * FROM transactions WHERE id = ?',
      ['row-a'],
    );
    expect(rowA).not.toBeNull();

    const rowB = await db.first<{ id: string; amount: number }>(
      'SELECT * FROM transactions WHERE id = ?',
      ['row-b'],
    );
    expect(rowB).not.toBeNull();
  });
});
