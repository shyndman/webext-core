# `@webext-core/messaging`

A light-weight, type-safe wrapper around the `browser.runtime` messaging APIs.
Supports all browsers (Chrome, Firefox, Safari).

```ts
// ./messaging.ts
import { defineExtensionMessaging } from '@webext-core/messaging';

interface ProtocolMap {
  getStringLength(s: string): number;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
```

```ts
// ./background.ts
import { onMessage } from './messaging';

onMessage('getStringLength', (message) => {
  return message.data.length;
});
```

```ts
// ./content-script.js or anywhere else
import { sendMessage } from './messaging';

const length = await sendMessage('getStringLength', 'hello world');

console.log(length); // 11
```

## Worker Messaging

Import `defineWorkerMessaging` from `@webext-core/messaging/worker`.
Use the same namespace and protocol map in both contexts.
The context that holds a `Worker` reference can be a page or another worker.

```ts
// Context that holds the Worker reference
import { defineWorkerMessaging } from '@webext-core/messaging/worker';
import type { ProtocolMap } from './protocol';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const messenger = defineWorkerMessaging<ProtocolMap>({ namespace: 'example', worker });
const length = await messenger.sendMessage('getStringLength', 'hello world');
```

```ts
// worker.ts
import { defineWorkerMessaging } from '@webext-core/messaging/worker';
import type { ProtocolMap } from './protocol';

const messenger = defineWorkerMessaging<ProtocolMap>({
  namespace: 'example',
  worker: self,
});
messenger.onMessage('getStringLength', ({ data }) => data.length);
```

Define `getStringLength(s: string): number` in the shared `ProtocolMap`.
Both contexts can send messages and register handlers.
Call `removeAllListeners()` to remove handlers and pending response listeners.
This does not terminate the worker.

### Worker Tests

The automated tests use a real Bun `Worker`.
Each test defines its protocol and worker handlers beside its assertions.
The shared helper starts and stops workers.
From `packages/messaging`, run:

```sh
bun test src/worker.test.ts
```

Run `bun test` from the same directory to include the existing messaging tests.

## Port Messaging

Import `definePortMessaging` from `@webext-core/messaging/port`.
Use the same namespace and protocol map at both ends of the channel.

```ts
import { definePortMessaging } from '@webext-core/messaging/port';

interface ProtocolMap {
  getByteLength(data: Uint8Array): number;
}

const channel = new MessageChannel();
const sender = definePortMessaging<ProtocolMap>({
  namespace: 'example',
  port: channel.port1,
});
const receiver = definePortMessaging<ProtocolMap>({
  namespace: 'example',
  port: channel.port2,
});
receiver.onMessage('getByteLength', ({ data }) => data.byteLength);

const bytes = new Uint8Array([1, 2, 3]);
const length = await sender.sendMessage('getByteLength', bytes, [bytes.buffer]);
// length is 3. The sender's buffer is detached.
```

The optional third argument lists the objects to transfer with the request.
Responses use normal cloning and do not accept a transfer list.
For AudioWorklets, use `AudioWorkletNode.port` outside the processor and `this.port` inside the processor.
The messenger does not call `structuredClone()`.
It starts the port but does not close it when `removeAllListeners()` runs.
The caller owns and closes the port.

**IMPORTANT: A successful `postMessage` call does not guarantee delivery.**
Receiver-side deserialization failures raise `messageerror` on the receiving port.
The port does not report these failures to the sender.
This messenger does not send an error response for them.
The caller's `sendMessage` promise can remain pending.

### Port Tests

The automated tests use real `MessageChannel` ports.
Each test defines its protocol, handlers, and assertions in the same place.
From `packages/messaging`, run:

```sh
bun test src/port.test.ts
```

## Get Started

See [documentation](https://webext-core.aklinker1.io/messaging/installation) to
get started!
