import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

import { definePortMessaging, PortMessenger } from './port';

describe('Port Messenger', () => {
  let channel: MessageChannel;
  let messengers: Array<{ removeAllListeners(): void }>;

  function defineTestMessaging<T extends Record<string, any>>(
    port: MessagePort,
    namespace = 'default-namespace',
  ): PortMessenger<T> {
    const messenger = definePortMessaging<T>({ namespace, port });
    messengers.push(messenger);
    return messenger;
  }

  beforeEach(() => {
    channel = new MessageChannel();
    messengers = [];
  });

  afterEach(() => {
    messengers.forEach((messenger) => messenger.removeAllListeners());
    channel.port1.close();
    channel.port2.close();
  });

  it('should send and return messages', async () => {
    interface MessageSchema {
      test(data: string): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const onMessage = vi.fn(({ data }: { data: string }) => data.length);
    messenger2.onMessage('test', onMessage);

    const actual = await messenger1.sendMessage('test', 'hello');

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

  it('should not send messages to a messenger with a different namespace', async () => {
    interface MessageSchema {
      test(data: string): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port2, 'b');
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2, 'a');
    const messenger3 = defineTestMessaging<MessageSchema>(channel.port1, 'a');
    const onMessage1 = vi.fn(() => -1);
    const onMessage2 = vi.fn(({ data }: { data: string }) => data.length);
    messenger1.onMessage('test', onMessage1);
    messenger2.onMessage('test', onMessage2);

    const actual = await messenger3.sendMessage('test', 'hello');

    expect(actual).toBe(5);
    expect(onMessage1).not.toHaveBeenCalled();
    expect(onMessage2).toHaveBeenCalledTimes(1);
  });

  it('should return the first response', async () => {
    interface MessageSchema {
      test(): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port2);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const messenger3 = defineTestMessaging<MessageSchema>(channel.port1);
    const slowResponse = Promise.withResolvers<number>();
    const onMessageSlow = vi.fn(() => slowResponse.promise);
    const onMessageFast = vi.fn(() => 7);
    messenger1.onMessage('test', onMessageSlow);
    messenger2.onMessage('test', onMessageFast);

    const actual = await messenger3.sendMessage('test');
    slowResponse.resolve(-1);

    expect(actual).toBe(7);
    expect(onMessageSlow).toHaveBeenCalledTimes(1);
    expect(onMessageFast).toHaveBeenCalledTimes(1);
  });

  it('should correlate concurrent responses that arrive out of order', async () => {
    interface MessageSchema {
      test(data: string): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const slowResponse = Promise.withResolvers<number>();
    const completionOrder: number[] = [];
    messenger2.onMessage('test', ({ data }) => (data === 'slow' ? slowResponse.promise : 7));

    const slow = messenger1.sendMessage('test', 'slow').then((result) => {
      completionOrder.push(result);
      return result;
    });
    completionOrder.push(await messenger1.sendMessage('test', 'fast'));
    slowResponse.resolve(3);

    expect(await slow).toBe(3);
    expect(completionOrder).toEqual([7, 3]);
  });

  it('should throw an error if the responder throws an error', async () => {
    interface MessageSchema {
      test(): void;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    messenger2.onMessage('test', async () => {
      throw new TypeError('Port handler failed');
    });

    const error = await messenger1.sendMessage('test').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'TypeError', message: 'Port handler failed' });
  });

  it('should reject non-serializable response data', async () => {
    interface MessageSchema {
      test(): { getName(): string };
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    messenger2.onMessage('test', () => ({ getName: () => 'name' }));

    const error = await messenger1.sendMessage('test').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'DataCloneError' });
  });

  it('should reject non-serializable request data and allow a later request', async () => {
    interface MessageSchema {
      test(data: { value: string | (() => string) }): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const onMessage = vi.fn(({ data }: { data: { value: string | (() => string) } }) => {
      return typeof data.value === 'string' ? data.value.length : -1;
    });
    messenger2.onMessage('test', onMessage);

    const error = await messenger1
      .sendMessage('test', { value: () => 'hello' })
      .catch((err: unknown) => err);
    const actual = await messenger1.sendMessage('test', { value: 'hello' });

    expect(error).toMatchObject({ name: 'DataCloneError' });
    expect(actual).toBe(5);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('should send the same message type between instances in both directions', async () => {
    interface MessageSchema {
      test(data: string): string;
    }
    const messengerA1 = defineTestMessaging<MessageSchema>(channel.port1, 'a');
    const messengerA2 = defineTestMessaging<MessageSchema>(channel.port2, 'a');
    const messengerB1 = defineTestMessaging<MessageSchema>(channel.port1, 'b');
    const messengerB2 = defineTestMessaging<MessageSchema>(channel.port2, 'b');
    messengerA1.onMessage('test', ({ data }) => `A1:${data}`);
    messengerA2.onMessage('test', ({ data }) => `A2:${data}`);
    messengerB1.onMessage('test', ({ data }) => `B1:${data}`);
    messengerB2.onMessage('test', ({ data }) => `B2:${data}`);

    const results = await Promise.all([
      messengerA1.sendMessage('test', 'from-A1'),
      messengerA2.sendMessage('test', 'from-A2'),
      messengerB1.sendMessage('test', 'from-B1'),
      messengerB2.sendMessage('test', 'from-B2'),
    ]);

    expect(results).toEqual(['A2:from-A1', 'A1:from-A2', 'B2:from-B1', 'B1:from-B2']);
  });

  it("should transfer a buffer and detach the sender's buffer", async () => {
    interface MessageSchema {
      test(data: Uint8Array): number[];
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const bytes = new Uint8Array([4, 8, 12]);
    messenger2.onMessage('test', ({ data }) => Array.from(data));

    const actual = await messenger1.sendMessage('test', bytes, { transfer: [bytes.buffer] });

    expect(actual).toEqual([4, 8, 12]);
    expect(bytes.buffer.byteLength).toBe(0);
  });

  it('should transfer a port without echoing it in the response', async () => {
    interface MessageSchema {
      test(data: MessagePort): void;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const transferred = new MessageChannel();
    const received = Promise.withResolvers<string>();
    transferred.port1.addEventListener('message', ({ data }: MessageEvent<string>) =>
      received.resolve(data),
    );
    transferred.port1.start();
    messenger2.onMessage('test', ({ data }) => {
      data.postMessage('transferred port works');
      data.close();
    });

    try {
      await messenger1.sendMessage('test', transferred.port2, { transfer: [transferred.port2] });
      expect(await received.promise).toBe('transferred port works');
    } finally {
      transferred.port1.close();
      transferred.port2.close();
    }
  });

  it('should reject an invalid transfer list without delivering the request', async () => {
    interface MessageSchema {
      test(data: Uint8Array): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const bytes = new Uint8Array([4, 8, 12]);
    const onMessage = vi.fn(({ data }: { data: Uint8Array }) => data.byteLength);
    messenger2.onMessage('test', onMessage);

    const error = await messenger1
      .sendMessage('test', bytes, { transfer: [bytes.buffer, bytes.buffer] })
      .catch((err: unknown) => err);
    const actual = await messenger1.sendMessage('test', bytes, { transfer: [bytes.buffer] });

    expect(error).toMatchObject({ name: 'DataCloneError' });
    expect(actual).toBe(3);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('should remove handlers without closing the port', async () => {
    interface MessageSchema {
      test(data: number): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const oldHandler = vi.fn(() => -1);
    messenger2.onMessage('test', oldHandler);

    messenger2.removeAllListeners();
    messenger2.onMessage('test', ({ data }) => data * 5);
    const actual = await messenger1.sendMessage('test', 9);

    expect(actual).toBe(45);
    expect(oldHandler).not.toHaveBeenCalled();
  });

  it('should remove pending response listeners', async () => {
    interface MessageSchema {
      test(): number;
      ready(): void;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const response = Promise.withResolvers<number>();
    const onResponse = vi.fn();
    messenger2.onMessage('test', () => response.promise);
    messenger2.onMessage('ready', () => {});
    void messenger1.sendMessage('test').then(onResponse);
    await messenger1.sendMessage('ready');

    messenger1.removeAllListeners();
    response.resolve(6);
    await messenger1.sendMessage('ready');

    expect(onResponse).not.toHaveBeenCalled();
  });

  it('should resolve no-response sends without a receiver handler', async () => {
    interface MessageSchema {
      test(data: string): number;
    }
    const messenger = defineTestMessaging<MessageSchema>(channel.port1);

    expect(await messenger.sendMessage('test', 'hello', { expectResponse: false })).toBeUndefined();
  });

  it('should not wait for deferred no-response handlers or send a response frame', async () => {
    interface MessageSchema {
      test(): number;
      ready(): void;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<number>();
    const completed = Promise.withResolvers<void>();
    const frames: unknown[] = [];
    channel.port1.addEventListener('message', ({ data }) => frames.push(data));
    channel.port1.start();
    messenger2.onMessage('test', async () => {
      entered.resolve();
      const result = await response.promise;
      completed.resolve();
      return result;
    });
    messenger2.onMessage('ready', () => {});

    expect(
      await messenger1.sendMessage('test', undefined, { expectResponse: false }),
    ).toBeUndefined();
    await entered.promise;
    response.resolve(7);
    await completed.promise;
    await messenger1.sendMessage('ready');

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ message: { type: 'ready' } });
  });

  it('should deliver transferred data without waiting for a response', async () => {
    interface MessageSchema {
      test(data: Uint8Array): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const received = Promise.withResolvers<number[]>();
    messenger2.onMessage('test', ({ data }) => {
      received.resolve(Array.from(data));
      return data.byteLength;
    });
    const bytes = new Uint8Array([4, 8, 12]);

    const actual = await messenger1.sendMessage('test', bytes, {
      transfer: [bytes.buffer],
      expectResponse: false,
    });

    expect(actual).toBeUndefined();
    expect(bytes.buffer.byteLength).toBe(0);
    expect(await received.promise).toEqual([4, 8, 12]);
  });

  it('should wait for a void handler to complete by default', async () => {
    interface MessageSchema {
      test(): void;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const entered = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<void>();
    let acknowledged = false;
    messenger2.onMessage('test', async () => {
      entered.resolve();
      await completion.promise;
    });

    const acknowledgment = messenger1.sendMessage('test').then(() => {
      acknowledged = true;
    });
    await entered.promise;
    expect(acknowledged).toBe(false);
    completion.resolve();
    await acknowledgment;
    expect(acknowledged).toBe(true);
  });

  it('should log no-response handler errors locally without a response frame', async () => {
    interface MessageSchema {
      test(): void;
      ready(): void;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const logged = Promise.withResolvers<unknown[]>();
    const error = vi.fn((...args: unknown[]) => logged.resolve(args));
    const messenger2 = definePortMessaging<MessageSchema>({
      port: channel.port2,
      namespace: 'default-namespace',
      logger: { debug: () => {}, log: () => {}, warn: () => {}, error },
    });
    messengers.push(messenger2);
    const frames: unknown[] = [];
    channel.port1.addEventListener('message', ({ data }) => frames.push(data));
    channel.port1.start();
    messenger2.onMessage('test', () => {
      throw new TypeError('No-response handler failed');
    });
    messenger2.onMessage('ready', () => {});

    expect(
      await messenger1.sendMessage('test', undefined, { expectResponse: false }),
    ).toBeUndefined();
    const args = await logged.promise;
    await messenger1.sendMessage('ready');

    expect(args[1]).toMatchObject({ name: 'TypeError', message: 'No-response handler failed' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ message: { type: 'ready' } });
  });

  it('should reject invalid transfers on no-response sends without delivering data', async () => {
    interface MessageSchema {
      test(data: Uint8Array): number;
    }
    const messenger1 = defineTestMessaging<MessageSchema>(channel.port1);
    const messenger2 = defineTestMessaging<MessageSchema>(channel.port2);
    const onMessage = vi.fn(({ data }: { data: Uint8Array }) => data.byteLength);
    messenger2.onMessage('test', onMessage);
    const bytes = new Uint8Array([4, 8, 12]);

    const error = await messenger1
      .sendMessage('test', bytes, {
        transfer: [bytes.buffer, bytes.buffer],
        expectResponse: false,
      })
      .catch((err: unknown) => err);
    const actual = await messenger1.sendMessage('test', bytes, { transfer: [bytes.buffer] });

    expect(error).toMatchObject({ name: 'DataCloneError' });
    expect(actual).toBe(3);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});
