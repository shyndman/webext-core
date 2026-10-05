import { GenericMessenger, defineGenericMessanging } from './generic';
import { NamespaceMessagingConfig, Message } from './types';
import { createId } from './utils';

const REQUEST_TYPE = '@webext-core/messaging/worker';
const RESPONSE_TYPE = '@webext-core/messaging/worker/response';

/**
 * The message API shared by a `Worker` reference and its global scope.
 *
 * Use the `Worker` reference in any context that holds it. Use `self` inside the worker.
 */
export interface WorkerMessagingTarget {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

/** Configuration passed into `defineWorkerMessaging`. */
export interface WorkerMessagingConfig extends NamespaceMessagingConfig {
  /**
   * The worker endpoint used to send and receive messages.
   *
   * - Outside the worker -> a `Worker` reference
   * - Inside the worker -> `self`
   *
   * The context that holds the reference can be a page or another worker.
   */
  worker: WorkerMessagingTarget;
}

/** Messenger returned by `defineWorkerMessaging`. */
export type WorkerMessenger<TProtocolMap extends Record<string, any>> = GenericMessenger<
  TProtocolMap,
  {},
  []
>;

/**
 * Returns a `WorkerMessenger` backed by the `Worker.postMessage` API. It can be used to communicate
 * between:
 *
 * - A page and a worker
 * - A worker and a nested worker
 *
 * Use the same namespace and protocol map in both contexts. Both contexts can send messages and
 * register listeners.
 *
 * > See [Worker.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage) for
 * > more details.
 *
 * @example
 *   // ./protocol.ts
 *   export interface WorkerMessengerSchema {
 *     getStringLength(data: string): number;
 *   }
 *
 * @example
 *   // Context that holds the Worker reference
 *   import { defineWorkerMessaging } from '@webext-core/messaging/worker';
 *   import type { WorkerMessengerSchema } from './protocol';
 *
 *   const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
 *   const messenger = defineWorkerMessaging<WorkerMessengerSchema>({
 *     namespace: 'example',
 *     worker,
 *   });
 *
 *   const length = await messenger.sendMessage('getStringLength', 'hello world');
 *
 * @example
 *   // ./worker.ts
 *   import { defineWorkerMessaging } from '@webext-core/messaging/worker';
 *   import type { WorkerMessengerSchema } from './protocol';
 *
 *   const messenger = defineWorkerMessaging<WorkerMessengerSchema>({
 *     namespace: 'example',
 *     worker: self,
 *   });
 *
 *   messenger.onMessage('getStringLength', ({ data }) => data.length);
 */
export function defineWorkerMessaging<
  TProtocolMap extends Record<string, any> = Record<string, any>,
>(config: WorkerMessagingConfig): WorkerMessenger<TProtocolMap> {
  const namespace = config.namespace;
  const worker = config.worker;
  const instanceId = createId();

  let removeAdditionalListeners: Array<() => void> = [];

  const sendWorkerMessage = (message: Message<TProtocolMap, any>) =>
    new Promise((res) => {
      const responseListener = (event: MessageEvent) => {
        if (
          event.data.type === RESPONSE_TYPE &&
          event.data.namespace === namespace &&
          event.data.instanceId !== instanceId &&
          event.data.message.type === message.type &&
          event.data.message.id === message.id
        ) {
          res(event.data.response);
          removeResponseListener();
        }
      };
      const removeResponseListener = () => worker.removeEventListener('message', responseListener);
      removeAdditionalListeners.push(removeResponseListener);
      worker.addEventListener('message', responseListener);
      worker.postMessage({ type: REQUEST_TYPE, message, namespace, instanceId });
    });

  const messenger = defineGenericMessanging<TProtocolMap, {}, []>({
    ...config,

    sendMessage(message) {
      return sendWorkerMessage(message);
    },

    addRootListener(processMessage) {
      const listener = async (event: MessageEvent) => {
        if (
          event.data.type !== REQUEST_TYPE ||
          event.data.namespace !== namespace ||
          event.data.instanceId === instanceId
        )
          return;

        const response = await processMessage(event.data.message);
        worker.postMessage({
          type: RESPONSE_TYPE,
          response,
          instanceId,
          message: event.data.message,
          namespace,
        });
      };

      worker.addEventListener('message', listener);
      return () => worker.removeEventListener('message', listener);
    },
    verifyMessageData(data) {
      return structuredClone(data);
    },
  });

  return {
    ...messenger,
    removeAllListeners() {
      messenger.removeAllListeners();
      removeAdditionalListeners.forEach((removeListener) => removeListener());
      removeAdditionalListeners = [];
    },
  };
}
