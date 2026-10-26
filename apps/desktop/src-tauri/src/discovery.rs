//! LAN discovery of the main machine via mDNS / DNS-SD.
//!
//! The main machine's server is expected to advertise `_scgerp._tcp.local.` with
//! its HTTPS port. NOTE: that advertisement is server-side work (apps/server) and
//! may not exist yet; until it does this returns an empty list and the user types
//! the IP address instead.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;

pub const SERVICE_TYPE: &str = "_scgerp._tcp.local.";

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredMain {
    /// Instance name, e.g. "SCG Shop ERP (FRONT-PC)".
    pub name: String,
    /// IPv4 address preferred; falls back to the first address seen.
    pub host: String,
    pub port: u16,
}

/// Browse for `timeout` and return every resolved main machine (deduplicated by name).
pub fn browse(timeout: Duration) -> Result<Vec<DiscoveredMain>, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?;
    let rx = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("mDNS browse failed: {e}"))?;

    let deadline = Instant::now() + timeout;
    let mut found: BTreeMap<String, DiscoveredMain> = BTreeMap::new();
    while let Ok(event) = rx.recv_deadline(deadline) {
        if let ServiceEvent::ServiceResolved(info) = event {
            let mut addrs: Vec<IpAddr> = info.get_addresses().iter().map(|a| a.to_ip_addr()).collect();
            addrs.sort_by_key(|a| !a.is_ipv4()); // IPv4 first
            if let Some(addr) = addrs.first() {
                let name = info
                    .get_fullname()
                    .trim_end_matches(SERVICE_TYPE)
                    .trim_end_matches('.')
                    .to_string();
                found.insert(
                    name.clone(),
                    DiscoveredMain { name, host: addr.to_string(), port: info.get_port() },
                );
            }
        }
    }
    let _ = daemon.shutdown();
    Ok(found.into_values().collect())
}
