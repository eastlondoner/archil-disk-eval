import * as archil from "disk";

archil.configure({
  apiKey: process.env.ARCHIL_API_KEY,
  region: "aws-eu-west-1",
});

const DISK_ID = "dsk-000000000000c9d3";
const TOKEN = process.env.ARCHIL_DISK_TOKEN;
const ROOT_INODE = 1;
const AS_ROOT = { user: { uid: 0, gid: 0 } };

function log(section, ...rest) {
  console.log(`\n=== ${section} ===`);
  for (const r of rest) console.log(r);
}

async function cleanup(client, names) {
  try { await client.checkout(ROOT_INODE, { force: true, user: AS_ROOT.user }); } catch (e) { console.log("  cleanup checkout(root) failed:", e.message); }
  for (const name of names) {
    try {
      await client.unlink(ROOT_INODE, name, AS_ROOT);
    } catch (e) {
      console.log(`  cleanup unlink(${name}) failed: ${e.message} [${e.code}]`);
    }
  }
  try { await client.checkin(ROOT_INODE, AS_ROOT); } catch {}
}

const d = await archil.getDisk(DISK_ID);
log("control plane: getDisk", `${d.organization}/${d.name}  status=${d.status}  bytes=${d.dataSize}`);

// Wipe leftover test files via exec so we start from a clean slate.
await d.exec("rm -f /mnt/archil/native-write.txt /mnt/archil/native-created-for-exec.txt /mnt/archil/exec-created.txt");

const client = await d.mount({ authToken: TOKEN });
log("data plane: connected", "methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter(n => n !== "constructor").length);

// Clean slate
await cleanup(client, ["native-write.txt", "native-created-for-exec.txt", "exec-created.txt"]);

// --------- 1. write via data plane, read back via data plane ---------
{
  const name = "native-write.txt";
  const payload = Buffer.from("line 1\nline 2 with emoji 🧪\nline 3\n");
  const { inodeId } = await client.create(ROOT_INODE, name, {
    inodeType: "File", uid: 0, gid: 0, mode: 0o644,
  }, AS_ROOT);
  await client.checkout(inodeId);
  await client.writeData(inodeId, 0, payload);
  await client.checkin(inodeId);
  await client.sync();

  const attrs = await client.getAttributes(inodeId);
  const readBack = await client.readInode(inodeId, 0, attrs.size);
  log("1. native write → native read",
    `  wrote ${payload.length} bytes, size on server=${attrs.size}`,
    `  match: ${Buffer.compare(payload, readBack) === 0}`,
    `  content: ${JSON.stringify(readBack.toString())}`);
}

// --------- 2. write via data plane, read via `exec` (server-side mount) ---------
{
  const name = "native-created-for-exec.txt";
  const { inodeId } = await client.create(ROOT_INODE, name, {
    inodeType: "File", uid: 0, gid: 0, mode: 0o644,
  }, AS_ROOT);
  await client.checkout(inodeId);
  await client.writeData(inodeId, 0, Buffer.from("written via native, read via exec\n"));
  await client.checkin(inodeId);
  await client.sync();

  const { stdout, stderr, exitCode } = await d.exec(`cat /mnt/archil/${name}`);
  log("2. native write → exec read",
    `  exit=${exitCode}`,
    `  stdout: ${JSON.stringify(stdout)}`,
    stderr ? `  stderr: ${stderr}` : "  stderr: (empty)");
}

// --------- 3. write via `exec`, read back via data plane ---------
// The native client aggressively caches inode metadata and doesn't see
// server-side changes made by `exec` (a separate mount-plane container).
// We reconnect to get a fresh view.
let client2;
{
  const name = "exec-created.txt";
  const r = await d.exec(`printf 'hello from exec at %s\\n' "$(date -u +%FT%TZ)" > /mnt/archil/${name} && ls -la /mnt/archil/${name}`);
  log("3a. exec write", `  exit=${r.exitCode}`, `  stdout: ${JSON.stringify(r.stdout)}`);

  await client.sync();
  await client.close();
  client2 = await d.mount({ authToken: TOKEN });

  const lk = await client2.lookupInode(ROOT_INODE, name, AS_ROOT);
  const buf = await client2.readInode(lk.inodeId, 0, lk.attributes.size, AS_ROOT);
  log("3b. native read of exec-written file (after reconnect)",
    `  inodeId=${lk.inodeId}  size=${lk.attributes.size}`,
    `  content: ${JSON.stringify(buf.toString())}`);
}

// --------- 4. delete via data plane, verify with exec ---------
{
  const name = "native-write.txt";
  await client2.checkout(ROOT_INODE, { force: true, user: AS_ROOT.user });
  await client2.unlink(ROOT_INODE, name, AS_ROOT);
  await client2.checkin(ROOT_INODE, AS_ROOT);
  await client2.sync();
  const r = await d.exec(`test -e /mnt/archil/${name}; echo exists=$?`);
  log("4. native unlink → exec verify",
    `  exit=${r.exitCode}`,
    `  stdout: ${r.stdout.trim()}  (exists=1 means not found ✅)`);
}

// --------- 5. delete via exec, verify with data plane ---------
// First try with the native client still connected — expect Read-only
// (the mount-plane goes RO while a data-plane client holds delegations).
{
  const name = "native-created-for-exec.txt";
  const attempt1 = await d.exec(`rm -v /mnt/archil/${name}`);
  log("5a. exec rm with native client connected",
    `  exit=${attempt1.exitCode}`,
    `  stderr: ${attempt1.stderr.trim()}`);

  // Close the native client, retry.
  await client2.close();
  const attempt2 = await d.exec(`rm -v /mnt/archil/${name}`);
  log("5b. exec rm after native client closed",
    `  exit=${attempt2.exitCode}`,
    `  stdout: ${attempt2.stdout.trim()}`,
    `  stderr: ${attempt2.stderr || "(empty)"}`);

  // Verify via a fresh native client
  const client3 = await d.mount({ authToken: TOKEN });
  const lk = await client3.lookupInode(ROOT_INODE, name, AS_ROOT);
  log("5c. fresh native lookup", `  result: ${lk === null ? "null (gone ✅)" : JSON.stringify(lk)}`);
  client2 = client3;
}

// --------- 6. exec: multi-command pipeline that does real work ---------
{
  const r = await d.exec(`
    cd /mnt/archil &&
    ls -la &&
    echo "---" &&
    du -sh . &&
    echo "---" &&
    find . -type f -not -path './.archil/*' | head -5
  `);
  log("6. exec pipeline", `  exit=${r.exitCode}`, r.stdout);
}

// --------- 7. cleanup and close ---------
await cleanup(client2, ["exec-created.txt"]);
const released = await client2.close();
log("done", `released ${released} delegations on close`);
