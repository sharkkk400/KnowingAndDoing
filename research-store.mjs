import {readFile, mkdir, writeFile, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Serialize reads and writes; a corrupt archive must never be replaced with an empty one.
export function createResearchStore(file, initial) {
  let state, queue = Promise.resolve();
  const copy = value => structuredClone(value);
  async function load() {
    if (state) return;
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
      if (state.version !== initial.version || !Array.isArray(state.records)) throw Error('存档格式不兼容');
    } catch (error) {
      if (error.code !== 'ENOENT') { state = undefined; throw Error('存档读取失败，已保留原文件：' + error.message); }
      state = copy(initial);
    }
  }
  function run(fn) {
    const job = queue.then(async () => { await load(); return fn(); });
    queue = job.catch(() => {});
    return job;
  }
  return {
    read: () => run(() => copy(state)),
    update: fn => run(async () => {
      const next = await fn(copy(state));
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        await mkdir(new URL('./', file), {recursive: true});
        const temp = new URL(file.href + '.' + randomUUID() + '.tmp');
        try { await writeFile(temp, JSON.stringify(next)); await rename(temp, file); }
        finally { await rm(temp, {force: true}).catch(() => {}); }
        state = next;
      }
      return copy(state);
    })
  };
}

export const chinaDate = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function safeLink(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
