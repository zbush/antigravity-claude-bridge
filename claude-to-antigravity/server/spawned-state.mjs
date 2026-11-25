import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function spawnedState(directory) {
  const file = path.join(directory, 'spawned.json');
  const lock = file + '.lock';

  function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('Cannot read Antigravity bridge conversation state: ' + error.message);
    }
  }

  function save(id, info) {
    const all = load();
    all[id] = { ...all[id], ...info };
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(all, null, 1), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  // Publish a directory containing a unique owner file in one rename. A reaper
  // can only unlink that exact owner's file, even if another process wins the lock.
  function removeEmpty(dir) {
    try { fs.rmdirSync(dir); }
    catch (error) {
      // On Windows another process may still have the directory open for
      // inspection. Once the owner file is gone, any waiter can finish cleanup.
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return;
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }

  function reapDeadOwner() {
    let owners;
    try { owners = fs.readdirSync(lock); }
    catch (error) {
      if (error.code === 'ENOENT' || (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) return;
      throw error;
    }
    for (const owner of owners) {
      const pid = Number(owner.split('.')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid spawned.json lock owner.');
      try { process.kill(pid, 0); return; }
      catch (error) {
        if (error.code === 'ESRCH') fs.rmSync(path.join(lock, owner), { force: true });
        else if (error.code === 'EPERM') return;
        else throw error;
      }
    }
    removeEmpty(lock);
  }

  async function withLock(fn, signal) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const owner = process.pid + '.' + randomUUID();
    const candidate = lock + '.' + owner;
    fs.mkdirSync(candidate, { mode: 0o700 });
    let acquired = false;
    const deadline = Date.now() + 300_000;
    try {
      fs.writeFileSync(path.join(candidate, owner), '', { flag: 'wx', mode: 0o600 });
      while (!acquired) {
        signal?.throwIfAborted();
        try { fs.renameSync(candidate, lock); acquired = true; }
        catch (error) {
          // Windows reports EPERM when the target exists. The holder may
          // already have released it before we inspect the owner file.
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
          if (Date.now() >= deadline) throw new Error('Timed out acquiring the spawned.json lock.', { cause: error });
          reapDeadOwner();
          await delay(35, undefined, { signal });
        }
      }
      return await fn(save);
    } finally {
      const dir = acquired ? lock : candidate;
      fs.rmSync(path.join(dir, owner), { force: true });
      removeEmpty(dir);
    }
  }

  return { load, withLock };
}
