# netfix

Diagnose and fix two proxy problems that bite tools (AI editors, CLIs, IDE plugins) on macOS:

1. **The tool cannot reach proxied networks** — it ignores the system proxy and has no `HTTPS_PROXY` support, so it needs TUN mode.
2. **Internal domains resolve to public IPs** — the proxy core hands out fake-IPs or public answers for `*.17usoft.com`-style internal zones, so the tool talks to the wrong server.

`netfix` is frontend-agnostic: it talks to any running [mihomo](https://github.com/MetaCubeX/mihomo) core over its REST API, and ships a Clash Verge Rev adapter that writes the persistent *merge enhancement* layer (which survives subscription updates).

Zero runtime dependencies — Node built-ins only.

## Install

```bash
git clone <this-repo> ~/github/netfix
mkdir -p ~/.local/bin
ln -sf ~/github/netfix/bin/netfix.js ~/.local/bin/netfix
chmod +x ~/github/netfix/bin/netfix.js
```

`~/.local/bin` must be on your `PATH`.

## Usage

```bash
netfix doctor          # diagnose only — never writes anything
netfix scan            # list candidate domains and how they resolve
netfix fix             # plan → preview diff → confirm → apply → verify → rollback on failure
netfix proxy           # run a local proxy that hands proxy access to tools
```

### Options

| Flag | Meaning |
| --- | --- |
| `--internal-dns <ip>` | Internal DNS server (default `10.249.150.130`) |
| `--repos <paths>` | Comma-separated repo roots to scan for hostnames |
| `--no-chrome` | Skip Chrome history (it needs Full Disk Access) |
| `--frontend <id>` | Force `clash-verge-rev` or `generic-mihomo` |
| `--config <path>` | Explicit config file (generic frontend) |
| `--yes`, `-y` | Skip the confirmation prompt (scripting) |

## How it decides what is internal

A hostname is **internal** when it resolves to an RFC1918 private address (`10./127./192.168./172.16-31.`). Dual-resolver probing is *not* used: on split-horizon networks both resolvers can answer identically, so the address class is the only reliable signal.

DNS queries are hand-rolled UDP packets (`node:dgram`) on purpose — `dns.Resolver.setServers()` is hijacked by the proxy core when TUN is on, so it cannot reach the internal resolver.

Addresses in `198.18.0.0/16` mean the domain still resolves to a *fake-IP*: it needs a `fake-ip-filter` entry.

## How it fixes things

1. Scan for candidate hostnames (shell history, Clash logs, repos, Chrome history).
2. Resolve each one against the internal DNS server and classify it.
3. Collapse internal hosts into suffix wildcards (`matrix.17usoft.com` + `git.17usoft.com` → `17usoft.com`), keeping distinct delegations such as `cdb.17usoft.com` separate when the parent domain is also in play.
4. Write a `nameserver-policy` + `fake-ip-filter` block:
   - **Clash Verge Rev** → the active profile's *merge enhancement* file, then restart the GUI (its runtime config lives in a root-owned directory that the mihomo API refuses to load from external paths).
   - **Generic mihomo** → the config file itself, then `PUT /configs?force=true` to hot-reload.
5. Verify: re-resolve every internal host and confirm it still lands on a private IP. On failure the backup is restored automatically.

Backups are written to `~/.netfix/backups/<timestamp>/` before anything is changed.

## `netfix proxy` — proxy access for tools that ignore the system proxy

Many tools (Electron apps, some CLI tools, IDE plugins) never read the macOS
system proxy, so the usual answer is "turn on TUN". TUN hijacks the whole
machine, which is heavy and tends to break internal networks.

`netfix proxy` is the lighter alternative: it is a small local forward proxy
that sits between the tool and the running mihomo core.

```bash
netfix proxy
#   http proxy  : http://127.0.0.1:8899
#   socks5 proxy: socks5://127.0.0.1:8898

export HTTPS_PROXY=http://127.0.0.1:8899
export HTTP_PROXY=http://127.0.0.1:8899
export ALL_PROXY=socks5://127.0.0.1:8898
export NO_PROXY=17usoft.com,17u.cn
```

Routing rules:

| Target | Action |
| --- | --- |
| Internal domain (matches the internal suffix list) | resolve through the internal DNS server, connect straight to the private address |
| Everything else | tunnelled to the upstream mihomo mixed port |

The internal suffix list comes from the client config that is already in use
(the `nameserver-policy` keys) plus a live scan, so `netfix proxy` inherits
whatever `netfix fix` has already configured — the proxy information is read
from the running core, never hard-coded.

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--port <n>` | HTTP proxy port (default `8899`) |
| `--socks-port <n>` | SOCKS5 port (default `8898`, `0` disables) |
| `--print-env` | Print the environment and exit, without listening |
| `--no-scan` | Use only the client config, skip the live scan |
| `--upstream <host:port>` | Override the upstream core listener |

To keep it running in the background:

```bash
nohup netfix proxy > ~/.netfix/proxy.log 2>&1 &
```

## Program proxy capability

`netfix doctor` also checks whether running binaries honour `HTTPS_PROXY`. Go's `net/http` reads the environment through `golang.org/x/net/http/httpproxy`, so the presence of that symbol in the binary is the signal. A program without it needs TUN mode (or a per-app SOCKS proxy) to reach proxied networks.

## Development

```bash
npm test        # node --test, no network access required
```

## Limitations

- macOS only (`scutil`, `osascript`, `strings`, `pkill`).
- Chrome history requires Full Disk Access; without it the scan degrades gracefully.
- `netfix` never edits your shell profile — proxy hints are printed for you to act on.
