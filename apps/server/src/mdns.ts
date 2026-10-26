/**
 * On-prem LAN discovery: advertises `<hostname>._scgerp._tcp.local` (PTR / SRV / TXT / A) over mDNS so the
 * Tauri client can list main machines (apps/desktop/src-tauri/src/discovery.rs). Pure JS (multicast-dns).
 */
import os from 'node:os';
import multicastDns from 'multicast-dns';
import type { FastifyBaseLogger } from 'fastify';

export function advertiseMdns(opts: { serviceType: string; port: number; version: string; https: boolean; log: FastifyBaseLogger }): () => void {
  const host = os.hostname().replace(/\.local$/, '');
  const service = `${opts.serviceType}.local`;
  const instance = `${host}.${service}`;
  const target = `${host}.local`;
  const ipv4 = () =>
    Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

  const records = () => [
    { name: service, type: 'PTR', ttl: 120, data: instance },
    { name: instance, type: 'SRV', ttl: 120, data: { port: opts.port, target, priority: 0, weight: 0 } },
    { name: instance, type: 'TXT', ttl: 120, data: [`v=${opts.version}`, `scheme=${opts.https ? 'https' : 'http'}`, 'path=/'] },
    ...ipv4().map((a) => ({ name: target, type: 'A', ttl: 120, data: a })),
  ];

  const mdns = multicastDns();
  mdns.on('error', (err) => opts.log.warn({ err }, 'mDNS error'));
  mdns.on('warning', (err) => opts.log.warn({ err }, 'mDNS warning'));
  mdns.on('query', (q) => {
    const asked = q.questions.some((x) => [service, instance, target, '_services._dns-sd._udp.local'].includes(x.name));
    if (asked) mdns.respond({ answers: records() });
  });
  mdns.respond({ answers: records() }); // unsolicited announcement at start
  opts.log.info({ instance, port: opts.port }, 'mDNS advertising');
  return () => mdns.destroy();
}
