import { useEffect, useRef } from 'react';

type Handlers = Record<string, (data: any, es: EventSource) => void>;

export interface SseOptions {
  onOpen?: () => void;
  onError?: () => void;
}

/**
 * Subscribe to an SSE endpoint. Handlers are keyed by event name.
 * Pass url=null to disable. EventSource reconnects automatically unless a
 * handler closes it (e.g. on an 'end' event).
 *
 * `onOpen`/`onError` exist so the shell can surface a "Reconnecting…" strip;
 * they are kept in a ref so passing inline closures never re-opens the stream.
 */
export function useSSE(url: string | null, handlers: Handlers, options: SseOptions = {}) {
  const handlersRef = useRef<Handlers>(handlers);
  handlersRef.current = handlers;
  const optionsRef = useRef<SseOptions>(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    const names = Object.keys(handlersRef.current);
    const listeners: Record<string, (e: MessageEvent) => void> = {};
    for (const name of names) {
      const listener = (e: MessageEvent) => {
        let data: any = e.data;
        try {
          data = JSON.parse(e.data);
        } catch {}
        handlersRef.current[name]?.(data, es);
      };
      listeners[name] = listener;
      es.addEventListener(name, listener);
    }
    const onOpen = () => optionsRef.current.onOpen?.();
    const onError = () => optionsRef.current.onError?.();
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    return () => {
      for (const [name, l] of Object.entries(listeners)) es.removeEventListener(name, l);
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.close();
    };
  }, [url]);
}
