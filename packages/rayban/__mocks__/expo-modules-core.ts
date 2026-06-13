/**
 * Vitest mock for expo-modules-core.
 *
 * expo-modules-core 2.x exports EventEmitter as globalThis.expo.EventEmitter (C++ native).
 * In a Node test environment that global does not exist, so we supply a pure-JS EventEmitter
 * that matches the class API declared in expo-modules-core's ts-declarations.
 *
 * This file is resolved by vitest's alias config in vitest.config.ts so every import of
 * 'expo-modules-core' in test code and mock files gets the JS EventEmitter.
 */

export type EventsMap = Record<string, (...args: never[]) => void>;

export type EventSubscription = {
  remove(): void;
};

/**
 * Pure-JS EventEmitter compatible with expo-modules-core 2.x EventEmitter<TEventsMap>.
 * Mirrors the web CoreModule implementation from expo-modules-core/src/web/CoreModule.ts.
 */
export class EventEmitter<TEventsMap extends EventsMap = Record<never, never>> {
  private listeners?: Map<keyof TEventsMap, Set<Function>>;

  addListener<EventName extends keyof TEventsMap>(
    eventName: EventName,
    listener: TEventsMap[EventName],
  ): EventSubscription {
    if (!this.listeners) {
      this.listeners = new Map();
    }
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(listener);
    return {
      remove: () => {
        this.removeListener(eventName, listener);
      },
    };
  }

  removeListener<EventName extends keyof TEventsMap>(
    eventName: EventName,
    listener: TEventsMap[EventName],
  ): void {
    this.listeners?.get(eventName)?.delete(listener);
  }

  removeAllListeners(eventName: keyof TEventsMap): void {
    this.listeners?.get(eventName)?.clear();
  }

  emit<EventName extends keyof TEventsMap>(
    eventName: EventName,
    ...args: Parameters<TEventsMap[EventName]>
  ): void {
    const listeners = new Set(this.listeners?.get(eventName));
    listeners.forEach((listener) => {
      try {
        (listener as Function)(...args);
      } catch (error) {
        console.error(error);
      }
    });
  }

  listenerCount(eventName: keyof TEventsMap): number {
    return this.listeners?.get(eventName)?.size ?? 0;
  }
}

/**
 * In tests the native module is never available; the .web.ts mock file is loaded instead
 * via vitest's resolve.extensions ordering.  This stub satisfies any import of
 * requireNativeModule that is NOT shadowed by an extension substitution.
 */
export function requireNativeModule<T = unknown>(_name: string): T {
  throw new Error(
    `requireNativeModule('${_name}') called in test env — ` +
      `ensure the .web.ts mock is being resolved by vitest resolve.extensions config.`,
  );
}

export function requireOptionalNativeModule<T = unknown>(_name: string): T | null {
  return null;
}
