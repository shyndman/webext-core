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

## Get Started

See [documentation](https://webext-core.aklinker1.io/messaging/installation) to
get started!
