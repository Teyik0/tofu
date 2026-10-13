# Tofu and WebTorrent Desktop benchmark

Measured on October 4, 2026, on a MacBook Air M2 with 8 GB of RAM, using the four torrent files in Downloads: **2.55 GiB** in total. In this run, Tofu used **66.4% less median memory during the download window** than the installed WebTorrent Desktop version. This comparison covers both complete applications and their current versions on this machine.

## Applications compared

| Application | Interface and engine | Architecture | Processes measured |
| --- | --- | --- | --- |
| Tofu 0.1.0 | Electrobun 2.0.2, system WKWebView, Bun 1.4.2, WebTorrent 3.0.21 | Native arm64 | 5: launcher, Bun, WebContent, GPU, Networking |
| Installed WebTorrent Desktop 0.24.0 | Electron 10.1.0, Chromium 85, WebTorrent 0.108.6 | Intel x64 through Rosetta | 6: application, two renderers, GPU, network, crash reporter |

Versions were checked in local files and the running engine. WebTorrent Desktop is old and its engine differs from Tofu's: these results cannot attribute the entire difference to Electrobun or compare all recent Electron clients. Deluge and qBittorrent were not measured.

## Method

The applications ran sequentially with separate profiles and fresh download folders, without reusing the other application's files. Tofu's normal folder and the original WebTorrent installation were preserved. To isolate WebTorrent Desktop's profile, an APFS copy of its application was used; only the configuration path in that copy was adapted to an environment variable, then the copy was signed locally. Engines, binaries, and the application's production mode were preserved.

Both windows were given a requested size of 1400 × 940. The system may adjust the height to the available desktop. Bandwidth limits were the defaults, without throttling; Tofu uses TCP with uTP disabled, while WebTorrent Desktop retains its native network configuration. Connection limits and cache strategies may differ between versions.

Sampling began after opening the application: 15 seconds with an empty list, four simultaneous downloads over a target window of 180 seconds, then about 20 additional seconds of transfer and 15 seconds of global pause. Observed download windows were **184.3 s for Tofu** and **180.7 s for WebTorrent Desktop**, due to request and sampling time. The three minutes do not represent complete downloads of all four files.

Memory is the **total physical footprint** across all processes, reported by the macOS tool `footprint --noCategories --swapped -j`. It includes compressed pages and accounts for sharing between selected processes. The data contains 167 samples for Tofu and 185 for WebTorrent Desktop, with median intervals of 1 s and 1 s. Some samples take longer under load. The peak is the **highest total observed in a sample**, not a guaranteed maximum for every workload. Individual process peaks were not added together.

Speeds and progress were read through Tofu's API and the actual engine in WebTorrent Desktop's hidden window. WebTorrent memory measurement remained independent of engine responses, so stalls were measured too. CPU is the sum of process `ps %cpu` values, a smoothed indication; 100% represents one core, not the entire machine.

## Results

| Metric | Tofu | Installed WebTorrent Desktop |
| --- | ---: | ---: |
| Idle memory with an empty list, median | 188.6 MiB | 297.2 MiB |
| Download memory, median | 344.7 MiB | 1,026 MiB |
| Observed memory peak, all phases | 388.1 MiB | 1,144.2 MiB |
| Memory after global pause, median | 307.8 MiB | 1,033 MiB |
| CPU during downloads, median | 78.7% of one core | 43.7% of one core |
| Highest measured speed during the window | 42.6 MiB/s | 104.8 MiB/s |
| File data downloaded by the end of the window | 1.8 GiB | 1.2 GiB |
| Application size on disk, `du -sh` | 114 MiB | 206 MiB |

CPU and speed are not a controlled efficiency comparison: the sequential runs encountered different peers and did not receive exactly the same volume. Empty lists and version differences also limit memory interpretation. Memory after pausing may remain above initial idle usage because engines and runtimes retain some allocations.

## Progress after three minutes

| Torrent | Size in MiB | Tofu | WebTorrent Desktop |
| --- | ---: | ---: | ---: |
| I Became a Legend After My 10 Year-Long Last Stand S01E03 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) | 699.4 | 68.55% | 0% |
| I Became a Legend After My 10 Year-Long Last Stand S01E01 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) | 694.3 | 21.7% | 99.99% |
| Tougen.Anki.S02E01.VOSTFR.1080p.WEBRiP.x265-KAF_(NYAA) | 522.2 | 100% | 100% |
| I Became a Legend After My 10 Year-Long Last Stand S01E02 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) | 699.2 | 99.48% | 0% |

WebTorrent Desktop received no pieces for two torrents during this run despite connected peers. This limits workload and speed comparisons. Engine progress and piece bitfields were recorded. Transfers continuing for the next 20 seconds may finish one additional file; table values were recorded at the end of the main window. Offline piece checks and any SHA-256 hashes of complete files are in [integrity.json](.cache/desktop-bench/integrity.json).

## Download traffic after 100 percent

For the already completed torrent in the normal profile, all 454 pieces were verified while network bytes kept increasing. Two connections used Tofu's own peer ID, including one through its public address. WebTorrent 3.0.21's internal loop check compares the ID to `torrent.peerId`, while the ID exists on `torrent.client.peerId`.

The fix in [engine.ts](src/server/engine.ts) rejects a wire carrying the client's ID and removes its address from candidate peers. [self-peer.test.ts](tests/self-peer.test.ts) sends a real incoming TCP handshake with that ID: it fails before the fix and passes afterward. Ten integration tests, 52 assertions, TypeScript, lint, and the build pass; the ten checks in the real native window pass too.

Some traffic can still occur at 100%: WebTorrent speeds count protocol messages exchanged between peers, not just file content. The fix preserves seeding. Forcing displayed speed to zero at 100% would hide this traffic; stopping connections would prevent sharing. Rejecting the client's own ID is the recommended change for this anomaly.

After restarting Tofu with the normal profile, all 454/454 file pieces remain verified. Sampling still reports roughly 7 KiB/s of network traffic, but no additional downloaded content bytes and no content bytes received on observed wires. Connections to the client itself are gone. The loop was a real anomaly, but it does not explain all displayed traffic at 100%. Report: [speed-after.json](.cache/speed-after.json).

## Recommendation and limitations

Keeping the current Furin and WebTorrent architecture on Bun with the native WebView is consistent with these results. Rebuilding the engine or replacing the runtime is unnecessary to fix the loop. To isolate the runtime's effect, another benchmark protocol should use the same WebTorrent version, arm64 architecture, network options, and controlled local swarm in both applications.

This run measures a real, bounded Internet workload with four torrents, without statistical repetitions or exhaustive cold-start measurement. Peaks may be higher with more torrents, peers, files, traffic, or UI actions. These measurements do not prove a universal advantage over Deluge, qBittorrent, or a newer WebTorrent Desktop version.

Raw data: [Tofu](.cache/desktop-bench/tofu-result.json), [WebTorrent Desktop](.cache/desktop-bench/wt-result.json), [summary](.cache/desktop-bench/summary.json). The one-off script is [run.ts](.cache/desktop-bench/run.ts), executed with Bun; use fresh profiles to repeat a run.

Documentation: [WebTorrent API](https://webtorrent.io/docs), the code actually installed in `node_modules/webtorrent/lib/peer.js` and `/Applications/WebTorrent.app/Contents/Resources/app.asar`, and local `footprint` and `ps` help. [Electrobun and the system WebView](https://framework.blackboard.sh/electrobun/apis/bundling-cef/).

## shadcn interface and torrent selection — October 4, 2026

[native-latency.ts](scripts/native-latency.ts), executed with Bun in the real WKWebView, adds four random 8 MiB files served over local TCP. Total download speed is limited to 512 KiB/s to keep four transfers active during measurement. After initially viewing all four torrents, it measures sixteen selection changes. Times include DOM observation and waiting for frames; detail measurement waits one additional frame after the selection frame.

| Metric | Previous interface | shadcn interface |
| --- | ---: | ---: |
| Selection, median | 16 ms | 17 ms |
| Selection, p95 | 33 ms | 65 ms |
| Details, median | 33 ms | 34 ms |
| Details, p95 | 50 ms | 79 ms |

This small local sample does not demonstrate improved normal latency: medians are close, and high values vary more with the new interface. It does not reproduce an Internet swarm or large numbers of files/peers. It does not imply a universal speed or memory improvement.

An additional check artificially delays API responses by one second: four changes to previously viewed details take 33 ms in median, with a maximum of 49 ms. After responses are released, the final selection remains displayed. This validates that cached selection no longer depends on HTTP refresh duration.

The engine now computes summaries for all torrents and file, peer, and piece lists only for the viewed torrent. Periodic writes are batched every five seconds. The interface retains viewed details, cancels requests for previous selections, refreshes statistics in a React transition, and avoids blocking all actions during an individual operation.

Validation: 14 integration tests, 77 assertions, 14 checks in the native window, TypeScript, lint, and the macOS arm64 build. Data: [before](.cache/native-latency-before.json), [after](.cache/native-latency-after.json), [native flow](.cache/native-smoke.json).

## Native pages and Furin Sync — October 4, 2026

The library moves to Furin routes and a shared layout. Loaders serve initial data, details use `defer`/Suspense and `useQuery`, and Furin Sync replaces React polling. An initial measurement showed that placing `Await` before reading the cache sometimes imposed roughly 300 ms of waiting on previously viewed details. The cache is now read first; Suspense is used when data is missing.

The final run uses four **16 MiB** files instead of 8 MiB to keep all four transfers active. Total speed remains limited to 512 KiB/s. Sixteen changes are measured after viewing all four torrents in the real visible WKWebView. This is a small local trial, not a universal performance comparison.

| Metric | Native pages + Sync |
| --- | ---: |
| Selection, median / p95 | 17 / 33 ms |
| Cached details, median / p95 | 34 / 49 ms |
| Cached details with responses delayed by 1 s, median / maximum | 34 / 34 ms |

All four downloads were still active at the end; the final selection remained correct after delayed responses. A run with a hidden WebView timed out and was discarded. Final report: [native-latency-furin-sync.json](.cache/native-latency-furin-sync.json).

Validation: **15 integration tests, 83 assertions, 19 native checks**, TypeScript, lint, and the macOS arm64 build. The native flow checks populated initial HTML, an external change received automatically through Sync, sidebar preservation during navigation, and browser back navigation. Report: [native-smoke.json](.cache/native-smoke.json).
