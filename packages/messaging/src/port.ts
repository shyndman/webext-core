import { serializeError } from '@aklinker1/zero-serialize-error';

import { GenericMessenger, defineGenericMessanging } from './generic';
import { NamespaceMessagingConfig, Message } from './types';
import { createId } from './utils';

const REQUEST_TYPE = '@webext-core/messaging/port';
const RESPONSE_TYPE = '@webext-core/messaging/port/response';

/** Configuration passed into `definePortMessaging`. */
export interface PortMessagingConfig extends NamespaceMessagingConfig {
  /** The port used to send and receive messages. The caller owns and closes the port. */
  port: MessagePort;
}

/**
 * For a `PortMessenger`, `sendMessage` accepts an additional transfer list. The listed objects must
 * be part of the message data. Transferring an object moves its resources and makes them
 * unavailable to the sender.
 *
 * > See [Transferable
 * > objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
 * > for more details.
 *
 * Responses use normal cloning and do not accept a transfer list.
 */
export type PortSendMessageArgs = [transfer?: Transferable[]];

/** Messenger returned by `definePortMessaging`. */
export type PortMessenger<TProtocolMap extends Record<string, any>> = GenericMessenger<
  TProtocolMap,
  {},
  PortSendMessageArgs
>;

/**
 * Returns a `PortMessenger` backed by the `MessagePort.postMessage` API. It can be used to
 * communicate through:
 *
 * - A `MessageChannel`
 * - A shared worker's port
 * - An `AudioWorkletNode` and its processor's port
 *
 * Use the same namespace and protocol map in both contexts. Both contexts can send messages and
 * register listeners. The messenger starts the port but does not close it when listeners are
 * removed.
 *
 * IMPORTANT: A successful `postMessage` call does not guarantee delivery. Receiver-side
 * deserialization failures raise `messageerror` on the receiving port. The port does not report
 * these failures to the sender, and this messenger does not send an error response for them. The
 * caller's `sendMessage` promise can remain pending.
 *
 * > See
 * > [MessagePort.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort/postMessage)
 * > for more details.
 *
 * @example
 *   // ./protocol.ts
 *   export interface PortMessengerSchema {
 *     getByteLength(data: Uint8Array): number;
 *   }
 *
 * @example
 *   // Caller
 *   import { definePortMessaging } from '@webext-core/messaging/port';
 *   import type { PortMessengerSchema } from './protocol';
 *
 *   const channel = new MessageChannel();
 *   const messenger = definePortMessaging<PortMessengerSchema>({
 *     namespace: 'example',
 *     port: channel.port1,
 *   });
 *
 *   const receiver = definePortMessaging<PortMessengerSchema>({
 *     namespace: 'example',
 *     port: channel.port2,
 *   });
 *   receiver.onMessage('getByteLength', ({ data }) => data.byteLength);
 *
 *   const bytes = new Uint8Array([1, 2, 3]);
 *   const length = await messenger.sendMessage('getByteLength', bytes, [bytes.buffer]);
 */
export function definePortMessaging<TProtocolMap extends Record<string, any> = Record<string, any>>(
  config: PortMessagingConfig,
): PortMessenger<TProtocolMap> {
  const namespace = config.namespace;
  const port = config.port;
  const instanceId = createId();

  let removeAdditionalListeners: Array<() => void> = [];

  const sendPortMessage = (message: Message<TProtocolMap, any>, transfer: Transferable[] = []) =>
    new Promise((res, reject) => {
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
      const removeResponseListener = () => port.removeEventListener('message', responseListener);
      removeAdditionalListeners.push(removeResponseListener);
      port.addEventListener('message', responseListener);
      port.start();
      try {
        port.postMessage({ type: REQUEST_TYPE, message, namespace, instanceId }, transfer);
      } catch (err) {
        removeResponseListener();
        config.logger?.error('[messaging] Failed to send port message', err);
        reject(err);
      }
    });

  const messenger = defineGenericMessanging<TProtocolMap, {}, PortSendMessageArgs>({
    ...config,

    sendMessage(message, transfer) {
      return sendPortMessage(message, transfer);
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
        // Do not echo the request data. It can contain transfer-only objects.
        const responseMessage = {
          type: RESPONSE_TYPE,
          response,
          instanceId,
          message: { id: event.data.message.id, type: event.data.message.type },
          namespace,
        };
        try {
          port.postMessage(responseMessage);
        } catch (err) {
          config.logger?.error('[messaging] Failed to send port response', err);
          port.postMessage({ ...responseMessage, response: { err: serializeError(err) } });
        }
      };

      port.addEventListener('message', listener);
      port.start();
      return () => port.removeEventListener('message', listener);
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
