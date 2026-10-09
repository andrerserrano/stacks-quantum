// The wallet's record of what each one-time key has signed.
//
// A one-time key may sign one digest. Before the wallet releases a signature
// it claims the key for that digest here, and a key already claimed for
// another digest is refused. A claim is never removed. Signing the same digest
// again is harmless, because the signature comes out the same, so a request
// can always be sent again.
//
// The journal is part of the wallet's state. A wallet restored from its master
// secret without it has lost the guard for any request that has not confirmed.

import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Kept in memory, for a wallet that lives as long as one process.
export function memoryJournal() {
  const claims = new Map();
  return {
    claim(key, entry) {
      if (!claims.has(key)) claims.set(key, entry);
      return claims.get(key);
    },
    get: (key) => claims.get(key) ?? null,
  };
}

// One file per key under `dir`. An entry is written in full and synced before
// it is linked into place, and the link fails if the key is already claimed,
// so two processes cannot both claim a key and a crash leaves no half entry.
export function fileJournal(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = (key) => {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("a journal key is 32 bytes of hex");
    return join(dir, `${key}.json`);
  };
  const sync = (file, flags) => {
    const fd = openSync(file, flags);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };

  function get(key) {
    try {
      return JSON.parse(readFileSync(path(key), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  // Returns the entry that holds the key: `entry`, or the one already there.
  function claim(key, entry) {
    const final = path(key);
    const draft = join(dir, `.${key}.${randomBytes(6).toString("hex")}`);
    const fd = openSync(draft, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(entry, null, 1) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    let held = entry;
    try {
      linkSync(draft, final);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      held = get(key);
    } finally {
      unlinkSync(draft);
    }
    // Synced in both cases. The claim may be another process's, made a moment
    // ago and not yet on disk, and a signature is about to be released on it.
    sync(dir, "r");
    return held;
  }

  return { claim, get };
}
