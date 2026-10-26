declare module 'multicast-dns' {
  import type { EventEmitter } from 'node:events';
  interface Answer { name: string; type: string; ttl?: number; class?: string; flush?: boolean; data: unknown }
  interface Packet { questions: { name: string; type: string }[]; answers: Answer[] }
  interface MulticastDns extends EventEmitter {
    respond(packet: { answers: Answer[]; additionals?: Answer[] }, cb?: (err?: Error) => void): void;
    destroy(cb?: () => void): void;
    on(event: 'query', listener: (packet: Packet) => void): this;
    on(event: 'error' | 'warning', listener: (err: Error) => void): this;
  }
  export default function multicastDns(opts?: Record<string, unknown>): MulticastDns;
}
