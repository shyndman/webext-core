import { serializeError } from '@aklinker1/zero-serialize-error';

import { PostMessageMessenger, defineGenericMessanging } from './generic';
import { NamespaceMessagingConfig, Message, PostMessageSendOptions } from './types';
import { createId } from './utils';

const REQUEST_TYPE = '@webext-core/messaging/worker';
const RESPONSE_TYPE = '@webext-core/messaging/worker/response';

/**
 * The message API shared by a `Worker` reference and its global scope.
 *
 * Use the `Worker` reference in any context that holds it. Use `self` inside the worker.
 */
export interface WorkerMessagingTarget {
  postMessage(message: unknown, options?: StructuredSerializeOptions): void;
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

/**
 * `sendMessage` accepts native transfer options and `expectResponse: false` to send without waiting
 * for a response. Responses use normal cloning without a transfer list.
 */
export type WorkerSendMessageArgs = [options?: PostMessageSendOptions];

/** Messenger returned by `defineWorkerMessaging`. */
export type WorkerMessenger<TProtocolMap extends Record<string, any>> =
  PostMessageMessenger<TProtocolMap>;

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

  const removeAdditionalListeners = new Set<() => void>();

  const sendWorkerMessage = (
    message: Message<TProtocolMap, any>,
    options: PostMessageSendOptions = {},
  ) => {
    const expectResponse = options.expectResponse !== false;
    const request = { type: REQUEST_TYPE, message, namespace, instanceId, expectResponse };
    if (!expectResponse) {
      try {
        worker.postMessage(request, options);
        return Promise.resolve({ res: undefined });
      } catch (err) {
        config.logger?.error('[messaging] Failed to send worker message', err);
        return Promise.reject(err);
      }
    }
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();

    const responseListener = (event: MessageEvent) => {
      if (
        event.data.type === RESPONSE_TYPE &&
        event.data.namespace === namespace &&
        event.data.instanceId !== instanceId &&
        event.data.message.type === message.type &&
        event.data.message.id === message.id
      ) {
        removeResponseListener();
        resolve(event.data.response);
      }
    };
    const removeResponseListener = () => {
      worker.removeEventListener('message', responseListener);
      removeAdditionalListeners.delete(removeResponseListener);
    };
    removeAdditionalListeners.add(removeResponseListener);
    worker.addEventListener('message', responseListener);
    try {
      worker.postMessage(request, options);
    } catch (err) {
      removeResponseListener();
      config.logger?.error('[messaging] Failed to send worker message', err);
      reject(err);
    }
    return promise;
  };

  const messenger = defineGenericMessanging<TProtocolMap, {}, WorkerSendMessageArgs>({
    ...config,

    sendMessage(message, options) {
      return sendWorkerMessage(message, options);
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
        if (event.data.expectResponse === false) {
          if (response && 'err' in response)
            config.logger?.error('[messaging] Worker message handler failed', response.err);
          return;
        }
        const responseMessage = {
          type: RESPONSE_TYPE,
          response,
          instanceId,
          message: { id: event.data.message.id, type: event.data.message.type },
          namespace,
        };
        try {
          worker.postMessage(responseMessage);
        } catch (err) {
          config.logger?.error('[messaging] Failed to send worker response', err);
          worker.postMessage({ ...responseMessage, response: { err: serializeError(err) } });
        }
      };

      worker.addEventListener('message', listener);
      return () => worker.removeEventListener('message', listener);
    },
  });

  return {
    ...messenger,
    removeAllListeners() {
      messenger.removeAllListeners();
      removeAdditionalListeners.forEach((removeListener) => removeListener());
      removeAdditionalListeners.clear();
    },
  } as WorkerMessenger<TProtocolMap>;
}
