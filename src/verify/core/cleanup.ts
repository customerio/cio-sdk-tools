import { promises as fs, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What has to be undone however a run ends. `finally` runs on the happy path and on a throw,
 * not on Ctrl-C, and an interrupted run left log streams attached to a phone and copies of an
 * app's data in the temp folder. Each task runs once, at exit or on an interrupt.
 */
const tasks = new Set<() => void>();
let installed = false;

/** Run `task` when the process ends. Returns a function that drops it once it is done. */
export function atExit(task: () => void): () => void {
  tasks.add(task);
  install();
  return () => {
    tasks.delete(task);
  };
}

function install(): void {
  if (installed) return;
  installed = true;
  process.once('exit', runAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      runAll();
      process.exit(130);
    });
  }
}

function runAll(): void {
  for (const task of tasks) {
    try {
      task();
    } catch {
      // One task failing must not keep the others from running.
    }
  }
  tasks.clear();
}

/** A temp folder that is removed with `remove()`, or at exit if nothing removed it. */
export async function scratchDirectory(): Promise<{
  path: string;
  remove(): Promise<void>;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cio-verify-'));
  const forget = atExit(() =>
    rmSync(directory, { recursive: true, force: true })
  );
  return {
    path: directory,
    remove: async () => {
      forget();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
