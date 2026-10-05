import { afterEach, beforeEach, describe, expectTypeOf, it } from 'bun:test';

import { definePortMessaging } from './port';
import { PostMessageSendOptions } from './types';
import { defineWorkerMessaging } from './worker';

interface MessageSchema {
  length(data: string): number;
  samples(data: Float32Array): number;
  ping(): number;
}

describe.each([
  [
    'Worker',
    (channel: MessageChannel) =>
      defineWorkerMessaging<MessageSchema>({ namespace: 'typing', worker: channel.port1 }),
  ],
  [
    'Port',
    (channel: MessageChannel) =>
      definePortMessaging<MessageSchema>({ namespace: 'typing', port: channel.port1 }),
  ],
] as const)('%s send options', (_, defineMessaging) => {
  let channel: MessageChannel;

  beforeEach(() => {
    channel = new MessageChannel();
  });

  afterEach(() => {
    channel.port1.close();
    channel.port2.close();
  });

  it('should keep the protocol result when a response is expected', () => {
    const messenger = defineMessaging(channel);

    expectTypeOf(messenger.sendMessage('length', 'hello')).toEqualTypeOf<Promise<number>>();
    expectTypeOf(messenger.sendMessage('length', 'hello', { expectResponse: true })).toEqualTypeOf<
      Promise<number>
    >();
    expectTypeOf(messenger.sendMessage('ping')).toEqualTypeOf<Promise<number>>();
  });

  it('should return no value when a response is disabled', () => {
    const messenger = defineMessaging(channel);

    expectTypeOf(messenger.sendMessage('length', 'hello', { expectResponse: false })).toEqualTypeOf<
      Promise<void>
    >();
    expectTypeOf(messenger.sendMessage('ping', undefined, { expectResponse: false })).toEqualTypeOf<
      Promise<void>
    >();
  });

  it('should keep the protocol result when only transfers are supplied', () => {
    const messenger = defineMessaging(channel);
    const samples = new Float32Array([1, 2]);

    expectTypeOf(
      messenger.sendMessage('samples', samples, { transfer: [samples.buffer] }),
    ).toEqualTypeOf<Promise<number>>();
  });

  it('should include both results when the response setting is dynamic', () => {
    const messenger = defineMessaging(channel);
    const options: PostMessageSendOptions = { expectResponse: true };

    expectTypeOf(messenger.sendMessage('length', 'hello', options)).toEqualTypeOf<
      Promise<number | void>
    >();
  });

  it('should require the protocol data and an options object', () => {
    const messenger = defineMessaging(channel);

    // @ts-expect-error: The protocol requires string data.
    messenger.sendMessage('length');
    // @ts-expect-error: Transfers belong in the options object.
    messenger.sendMessage('length', 'hello', []);
  });
});
