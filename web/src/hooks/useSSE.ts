import { useEffect, useRef } from 'react';

type Handlers = Record<string, (data: any, es: EventSource) => void>;

/**
 * Subscribe to an SSE endpoint. Handlers are keyed by event name.
 * Pass url=null to disable. EventSource reconnects automatically unless a
 * handler closes it (e.g. on an 'end' event).
 */
export function useSSE(url: string | null, handlers: Handlers) {
  const handlersRef = useRef<Handlers>(handlers);
  handlersRef.current = handlers;

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
    return () => {
      for (const [name, l] of Object.entries(listeners)) es.removeEventListener(name, l);
      es.close();
    };
  }, [url]);
}
