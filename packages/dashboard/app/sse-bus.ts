import { appendTokenQuery } from "./auth";

// Shared EventSource multiplexer.
//
// Browsers cap HTTP/1.1 connections to a single origin at ~6. Each native
// EventSource holds a slot open indefinitely, so having many hooks/components
// each open their own /api/events connection starves the pool and makes
// every subsequent `fetch` sit pending. This module funnels every consumer
// through one EventSource per URL and fans events out via pub/sub.

type MessageListener = (event: MessageEvent) => void;
type ErrorListener = (event: Event) => void;
type OpenListener = () => void;

const HEARTBEAT_TIMEOUT_MS = 45_000;
const RECONNECT_DELAY_MS = 3_000;

interface Subscriber {
  events: Map<string, Set<MessageListener>>;
  onOpen?: OpenListener;
  onReconnect?: OpenListener;
  onError?: ErrorListener;
}

interface Channel {
  url: string;
  es: EventSource | null;
  subscribers: Set<Subscriber>;
  nativeListeners: Map<string, (event: Event) => void>;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  hasOpenedOnce: boolean;
  /** Set true at the start of closeChannel to prevent reconnect after teardown. */
  closed: boolean;
}

const channels = new Map<string, Channel>();

function resetHeartbeat(channel: Channel): void {
  if (channel.heartbeatTimer) clearTimeout(channel.heartbeatTimer);
  channel.heartbeatTimer = setTimeout(() => {
    forceReconnect(channel);
  }, HEARTBEAT_TIMEOUT_MS);
}

function forceReconnect(channel: Channel): void {
  if (channel.heartbeatTimer) {
    clearTimeout(channel.heartbeatTimer);
    channel.heartbeatTimer = null;
  }
  if (channel.es) {
    channel.es.close();
    channel.es = null;
  }
  channel.nativeListeners.clear();

  if (channel.closed) return;
  if (channel.subscribers.size === 0 || channel.reconnectTimer) return;

  // Guard against calling onReconnect callbacks for a channel that has been
  // closed while the heartbeat timer fired. This prevents stale SSE events from
  // firing into unsubscribed/mounted-out consumers during rapid view switches.
  const ch = channels.get(channel.url);
  if (!ch || ch !== channel) return;

  // A teardown means events may have been missed while the stream was
  // down. Signal resync to each subscriber so they can refetch
  // authoritative state.
  for (const sub of channel.subscribers) sub.onReconnect?.();

  channel.reconnectTimer = setTimeout(() => {
    channel.reconnectTimer = null;
    if (channel.closed) return;
    // Re-check after timer fires — the channel may have been closed or
    // the subscription count changed during the delay.
    const current = channels.get(channel.url);
    if (current && current === channel && channel.subscribers.size > 0) {
      openChannel(channel);
    }
  }, RECONNECT_DELAY_MS);
}

function openChannel(channel: Channel): void {
  if (channel.es) return;
  if (channel.closed) return;
  if (channel.reconnectTimer) {
    clearTimeout(channel.reconnectTimer);
    channel.reconnectTimer = null;
  }

  // EventSource can't set custom headers, so the bearer token must ride on
  // the URL as `fn_token=<token>`. `appendTokenQuery` is a no-op when no
  // token is configured.
  const es = new EventSource(appendTokenQuery(channel.url));
  channel.es = es;

  es.addEventListener("open", () => {
    resetHeartbeat(channel);
    const reconnect = channel.hasOpenedOnce;
    channel.hasOpenedOnce = true;
    for (const sub of channel.subscribers) {
      sub.onOpen?.();
      if (reconnect) sub.onReconnect?.();
    }
  });

  es.addEventListener("error", (event) => {
    for (const sub of channel.subscribers) sub.onError?.(event);
    // Any error triggers a forced reconnect cycle — matches the pre-bus
    // behavior in useTasks and ensures the stream recovers even when
    // EventSource's own retry has stalled.
    forceReconnect(channel);
  });

  // Unnamed `message` events and server "heartbeat" events both count as
  // liveness signals, regardless of whether a subscriber registered them.
  es.addEventListener("message", () => resetHeartbeat(channel));
  es.addEventListener("heartbeat", () => resetHeartbeat(channel));

  reattachNativeListeners(channel);
  resetHeartbeat(channel);
}

function reattachNativeListeners(channel: Channel): void {
  if (!channel.es) return;
  const types = new Set<string>();
  for (const sub of channel.subscribers) {
    for (const type of sub.events.keys()) types.add(type);
  }
  for (const type of types) {
    if (channel.nativeListeners.has(type)) continue;
    const listener = (event: Event) => {
      resetHeartbeat(channel);
      const msg = event as MessageEvent;
      for (const sub of channel.subscribers) {
        const handlers = sub.events.get(type);
        if (!handlers) continue;
        for (const handler of handlers) handler(msg);
      }
    };
    channel.nativeListeners.set(type, listener);
    channel.es.addEventListener(type, listener);
  }
}

function closeChannel(channel: Channel): void {
  channel.closed = true;
  if (channel.heartbeatTimer) clearTimeout(channel.heartbeatTimer);
  if (channel.reconnectTimer) clearTimeout(channel.reconnectTimer);
  if (channel.es) channel.es.close();
  channel.es = null;
  channel.nativeListeners.clear();
  channels.delete(channel.url);
}

export interface SseSubscription {
  /** Map of named SSE event type → handler. */
  events?: Record<string, MessageListener>;
  /** Fires on every successful open (initial + reconnect). */
  onOpen?: OpenListener;
  /** Fires only on reconnects (not the initial open). Use for resync-on-recovery. */
  onReconnect?: OpenListener;
  /** Forwarded EventSource error events. */
  onError?: ErrorListener;
}

/**
 * Subscribe to an SSE URL. All subscribers of the same URL share a single
 * underlying EventSource. Returns an unsubscribe function; when the last
 * subscriber unsubscribes, the connection is closed.
 */
export function subscribeSse(url: string, sub: SseSubscription = {}): () => void {
  let channel = channels.get(url);
  if (!channel) {
    channel = {
      url,
      es: null,
      subscribers: new Set(),
      nativeListeners: new Map(),
      heartbeatTimer: null,
      reconnectTimer: null,
      hasOpenedOnce: false,
      closed: false,
    };
    channels.set(url, channel);
  }

  const subscriber: Subscriber = {
    events: new Map(),
    onOpen: sub.onOpen,
    onReconnect: sub.onReconnect,
    onError: sub.onError,
  };
  if (sub.events) {
    for (const [type, handler] of Object.entries(sub.events)) {
      let handlers = subscriber.events.get(type);
      if (!handlers) {
        handlers = new Set();
        subscriber.events.set(type, handlers);
      }
      handlers.add(handler);
    }
  }

  channel.subscribers.add(subscriber);
  openChannel(channel);
  reattachNativeListeners(channel);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const ch = channels.get(url);
    if (!ch) return;
    ch.subscribers.delete(subscriber);
    if (ch.subscribers.size === 0) closeChannel(ch);
  };
}

/** Test-only: tear down every open channel. */
export function __resetSseBus(): void {
  for (const channel of Array.from(channels.values())) closeChannel(channel);
}

/** Test-only: inspect the number of live channels. */
export function __sseBusChannelCount(): number {
  return channels.size;
}
