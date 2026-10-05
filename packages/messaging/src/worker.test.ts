import { afterEach, describe, expect, it, vi } from 'bun:test';

import { startTestWorker, TestMessagingFactory } from './__tests__/test-worker';

describe('Worker Messenger', () => {
  let cleanupWorkers: Array<() => void> = [];

  async function defineTestWorker(setup: (defineMessaging: TestMessagingFactory) => void) {
    const worker = startTestWorker(setup);
    cleanupWorkers.push(worker.cleanup);
    await worker.ready;
    return worker.defineMessaging;
  }

  afterEach(() => {
    cleanupWorkers.forEach((cleanup) => cleanup());
    cleanupWorkers = [];
  });

  it('should send and return messages', async () => {
    interface MessageSchema {
      test(data: string): number;
      request(data: string): number;
    }
    const defineMessaging = await defineTestWorker((defineMessaging) => {
      const messenger = defineMessaging<MessageSchema>();
      messenger.onMessage('request', ({ data }) => messenger.sendMessage('test', data));
    });
    const messenger = defineMessaging<MessageSchema>();
    const onMessage = vi.fn(({ data }: { data: string }) => data.length);
    messenger.onMessage('test', onMessage);

    const actual = await messenger.sendMessage('request', 'hello');

    expect(actual).toBe(5);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: 'hello',
        timestamp: expect.any(Number),
        id: expect.any(Number),
        type: 'test',
      }),
    );
  });

  it('should isolate messages with different namespaces on the same worker', async () => {
    interface MessageSchema {
      test(data: number): number;
    }
    const defineMessaging = await defineTestWorker((defineMessaging) => {
      defineMessaging<MessageSchema>('a').onMessage('test', ({ data }) => data * 2);
      defineMessaging<MessageSchema>('b').onMessage('test', ({ data }) => data * 3);
    });
    const messengerA = defineMessaging<MessageSchema>('a');
    const messengerB = defineMessaging<MessageSchema>('b');

    const results = await Promise.all([
      messengerA.sendMessage('test', 5),
      messengerB.sendMessage('test', 5),
    ]);

    expect(results).toEqual([10, 15]);
  });

  it('should correlate concurrent responses that arrive out of order', async () => {
    interface MessageSchema {
      test(data: { value: number; deferred: boolean }): number;
      release(): void;
    }
    const defineMessaging = await defineTestWorker((defineMessaging) => {
      const messenger = defineMessaging<MessageSchema>();
      let release: (() => void) | undefined;
      messenger.onMessage('test', ({ data }) => {
        if (!data.deferred) return data.value * 2;
        return new Promise<number>((resolve) => {
          release = () => resolve(data.value * 2);
        });
      });
      messenger.onMessage('release', () => release?.());
    });
    const messenger = defineMessaging<MessageSchema>();
    const completionOrder: number[] = [];

    const slow = messenger.sendMessage('test', { value: 3, deferred: true }).then((result) => {
      completionOrder.push(result);
      return result;
    });
    completionOrder.push(await messenger.sendMessage('test', { value: 7, deferred: false }));
    await messenger.sendMessage('release');

    expect(await slow).toBe(6);
    expect(completionOrder).toEqual([14, 6]);
  });

  it('should throw an error if the responder throws an error', async () => {
    interface MessageSchema {
      test(): void;
    }
    const defineMessaging = await defineTestWorker((defineMessaging) => {
      defineMessaging<MessageSchema>().onMessage('test', async () => {
        throw new TypeError('Worker handler failed');
      });
    });
    const messenger = defineMessaging<MessageSchema>();

    // Await the rejection first. Bun's rejects.toThrow matcher blocks worker message delivery.
    const error = await messenger.sendMessage('test').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'TypeError', message: 'Worker handler failed' });
  });

  it('should reject non-serializable response data', async () => {
    interface MessageSchema {
      test(): { getName(): string };
    }
    const defineMessaging = await defineTestWorker((defineMessaging) => {
      defineMessaging<MessageSchema>().onMessage('test', () => ({ getName: () => 'name' }));
    });
    const messenger = defineMessaging<MessageSchema>();

    const error = await messenger.sendMessage('test').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'DataCloneError' });
  });

  it('should reject non-serializable request data and allow a later request', async () => {
    interface MessageSchema {
      test(data: { value: string | (() => string) }): number;
    }
    const defineMessaging = await defineTestWorker((defineMessaging) => {
      defineMessaging<MessageSchema>().onMessage('test', ({ data }) => {
        return typeof data.value === 'string' ? data.value.length : -1;
      });
    });
    const messenger = defineMessaging<MessageSchema>();

    const error = await messenger
      .sendMessage('test', { value: () => 'hello' })
      .catch((err: unknown) => err);

    expect(error).toMatchObject({ name: 'DataCloneError' });
    expect(await messenger.sendMessage('test', { value: 'hello' })).toBe(5);
  });

  it('should remove handlers and allow new handlers without terminating the worker', async () => {
    interface MessageSchema {
      test(data: number): number;
      request(data: number): number;
    }
    const defineMessaging = await defineTestWorker((defineMessaging) => {
      const messenger = defineMessaging<MessageSchema>();
      messenger.onMessage('request', ({ data }) => messenger.sendMessage('test', data));
    });
    const messenger = defineMessaging<MessageSchema>();
    const oldHandler = vi.fn(() => -1);
    messenger.onMessage('test', oldHandler);

    messenger.removeAllListeners();
    messenger.onMessage('test', ({ data }) => data * 5);
    const actual = await messenger.sendMessage('request', 9);

    expect(actual).toBe(45);
    expect(oldHandler).not.toHaveBeenCalled();
  });

  it('should remove pending response listeners', async () => {
    interface MessageSchema {
      test(): number;
      ready(): void;
      release(): void;
    }
    const defineMessaging = await defineTestWorker((defineMessaging) => {
      const messenger = defineMessaging<MessageSchema>();
      let release: (() => void) | undefined;
      messenger.onMessage(
        'test',
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(6);
          }),
      );
      messenger.onMessage('ready', () => {});
      messenger.onMessage('release', () => release?.());
    });
    const messenger = defineMessaging<MessageSchema>();
    const onResponse = vi.fn();
    void messenger.sendMessage('test').then(onResponse);
    await messenger.sendMessage('ready');

    messenger.removeAllListeners();
    await messenger.sendMessage('release');
    await messenger.sendMessage('ready');

    expect(onResponse).not.toHaveBeenCalled();
  });
});
