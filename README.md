# livedit

Voice-to-change editing for websites. Someone browsing a site records or types
what they'd like changed, points at the thing they mean, reviews a plain-English
checklist, and a few minutes later sees the change on a preview. Every change
is made by `claude -p` in its own git worktree, committed with an audit trail,
and can be published and stepped back from like browser history.

It started as the editor for a single site and is now a standalone,
multi-project daemon. A browser extension that brings the same editor to any
locally developed site comes next.

## Packages

| Package | What |
|---|---|
| `packages/daemon` | The local server: notes, whisper transcription, the summarizer and implementer (`claude -p`), worktrees, previews, landing, per-project SQLite, live events |
| `packages/bar` | The edit bar: one self-contained shadow-DOM script a host injects into the page |

## Setup

```sh
npm install
npm run build:bar
```

Requirements: Node ≥ 22.13, git, the `claude` CLI (logged in), and for voice
notes a [whisper.cpp](https://github.com/ggml-org/whisper.cpp) server
(`whisper-server --convert`).

### Daemon config

`~/.config/live-edits/daemon.json` (or `$LIVE_EDITS_CONFIG`):

```json
{
  "host": "127.0.0.1",
  "port": 21784,
  "whisperUrl": "http://127.0.0.1:21782/inference",
  "defaultProject": "example-site",
  "projects": {
    "example-site": {
      "name": "Example Site",
      "repo": "/home/me/Development/example-site",
      "landing": "release",
      "previewSiteUrl": "http://127.0.0.1:21783",
      "owner": "Alex",
      "dev": "Sam"
    }
  }
}
```

Each project keeps its data in `<repo>/.live-edits/` (gitignore it) and its
secrets in its own `.env`, which the daemon reads per project (it is never
loaded into the daemon's environment):

| Variable | |
|---|---|
| `LIVE_EDITS_TOKEN` | Access code the bar must send for this project |
| `LIVE_EDITS_IMPLEMENTER_MODEL`, `LIVE_EDITS_SUMMARIZER_MODEL`, `LIVE_EDITS_IMPLEMENTER_BUDGET` | Per-project overrides of the daemon defaults |
| `LIVE_EDITS_NOTIFY_CMD` | Command run with one argument (a message) on publishes, switches and failures |
| `LIVE_EDITS_OWNER`, `LIVE_EDITS_DEV`, `LIVE_EDITS_PREVIEW_URL`, `LIVE_EDITS_SITE_BRANCH` | Override the registry entry |

### Landing modes

Only `release` exists so far: published versions are tags on a `site` branch,
built into `.live-edits/releases/<version>/`, and a `current` symlink (served
by the site's nginx) makes one live. `patch` and `commit` arrive with the
browser extension.

```sh
cd packages/daemon
node bin/init-site.mjs --project example-site        # first version (release landing)
node server.mjs                                   # the daemon
node bin/release-site.mjs --project example-site --bump minor --line "What changed"
node bin/rebuild-release.mjs --project example-site v1.3.0
```

## URLs

The daemon serves every project at `/p/<project>/…`, and the default project
at `/…` as well, so a site whose nginx proxies `/_live-edits/` to the daemon
keeps working unchanged:

| | |
|---|---|
| `/healthz` | Liveness and the project list (ids and names only) |
| `/p/<project>/bar.js` | The edit bar, scoped to that project (it takes its API base from its own URL) |
| `/p/<project>/api/state`, `/api/events`, `/api/notes`, `/api/requests/…`, `/api/live` | The bar's API (token required) |
| `/p/<project>/view?target=…` | Pick what a hosted preview shows (live / a version / a pending request) |

A host that injects the bar some other way sets
`window.__LIVE_EDITS_CONFIG__ = { base: '…/p/<project>/' }` before the script
loads, or calls `LiveEditsBar.configure()`.
