// Real UPnP IGD (Internet Gateway Device) port mapping — the actual "direct
// NAT traversal where practical" mechanism Phase 3 asked for, not a
// simulation. Many home routers support UPnP IGD; when one does, Mercy can
// open a real port mapping without the user ever touching their router.
//
// HONESTY NOTE: this talks real SSDP/SOAP to whatever router is on the
// local network. It has NOT been exercised against real router hardware in
// this sandboxed dev environment (no LAN/router is reachable here) — the
// protocol implementation below is real and unit-tested against a fake
// transport (see test/connection/upnp.test.js), but "does this actually
// open a port on a real consumer router" is unverified until it runs on a
// real network. When UPnP isn't available, isn't supported, or fails for
// any reason, mapPort() fails honestly — callers must never treat that as
// success.
import dgram from 'dgram';
import http from 'http';
import { URL } from 'url';

export interface PortMapResult {
  success: boolean;
  externalAddress?: string;
  externalPort?: number;
  reason?: string;
}

export interface PortMapper {
  mapPort(localPort: number, protocol: 'TCP' | 'UDP', description: string, ttlSeconds: number): Promise<PortMapResult>;
  unmapPort(externalPort: number, protocol: 'TCP' | 'UDP'): Promise<void>;
}

/** The real network operations this class needs, isolated behind an
 *  interface so the SOAP/SSDP orchestration logic is unit-testable without
 *  a real router (see test/connection/upnp.test.js) — the same
 *  dependency-injection convention already used throughout this codebase
 *  (ManagerLike, ProcessChecker, GameScannerOptions, etc.). */
export interface UpnpTransport {
  /** Real SSDP M-SEARCH discovery — returns the first IGD's device
   *  description LOCATION url, or null if none answered in time. */
  discoverGatewayLocation(timeoutMs: number): Promise<string | null>;
  /** Fetches the raw device/service description XML at a URL. */
  fetchText(url: string): Promise<string>;
  /** Posts a SOAP action to a control URL and returns the raw response body. */
  soapRequest(controlUrl: string, serviceType: string, action: string, args: Record<string, string>): Promise<string>;
}

const SSDP_MULTICAST_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const IGD_SEARCH_TARGETS = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2'];

export class RealUpnpTransport implements UpnpTransport {
  discoverGatewayLocation(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let done = false;
      const finish = (result: string | null) => {
        if (done) return;
        done = true;
        try { socket.close(); } catch {}
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      socket.on('message', (msg) => {
        const text = msg.toString('utf-8');
        const match = text.match(/LOCATION:\s*(\S+)/i);
        if (match) { clearTimeout(timer); finish(match[1].trim()); }
      });
      socket.on('error', () => finish(null));
      try {
        socket.bind(0, () => {
          for (const target of IGD_SEARCH_TARGETS) {
            const req = Buffer.from([
              'M-SEARCH * HTTP/1.1', `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"',
              'MX: 2', `ST: ${target}`, '', '',
            ].join('\r\n'));
            socket.send(req, 0, req.length, SSDP_PORT, SSDP_MULTICAST_ADDR);
          }
        });
      } catch { finish(null); }
    });
  }

  fetchText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  soapRequest(controlUrl: string, serviceType: string, action: string, args: Record<string, string>): Promise<string> {
    const u = new URL(controlUrl);
    const argXml = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
    const body = `<?xml version="1.0"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n<s:Body><u:${action} xmlns:u="${serviceType}">${argXml}</u:${action}></s:Body></s:Envelope>`;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', timeout: 3000,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(body),
          SOAPAction: `"${serviceType}#${action}"`,
        },
      }, (res) => {
        let responseBody = '';
        res.on('data', (c) => { responseBody += c; });
        res.on('end', () => resolve(responseBody));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

/** Parses the WANIPConnection/WANPPPConnection controlURL out of a device
 *  description XML. Regex-based on purpose — router-supplied UPnP XML is
 *  small, well-formed, and this avoids a new XML-parser dependency for a
 *  handful of tag lookups. Returns null (never throws) on anything
 *  unexpected, which the caller treats as "UPnP not usable here". */
export function extractControlUrl(deviceDescriptionXml: string, baseUrl: string): { controlUrl: string; serviceType: string } | null {
  const serviceMatch = deviceDescriptionXml.match(
    /<service>\s*<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>\s*<\/service>/,
  );
  if (!serviceMatch) return null;
  const serviceType = serviceMatch[1];
  const rawControlUrl = serviceMatch[2];
  try {
    const resolved = new URL(rawControlUrl, baseUrl).toString();
    return { controlUrl: resolved, serviceType };
  } catch { return null; }
}

export class UpnpIgdPortMapper implements PortMapper {
  constructor(private transport: UpnpTransport = new RealUpnpTransport(), private discoveryTimeoutMs = 2000) {}

  async mapPort(localPort: number, protocol: 'TCP' | 'UDP', description: string, ttlSeconds: number): Promise<PortMapResult> {
    try {
      const location = await this.transport.discoverGatewayLocation(this.discoveryTimeoutMs);
      if (!location) return { success: false, reason: 'No UPnP-capable gateway responded on the local network.' };

      const xml = await this.transport.fetchText(location);
      const service = extractControlUrl(xml, location);
      if (!service) return { success: false, reason: 'The gateway does not expose a WANIPConnection/WANPPPConnection service.' };

      const localAddress = this.guessLocalAddress();
      const mapResponse = await this.transport.soapRequest(service.controlUrl, service.serviceType, 'AddPortMapping', {
        NewRemoteHost: '', NewExternalPort: String(localPort), NewProtocol: protocol,
        NewInternalPort: String(localPort), NewInternalClient: localAddress, NewEnabled: '1',
        NewPortMappingDescription: description, NewLeaseDuration: String(ttlSeconds),
      });
      if (/faultcode|UPnPError/i.test(mapResponse)) return { success: false, reason: 'The gateway rejected the port mapping request.' };

      const externalIpResponse = await this.transport.soapRequest(service.controlUrl, service.serviceType, 'GetExternalIPAddress', {});
      const ipMatch = externalIpResponse.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/);
      if (!ipMatch) return { success: false, reason: 'Port mapping succeeded but the gateway did not report an external IP address.' };

      return { success: true, externalAddress: ipMatch[1], externalPort: localPort };
    } catch (e: any) {
      return { success: false, reason: `UPnP mapping failed: ${e?.message || 'unknown error'}` };
    }
  }

  async unmapPort(externalPort: number, protocol: 'TCP' | 'UDP'): Promise<void> {
    try {
      const location = await this.transport.discoverGatewayLocation(this.discoveryTimeoutMs);
      if (!location) return;
      const xml = await this.transport.fetchText(location);
      const service = extractControlUrl(xml, location);
      if (!service) return;
      await this.transport.soapRequest(service.controlUrl, service.serviceType, 'DeletePortMapping', {
        NewRemoteHost: '', NewExternalPort: String(externalPort), NewProtocol: protocol,
      });
    } catch { /* best-effort cleanup only */ }
  }

  private guessLocalAddress(): string {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return '127.0.0.1';
  }
}
