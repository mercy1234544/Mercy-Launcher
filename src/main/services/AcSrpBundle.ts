// The SRP server requirements, vendored VERBATIM from the owner's handoff
// package (src/main/data/assettocorsa-srp/ — hashes are asserted against
// MANIFEST.json in test/assettocorsa/requirements-checker.test.js, so a
// hand-edit or drift is caught). Never edit these JSON files here: they are
// produced on the server side and versioned by their own schemaVersion.
import type { SrpBundle } from './AcRequirementsChecker';
import mainReq from '../data/assettocorsa-srp/SERVER_REQUIREMENTS/main.requirements.json';
import server2Req from '../data/assettocorsa-srp/SERVER_REQUIREMENTS/server2.requirements.json';
import tracks from '../data/assettocorsa-srp/CONTENT_INVENTORY/tracks.json';
import sources from '../data/assettocorsa-srp/CONTENT_INVENTORY/acquisition_sources.json';
import boardRelease from '../data/assettocorsa-srp/COMPANION_APPS/srp_board/srp_board_release.json';

export function getBundledSrpBundle(): SrpBundle {
  return {
    servers: [mainReq, server2Req] as unknown as SrpBundle['servers'],
    tracks: tracks as unknown as SrpBundle['tracks'],
    sources: sources as unknown as SrpBundle['sources'],
    boardRelease: boardRelease as unknown as SrpBundle['boardRelease'],
  };
}

export function listBundledSrpServers(): { id: string; displayName: string; type: string }[] {
  return getBundledSrpBundle().servers.map((s) => ({ id: s.server.id, displayName: s.server.displayName, type: s.server.type }));
}
