# disk — evaluation notes

Hands-on review of [`disk@0.8.8`](https://www.npmjs.com/package/disk), Archil's pure-JS client and CLI. The first half reproduces the upstream README (with a couple of accuracy fixes); the second half is findings from testing against a live R2-backed disk in `aws-eu-west-1`.

---

## Overview (from upstream)

Node.js client and CLI for [Archil](https://archil.com) disks. Create disks, list and inspect them, manage who can mount them, and run commands against them — all from scripts, CI, or an interactive terminal. Talks to the Archil control plane over HTTPS with no native dependencies. For data-plane access from Node (raw reads/writes), pair with `@archildata/client` (see [Finding 1](#1-the-archildatanative-reference-is-broken)).

## Install

```bash
npm install disk
```

## CLI

```bash
export ARCHIL_API_KEY=key-...
export ARCHIL_REGION=aws-eu-west-1

npx disk list
npx disk get dsk-abc123
npx disk create my-disk          # response includes one-time mount token

# Run a command inside an Archil-managed container with the disk mounted.
# The disk is mounted at /mnt/<mount-name>, *not* /mnt — the upstream README is
# slightly misleading. For a mount named "archil" you get /mnt/archil.
npx disk dsk-abc123 exec "ls -la /mnt/archil"

npx disk delete dsk-abc123
npx disk api-keys list
```

Credentials come from `ARCHIL_API_KEY` / `ARCHIL_REGION`, or `--api-key` / `--region` / `--base-url`. `list` / `get` render tables by default; `-o json` prints the raw response.

## Library

```ts
import * as archil from "disk";

archil.configure({ apiKey: process.env.ARCHIL_API_KEY, region: "aws-eu-west-1" });

const { disk, token } = await archil.createDisk({ name: "my-disk" });
const d = await archil.getDisk(disk.id);

// Control plane
const { stdout, stderr, exitCode } = await d.exec("ls -la /mnt/archil");
await d.addUser({ type: "token", nickname: "ci" });
await d.delete();

// Data plane (requires the native client — see Finding 1)
const client = await d.mount({ authToken: "<disk-token>" });
```

For multi-tenant scripts instantiate `Archil` directly rather than using the process-global `configure()`:

```ts
import { Archil } from "disk";
const prod = new Archil({ apiKey: prodKey, region: "aws-eu-west-1" });
```

---

# Findings from hands-on testing

Test target: an R2-backed disk in `aws-eu-west-1`. All evidence below was reproduced live.

## 1. The `@archildata/native` reference is broken

`Disk.mount()` does `createRequire(...)("@archildata/native")` — but **no package is published under that name**. `npm install @archildata/native` returns 404. Calling `mount()` therefore always throws:

```
Error: Native client not available. Install @archildata/native (platform-specific binary) or use ArchilClient.connect() directly.
    at Disk.mount (.../disk/dist/index.js:204:13)
```

The native client that actually exists is **`@archildata/client`** (~66 MB unpacked, NAPI-RS Rust binaries for `darwin-arm64` / `linux-x64-gnu` / `linux-arm64-gnu`). Its exported `ArchilClient.connect({ region, diskName, authToken, logLevel, ... })` matches `Disk.mount()`'s call site exactly, so the code is functionally correct — just the package name is wrong.

**Workaround:** install `@archildata/client` under a package alias:

```json
{
  "dependencies": {
    "disk": "^0.8.8",
    "@archildata/native": "npm:@archildata/client@^0.8.8"
  }
}
```

With that alias in place, `d.mount()` returns a real `ArchilClient` and all 25 data-plane methods (`readInode`, `writeData`, `unlink`, `checkout`, `sync`, etc.) work. Verified by reading the PNG magic bytes off a file in the bucket (`89 50 4e 47 0d 0a 1a 0a…`) and by round-tripping a 37-byte write.

**Suggested fix for Archil:** change `nativeRequire("@archildata/native")` → `nativeRequire("@archildata/client")` in `src/disk.ts`. Also worth re-throwing the underlying `MODULE_NOT_FOUND` instead of swallowing it in a bare `catch {}` — it currently masks every possible load failure behind the same generic message.

## 2. `disk exec` requires `archil checkout` for deletes

Inside an `exec` container, `mkdir`, file creation, and overwrites Just Work. But `rm` and `rmdir` fail with a misleading `EROFS`:

```
rm: cannot remove '/mnt/archil/<file>': Read-only file system
```

**Workaround (per Archil):** the `archil` CLI is preinstalled at `/usr/local/bin/archil` inside every exec container. To unlock writes-within-a-folder (deletes, renames within), call `archil checkout <folder-path>` first — note the path is the **parent folder**, not the file. Archil told us they're working on removing this requirement, so this should get easier.

| operation | needs `archil checkout`? |
|---|---|
| `mkdir` | no |
| create file (`>`, `touch`) | no |
| overwrite file | no |
| `rm` a file | **yes** — checkout the parent dir |
| `rmdir` a directory | **yes** — checkout the parent dir |

Verified working pattern:

```bash
disk exec "$DISK_ID" "
  mkdir /mnt/archil/probe-dir
  echo a > /mnt/archil/probe-dir/file.txt
  archil checkout /mnt/archil/probe-dir   # unlocks deletes inside probe-dir
  rm /mnt/archil/probe-dir/file.txt
  archil checkout /mnt/archil             # unlocks deletes inside parent
  rmdir /mnt/archil/probe-dir
"
```

The repro script (`exec-rm-repro.sh`) demonstrates the failure first, then re-runs the same delete after `archil checkout` to show the workaround.

**Suggested asks for Archil:**
1. Continue removing the explicit-checkout requirement (you're already on it).
2. Until then, return a more specific error than `EROFS` — e.g. "Read-only file system (run `archil checkout <parent>` to enable writes here)". The current error sends users in the wrong direction.
3. Mention the `archil checkout` requirement in the `disk exec` CLI help.

## 3. Data-plane `unlink` requires extra ceremony

`ArchilClient.unlink(parentInodeId, name)` looks like a simple delete but fails with `[Error: ReadOnly]` unless you do two things the docs don't spell out:

1. **Pass a user context** matching the parent dir's ownership (usually root): `{ user: { uid: 0, gid: 0 } }`. Without it, the default uid has no write permission on `/`.
2. **Hold a write delegation on the parent directory.** `create` auto-negotiates this, but `unlink` does not — you have to `checkout(parentInodeId, { force: true, user })` first.

Working pattern:

```ts
const AS_ROOT = { user: { uid: 0, gid: 0 } };

await client.checkout(1, { force: true, user: AS_ROOT.user });
await client.unlink(1, "file.txt", AS_ROOT);
await client.checkin(1, AS_ROOT);
await client.sync();
```

The error message `ReadOnly` is misleading (the filesystem is fine; it's a missing delegation). Consider surfacing a clearer error, or making `unlink` auto-negotiate the delegation like `create` does.

## 4. Cross-plane changes don't invalidate the native client's cache

If `exec` creates or deletes a file, a previously-connected `ArchilClient` won't see the change:

- `lookupInode` returns cached `null` for a file `exec` just created.
- `readDirectory` returns the stale directory listing.

The only workaround I found was to `client.close()` and re-`mount()`. There is no explicit cache-invalidation primitive in the public `ArchilClient` API. That's fine as a correctness property (clients with delegations are authoritative for their subtree), but it's a surprise when you mix `exec` and the data-plane client in the same script.

## 5. API keys are region-scoped

An API key created in one region returns `401 Unauthorized` from every other region's control plane. There's no cross-region account endpoint — you need one key per region you operate in. Worth mentioning in the "Supported regions" table.

Also: **disk tokens (`adt_…`) are not valid against the control plane at all.** They're the per-disk mount credential, not an account credential. If you pass one to `disk list` you get a 401 that doesn't immediately tell you the credential type is wrong.

## 6. Minor polish issues

- Upstream README says the disk is mounted at `/mnt` inside `exec` containers, but the actual path is `/mnt/<mount-name>` (e.g. `/mnt/archil`).
- `Disk.mount()`'s `catch {}` swallows the real reason the native client failed to load (could be `MODULE_NOT_FOUND`, could be a musl/alpine rejection from `@archildata/client`'s platform check, could be a bundler issue). Re-throwing or wrapping `cause` would make this debuggable.
- `disk api-keys list` prints tab-separated rows instead of a formatted table, unlike `disk list` / `disk get`.

---

## What works well

To balance the findings list: the parts of `disk` I tested worked cleanly end-to-end.

- Clean layered design (`regions → client → Disk/Disks/Tokens → Archil → module-level sugar`), pure fetch over `openapi-fetch` with compile-time types from the OpenAPI spec next door in the monorepo.
- Only two runtime deps (`openapi-fetch`, `commander`). No native code in the default install.
- Control-plane envelope normalization (`{success, data, error}` → typed promise or `ArchilApiError`) happens at exactly one chokepoint.
- `Disk.toJSON()` strips the internal client so `-o json` output is clean.
- `disk <id> exec ...` CLI sugar (argv rewrite) is a nice ergonomic touch.
- Region and missing-credential errors are friendly and actionable (`Unknown region "bogus". Valid regions: ...`).

---

## Appendix: the in-container `archil` CLI

Every `disk exec` container ships with `/usr/local/bin/archil` — the same Rust client used for FUSE mounts on developer machines. Useful inside `exec` for delegations, status, metrics, and (interesting) **filesystem checkpoints**.

Version of the binary in the eu-west-1 exec container at the time of writing:

```
Archil Client: v0.8.8-24-g1afee532-1776468195, 808, proto=Version2
Build: 2026-04-17 23:23:15 UTC (1afee532)
User Agent: rfp/Ubuntu 22.04.5 LTS/system=Linux,version=6.14.0,machine=aarch64
```

### Subcommand reference

All subcommands accept `--log-level`, `-q/--quiet`, `-v/--verbose`, `-h/--help`. Most that operate on a mount take `<MOUNTPOINT>` (inside exec: `/mnt/<mount-name>`, e.g. `/mnt/archil`).

| command | args | what it does |
|---|---|---|
| `mount` | `<MOUNT_NAME> <MOUNTPOINT>` | FUSE-mount a disk. Lots of perf knobs: `--max-cache-mb`, `--target-cache-mb`, `--max-iodepth` (128), `--enable-xattrs`, `--shared` / `--read-only` (multi-client), `--writeback-cache`, `--dentry-ttl-secs`, `--transaction-processors` (32), `--nconnect`, `--window-size` (128), `--attachment-count` (100), `--region`, `--sts-region`, `--log-dir`, `--max-log-size-mb`, `--log-metrics`, `-f/--force`. |
| `unmount` | `<MOUNTPOINT>` | Unmount. `-f/--force` available. |
| `version` | – | Build, proto version, user agent, latest available release. |
| **`checkout`** | `<PATH>` | Acquire a write delegation on the inode (see Finding 2). `-f/--force` revokes any existing holder. |
| **`checkin`** | `<PATH>` | Sync pending writes and release the delegation. |
| `delegations` | `<MOUNTPOINT>` | List held delegations. `--json` for machine-readable. |
| `status` | `<MOUNTPOINT>` | Disk ID, internal name, mount state, mount time, log level. |
| `set-log-level` | `<MOUNTPOINT> <LEVEL>` | Change client log level at runtime. |
| `set-cache-expiry` | `<PATH> --readdir-expiry <SECS>` | Tune the readdir cache TTL on a path. |
| `metrics` | `<MOUNTPOINT>` | Perf counters. `--json`, `--reset`. |
| `utils get-iam-role` | – | Print the IAM role ARN for this instance (`--sts-region` to override). |
| `utils speed-test` | `<MOUNTPOINT>` | Latency probe against the FS server. `--count <N>` (default 5 pings per endpoint). |
| **`checkpoints create`** | `<MOUNTPOINT> <NAME>` | Snapshot the current filesystem state under a unique name (within the current branch). The presence of `branch` language hints at git-style versioning, though no `list`/`restore`/`branch` subcommands are exposed in this build. |

### Live state of our test disk inside an exec container

```
$ archil status /mnt/archil
Status for mount point: /mnt/archil
  Disk ID: dsk-000000000000c9d3
  Disk Name: standby
  State: Mounted
  Mount Time: 2026-04-18 19:07:28 UTC
  Log Level: trace

$ archil delegations /mnt/archil
Delegations:

$ archil metrics /mnt/archil
No metrics recorded.
```

A few small observations from this output:

- **The exec mount runs at `trace` log level by default** — so per-syscall logs are flowing to `journald` (or `--log-dir`) the whole time the container is up. Heavy for production; presumably a debugging default for the exec environment.
- **`status` reports a "Disk Name" of `standby`** even though the control-plane API name is `claude`. This appears to be an internal mount alias (likely the warm-pool / failover slot the FS handler is currently bound to), not the user-facing disk name. Worth knowing if you're reading status output and confused why the name doesn't match the dashboard.
- **`delegations` is empty until you `checkout` something.** Run `archil checkout /mnt/archil` and re-check — the parent dir lease will appear.
- **`metrics` only populates after I/O happens through the mount** (it was empty at fresh container start).

### Notable: `checkpoints create` (versioning)

This is the most interesting subcommand for downstream tooling:

```
archil checkpoints create /mnt/archil my-checkpoint-name
```

The CLI says the name must be unique "within the current branch" — implying Archil maintains git-like branches of filesystem state under the hood, even if `branch` / `list` / `restore` aren't exposed as subcommands in this build. If you're using Archil as a backing store for AI training runs, CI artifacts, or dataset versioning, this is the primitive to know about.

---

## Test artifacts in this repo

- `disk-test.mjs` — full Node-only test covering data-plane read/write/delete, exec, and the cross-plane interactions.
- `exec-rm-repro.sh` — minimal shareable bug repro for Finding 2.
- `package.json` — pins `disk@^0.8.8` and aliases `@archildata/native` → `@archildata/client` so `d.mount()` works.
- `.env.example` — copy to `.env` and fill in `DISK_ID` (plus optionally `ARCHIL_API_KEY` / `ARCHIL_REGION` / `ARCHIL_DISK_TOKEN`).

Run the Node test with:

```bash
cp .env.example .env    # edit to taste
node --env-file=.env disk-test.mjs
```

Or run the shell repro:

```bash
set -a; source .env; set +a
./exec-rm-repro.sh
```

## FAQ

### What's the difference between an API key and a disk token?

- **API key** (`key-...`) — account-level, region-scoped credential for the control plane. Create via `console.archil.com` or `disk api-keys create`. Goes in `ARCHIL_API_KEY` or `--api-key`.
- **Disk token** (`adt_...`) — per-disk credential that lets a client mount a specific disk. Generated automatically when you create a disk; the value is shown once. Not valid against the control plane — only for data-plane `mount()`.

## Support

Questions about Archil itself: **support@archil.com**.
