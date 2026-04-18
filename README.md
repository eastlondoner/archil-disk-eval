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

Test target: `dsk-000000000000c9d3` (`user_32nK.../claude`) in `aws-eu-west-1`, backed by an R2 bucket. All evidence below was reproduced live.

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

## 2. `disk exec` runs in an append/overwrite-only mount (no `rm`)

The biggest functional finding. The mount `exec` provides supports creating and overwriting files, but **unlink and rmdir always fail** with `EROFS`:

```
rm: cannot remove '/mnt/archil/<file>': Read-only file system
```

This is not transient, not credential-related, and not affected by whether a data-plane client is connected. Repro script (`exec-rm-repro.sh`):

```bash
#!/usr/bin/env bash
set -u
: "${ARCHIL_API_KEY:?}" "${ARCHIL_REGION:?}" "${DISK_ID:?}"

FILE="repro-$(date +%s).txt"
run() { echo; echo "\$ $*"; npx --yes disk@0.8.8 exec "$DISK_ID" "$@"; echo "-> exit=$?"; }

run "echo hello > /mnt/archil/$FILE"        # create    — works
run "cat /mnt/archil/$FILE"                 # read      — works
run "echo overwritten > /mnt/archil/$FILE"  # overwrite — works
run "rm -v /mnt/archil/$FILE"               # delete    — FAILS EROFS
run "ls -la /mnt/archil/$FILE"              # still present
```

Output (abridged):

```
$ echo hello > /mnt/archil/repro-....txt       -> exit=0
$ echo overwritten > /mnt/archil/repro-....txt -> exit=0
$ rm -v /mnt/archil/repro-....txt
rm: cannot remove '/mnt/archil/repro-....txt': Read-only file system
-> exit=1
$ ls -la /mnt/archil/repro-....txt              -> exit=0   (still there)
```

The same file is trivially removable via the data plane (`ArchilClient.unlink`), so the capability clearly exists — it just isn't exposed through the exec mount.

**Suggested asks for Archil:**
1. Either support `unlink`/`rmdir` in the exec mount, or
2. Return a more specific error than `EROFS` ("operation not supported on exec mount" would be accurate), and
3. Document the append/overwrite-only property in both the CLI help and the README. For CI/scripting users expecting a full POSIX FS, this is a footgun.

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

## Test artifacts in this repo

- `disk-test.mjs` — full Node-only test covering data-plane read/write/delete, exec, and the cross-plane interactions.
- `exec-rm-repro.sh` — minimal shareable bug repro for Finding 2.
- `package.json` — pins `disk@^0.8.8` and aliases `@archildata/native` → `@archildata/client` so `d.mount()` works.

## FAQ

### What's the difference between an API key and a disk token?

- **API key** (`key-...`) — account-level, region-scoped credential for the control plane. Create via `console.archil.com` or `disk api-keys create`. Goes in `ARCHIL_API_KEY` or `--api-key`.
- **Disk token** (`adt_...`) — per-disk credential that lets a client mount a specific disk. Generated automatically when you create a disk; the value is shown once. Not valid against the control plane — only for data-plane `mount()`.

## Support

Questions about Archil itself: **support@archil.com**.
