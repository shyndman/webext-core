import { defineWorkerMessaging, WorkerMessenger } from '../worker';

const DEFAULT_NAMESPACE = 'default-namespace';
const READY_MESSAGE = 'worker-test-ready';

export type TestMessagingFactory = <T extends Record<string, any>>(
  namespace?: string,
) => WorkerMessenger<T>;

/** The setup runs inside the worker and must not capture values from the caller. */
export function startTestWorker(setup: (defineMessaging: TestMessagingFactory) => void) {
  const source = `
    import { defineWorkerMessaging } from ${JSON.stringify(new URL('../worker.ts', import.meta.url).href)};
    const defineMessaging = (namespace = ${JSON.stringify(DEFAULT_NAMESPACE)}) =>
      defineWorkerMessaging({ namespace, worker: self });
    (${setup.toString()})(defineMessaging);
    self.postMessage(${JSON.stringify(READY_MESSAGE)});
  `;
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  const worker = new Worker(url);
  const messengers: Array<{ removeAllListeners(): void }> = [];
  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = ({ data }: MessageEvent<unknown>) => {
      if (data !== READY_MESSAGE) return;
      worker.removeEventListener('message', onMessage);
      resolve();
    };
    const onError = (event: ErrorEvent) => {
      console.error('Worker test failed', event.message);
      reject(new Error(event.message));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
  });
  const defineMessaging: TestMessagingFactory = <T extends Record<string, any>>(
    namespace = DEFAULT_NAMESPACE,
  ) => {
    const messenger = defineWorkerMessaging<T>({ namespace, worker });
    messengers.push(messenger);
    return messenger;
  };

  return {
    ready,
    defineMessaging,
    cleanup() {
      messengers.forEach((messenger) => messenger.removeAllListeners());
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
