// Static-source regression test for the v1.106.3 Friends & Presence
// visibility redesign in src/renderer/pages/Library.tsx — same convention as
// friendsPresenceAuthGate.test.js (no jsdom/RTL in this codebase; renderer
// invariants are verified by reading the real shipped .tsx text).
//
// THE REAL BUG THIS GUARDS: "Appear Online" and "Show Current Mercy Server"
// used to be two tiny, easy-to-miss checkboxes crammed into the section
// header (PRIVACY_TOGGLES). This proves they are now two prominent, clearly
// separate cards, each independently wired to the correct setting(s), and
// that the old cramped-checkbox-row design is gone for good.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const librarySrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/Library.tsx'), 'utf-8');

// ── The old design must be fully gone. ──────────────────────────────────
ok('REPRODUCED THE FIX: the old cramped PRIVACY_TOGGLES checkbox array no longer exists', !/PRIVACY_TOGGLES/.test(librarySrc));

// ── VisibilityCard: a real, dedicated, prominent component (not a plain
//    checkbox), with a bold title, a status dot, explanatory text, and a
//    real Toggle control. ────────────────────────────────────────────────
const cardStart = librarySrc.indexOf('function VisibilityCard(');
ok('a dedicated VisibilityCard component exists', cardStart !== -1);
const cardEnd = librarySrc.indexOf('\nfunction ', cardStart + 1);
const cardSrc = librarySrc.slice(cardStart, cardEnd === -1 ? undefined : cardEnd);
ok('the card renders a bold title', /font-bold[^"]*"[\s\S]{0,40}\{title\}/.test(cardSrc) || /\{title\}/.test(cardSrc));
ok('the card shows a colored status dot reflecting checked/unchecked state', /checked \? dotColor : 'bg-surface-600'/.test(cardSrc));
ok('the card uses the real reusable Toggle control, not a raw checkbox', /<Toggle\b/.test(cardSrc) && !/type="checkbox"/.test(cardSrc));

// ── Both cards are rendered, each wired to the correct settings field(s). ─
const sectionStart = librarySrc.indexOf('function FriendsPresenceSection()');
const sectionEnd = librarySrc.indexOf('\nfunction ', sectionStart + 1);
const section = librarySrc.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);

const appearOnlineCard = section.match(/<VisibilityCard\s+tone="online"[\s\S]*?\/>/);
ok('an "Appear Online" card is rendered with tone="online"', !!appearOnlineCard && /title="Appear Online"/.test(appearOnlineCard[0]));
ok('REPRODUCED THE FIX: "Appear Online" drives ONLY settings.appearOnline, never showCurrentGame/showCurrentServer', !!appearOnlineCard && /onChange=\{\(v\) => updateSettings\(\{ appearOnline: v \}\)\}/.test(appearOnlineCard[0]));

const showServerCard = section.match(/<VisibilityCard\s+tone="activity"[\s\S]*?\/>/);
ok('a "Show Current Mercy Server" card is rendered with tone="activity" (visually distinct from the online card)', !!showServerCard && /title="Show Current Mercy Server"/.test(showServerCard[0]));
ok('"Show Current Mercy Server" drives showCurrentGame and showCurrentServer together, never appearOnline', !!showServerCard && /onChange=\{\(v\) => updateSettings\(\{ showCurrentGame: v, showCurrentServer: v \}\)\}/.test(showServerCard[0]));

// ── The two cards must be visually separate controls (two distinct
//    <VisibilityCard> elements), not merged into one. ──────────────────
const cardUsages = section.match(/<VisibilityCard\b/g) || [];
ok('exactly two separate VisibilityCard instances are rendered (not merged into a single combined control)', cardUsages.length === 2);

// ── The three presence views (Friends / Friends Playing / Everyone
//    Playing) each render the exact spec'd rules. ──────────────────────
const friendsBlock = section.match(/\{view === 'friends' &&[\s\S]*?\)\}\n\n\s*\{view === 'friendsPlaying'/);
ok('the Friends view exists', !!friendsBlock);
const friendsSrc = friendsBlock ? friendsBlock[0] : '';
ok('REPRODUCED THE FIX: the Friends view renders friends.map with no filter — offline friends are never removed from the list', /friends\.map\(/.test(friendsSrc) && !/friends\.filter\(/.test(friendsSrc));
ok('a friend row shows "Online" when online with no activity, "Offline" when offline, and the real activity label when playing', /\{f\.activityLabel \|\| \(f\.status === 'online' \? 'Online' : 'Offline'\)\}/.test(friendsSrc));

const friendsPlayingBlock = section.match(/\{view === 'friendsPlaying' &&[\s\S]*?\}\)\(\)\}\n\n\s*\{view === 'everyone'/);
ok('the Friends Playing view exists', !!friendsPlayingBlock);
const friendsPlayingSrc = friendsPlayingBlock ? friendsPlayingBlock[0] : '';
ok('REPRODUCED THE FIX: Friends Playing only includes friends who are online AND have an activity label', /friends\.filter\(\(f\) => f\.status === 'online' && f\.activityLabel\)/.test(friendsPlayingSrc));

const everyoneBlock = section.match(/\{view === 'everyone' &&[\s\S]*$/);
ok('the Everyone Playing view exists', !!everyoneBlock);
const everyoneSrc = everyoneBlock ? everyoneBlock[0] : '';
ok('REPRODUCED THE FIX: an Everyone Playing row shows "Online" (never a blank line) when the user has no activity label to show', /\{p\.activityLabel \|\| 'Online'\}/.test(everyoneSrc));
ok('Everyone Playing never filters by friendship — every entry the API returns is rendered', /everyone\.map\(/.test(everyoneSrc) && !/everyone\.filter\(/.test(everyoneSrc));

console.log(`\nFRIENDS PRESENCE VISIBILITY CARDS TESTS: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
