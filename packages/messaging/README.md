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

## Other Transports

Worker and port messaging use the same `sendMessage` and `onMessage` APIs.

```ts
import { defineWorkerMessaging } from '@webext-core/messaging/worker';
import { definePortMessaging } from '@webext-core/messaging/port';

const workerMessenger = defineWorkerMessaging<ProtocolMap>({
  namespace: 'example',
  worker,
});

const portMessenger = definePortMessaging<ProtocolMap>({
  namespace: 'example',
  port,
});
```

For `worker`, pass a `Worker` reference or `self` inside the worker.
For `port`, pass a `MessagePort`, such as `AudioWorkletNode.port` or a port from `MessageChannel`.

`sendMessage` accepts `{ transfer: [buffer], expectResponse: false }` as its third argument.
Omit `expectResponse` to wait for a response.
With `expectResponse: false`, the promise resolves after posting, without a return value or remote error.

## Get Started

See [documentation](https://webext-core.aklinker1.io/messaging/installation) to
get started!
