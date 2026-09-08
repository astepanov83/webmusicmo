# Stations: follow-ups left after the 2026-09-09 release

Everything here was found during review, judged not worth blocking the release,
and deliberately left. Each entry says what it is, why it was left, and what it
costs if it is never done. Nothing here is a known-broken behaviour with today's
data; they are latent risks, resilience gaps and polish.

Shipped as `gitea.gitpal.ru/alex/webmusicmo:2.0.0`, deployed on the NAS,
39 tests passing.

## Worth doing next

**Resolving a station's playlists is sequential.** `lib/app.js`. Each playlist
is read and probed one after another, with an 8 second and a 6 second timeout.
A station whose host black-holes takes up to 56 seconds to fail, and the page
has no timeout of its own, so it looks stuck. Running the playlists together and
picking the primary by original order keeps the behaviour and cuts the worst
case to a quarter. Left out of the release because it changes concurrency in the
resolver and deserves its own tests rather than riding along with two critical
fixes. Cost: one slow station makes the picker feel broken.

**The stream cache stores values, not promises.** `lib/app.js`. Several first
hits on a cold station each do the whole resolve. Caching the promise fixes it
and also removes the wait above for everyone after the first. Same reason for
leaving it. Cost: wasted upstream requests on a busy cold start.

**The station file is validated all-or-nothing when read.** `lib/stations.js`.
One bad entry means no station list at all, rather than one skipped station. The
refresh path was fixed to skip bad entries; the read path was not. A running
server degrades safely because the store keeps the last good list, so this only
bites a cold start on a bad file. Cost: a hand-edit typo in one station takes
the whole list down until it is corrected.

**Two behaviour changes shipped without tests.** The refresh now skips a single
bad SomaFM channel instead of failing wholesale, and the validator now rejects
non-http urls. Both are about three lines of test each. Adding a fourth broken
channel to `test/fixture-channels.json` would lock the first exactly. Cost: a
later change could silently undo either.

**The startup-read test does not test the startup read.** `test/app.test.js`.
It asserts the injected logger fires, which it would do on the first request
too. Constructing the app against a missing file and asserting the message
mentions startup would test the actual behaviour.

## Small and user-visible

**Stepping stations walks the full list while the panel shows a filtered one.**
`public/app.js`. With a filter applied, the previous and next keys can move to a
station that is not among the visible rows. Scrolling the current row into view
was fixed; this was not.

**Clicking a station while another is still loading discards the click.**
`public/app.js`. The guard sees the target as already applied and returns early
without cancelling the switch in flight, so the earlier station lands and the
last click is silently dropped. Storage stays consistent, so this is a surprise
rather than a defect.

**No layout between the phone overlay and three columns.** `public/style.css`.
Between about 700 and 950 pixels wide the two fixed columns leave the recently
played panel a sliver. Raising the overlay breakpoint or dropping to two columns
around 950 would fix it. Left because the breakpoint is a taste decision.

**A duplicate history row is possible for a track with an artist and no title.**
`public/app.js` still builds the display string with a branch, so a seeded entry
can end up with a trailing separator that fails to match the next reading. The
same one-line join used in `lib/somafm.js` fixes it.

## Known and accepted

**A refresh interval with a leading zero is read as base eight.** So `010` means
8 hours. The entrypoint rejects everything worse and the README says to write it
without a leading zero. Every portable way to normalise it is uglier than the
sentence in the README.

**The health endpoint reports healthy when the station list is unreadable.** The
spec froze that endpoint's shape. A container health check would call the
service healthy while every other endpoint answers 503.

**The recent-tracks list is not re-sorted.** Newest-first trusts SomaFM's own
ordering. Because the current track is taken as the first entry, a reordering
upstream would show the wrong current track rather than merely a shuffled list.

**The uninstall script leaves the station list under the user's home.** That is
the operator's data and deleting it would be wrong, but it is not mentioned
anywhere.

## Deployment notes

The systemd host and Docker deliberately read different station files. Docker
refreshes the copy inside its own image. The systemd service and timer read
`~/.local/state/webmusicmo/stations.json`, so a plain `npm run refresh` only
rewrites the committed seed copy in the repository and does not update what the
running service reads. The README says so, and the command to refresh the real
one is there too.

The NAS builds from source rather than pulling the registry image. The registry
tag is still published and kept in step, but the deploy path is
`dockers/webmusicmo/update.sh`, which pulls from GitHub and rebuilds.

The image running before this release is retained on the NAS as
`webmusicmo:rollback-pre-2.0.0`, and the previous compose file as
`docker-compose.yml.bak-pre-2.0.0`.
