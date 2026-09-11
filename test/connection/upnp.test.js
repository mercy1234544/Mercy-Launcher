// UPnP IGD port mapping tests — deterministic, against a FAKE transport
// (no real router, no real network). See UpnpPortMapper.ts's own header for
// what remains unverified against real router hardware.
const path = require('path');
const { UpnpIgdPortMapper, extractControlUrl } = require(path.resolve(__dirname, '../../dist/main/services/connection/UpnpPortMapper.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const REAL_LOOKING_DEVICE_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <deviceList>
      <device>
        <deviceList>
          <device>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                <controlURL>/ctl/IPConn</controlURL>
              </service>
            </serviceList>
          </device>
        </deviceList>
      </device>
    </deviceList>
  </device>
</root>`;

// ── extractControlUrl — pure parsing ────────────────────────────────────────
const parsed = extractControlUrl(REAL_LOOKING_DEVICE_XML, 'http://192.168.1.1:1900/rootDesc.xml');
ok('extracts the real WANIPConnection controlURL, resolved against the device description base URL', parsed?.controlUrl === 'http://192.168.1.1:1900/ctl/IPConn');
ok('extracts the real service type alongside the control URL', parsed?.serviceType === 'urn:schemas-upnp-org:service:WANIPConnection:1');
ok('malformed/unexpected XML never throws — returns null instead', extractControlUrl('<not-upnp-at-all/>', 'http://x/') === null);
ok('empty input never throws', extractControlUrl('', 'http://x/') === null);

// ── UpnpIgdPortMapper — orchestration against a fake transport ─────────────
function fakeTransport({ discover = 'http://192.168.1.1:1900/rootDesc.xml', xml = REAL_LOOKING_DEVICE_XML, mapResponse = '<Envelope/>', externalIp = '203.0.113.5' } = {}) {
  return {
    discoverGatewayLocation: async () => discover,
    fetchText: async () => xml,
    soapRequest: async (_url, _svc, action) => {
      if (action === 'AddPortMapping') return mapResponse;
      if (action === 'GetExternalIPAddress') return `<NewExternalIPAddress>${externalIp}</NewExternalIPAddress>`;
      return '<Envelope/>';
    },
  };
}

(async () => {
  const happyMapper = new UpnpIgdPortMapper(fakeTransport());
  const happyResult = await happyMapper.mapPort(25565, 'TCP', 'Mercy Launcher', 3600);
  ok('a successful mapping reports success with the real external address/port', happyResult.success === true && happyResult.externalAddress === '203.0.113.5' && happyResult.externalPort === 25565);

  const noGatewayMapper = new UpnpIgdPortMapper(fakeTransport({ discover: null }));
  const noGatewayResult = await noGatewayMapper.mapPort(25565, 'TCP', 'Mercy Launcher', 3600);
  ok('no responding gateway is an honest failure, never a fabricated success', noGatewayResult.success === false && /no upnp-capable gateway/i.test(noGatewayResult.reason));

  const noWanServiceMapper = new UpnpIgdPortMapper(fakeTransport({ xml: '<root><device/></root>' }));
  const noWanServiceResult = await noWanServiceMapper.mapPort(25565, 'TCP', 'Mercy Launcher', 3600);
  ok('a gateway with no WANIPConnection/WANPPPConnection service fails honestly', noWanServiceResult.success === false);

  const rejectedMapper = new UpnpIgdPortMapper(fakeTransport({ mapResponse: '<Envelope><Fault><faultcode>UPnPError</faultcode></Fault></Envelope>' }));
  const rejectedResult = await rejectedMapper.mapPort(25565, 'TCP', 'Mercy Launcher', 3600);
  ok('a router that rejects the mapping request (SOAP fault) is an honest failure', rejectedResult.success === false);

  const throwingTransport = { discoverGatewayLocation: async () => { throw new Error('network unreachable'); }, fetchText: async () => '', soapRequest: async () => '' };
  const throwingMapper = new UpnpIgdPortMapper(throwingTransport);
  const throwingResult = await throwingMapper.mapPort(25565, 'TCP', 'Mercy Launcher', 3600);
  ok('an unexpected network error never throws out of mapPort — resolves as an honest failure', throwingResult.success === false && /upnp mapping failed/i.test(throwingResult.reason));

  // unmapPort must never throw even when nothing is mappable (best-effort cleanup)
  let unmapThrew = false;
  try { await noGatewayMapper.unmapPort(25565, 'TCP'); } catch { unmapThrew = true; }
  ok('unmapPort() never throws, even with no gateway — best-effort cleanup only', unmapThrew === false);

  console.log(`\nUPNP TESTS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
