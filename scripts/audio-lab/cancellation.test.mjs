import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Exercise the actual page's handlers while a File read is still pending.
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replaceAll('import.meta.url', "'http://localhost/audio-lab/index.html'");
function page() {
  const elements = new Map();
  const workers = [];
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '', files: [], value: 'small', replaceChildren() {} });
    return elements.get(id);
  };
  runInNewContext(script, {
    document: { getElementById }, URL, performance, window: {},
    setInterval: () => 1, clearInterval() {},
    Worker: class {
      terminated = false;
      constructor() { workers.push(this); }
      terminate() { this.terminated = true; }
      postMessage() {}
    },
  });
  return { get: getElementById, workers };
}

test('Cancel during a file read cannot start a worker or replace a newer run', async () => {
  const ui = page();
  let finishRead;
  ui.get('file').files = [{ name: 'speech.wav', arrayBuffer: () => new Promise(resolve => { finishRead = resolve; }) }];
  const first = ui.get('run').onclick();
  ui.get('cancel').onclick();
  ui.get('file').files = [];
  await ui.get('run').onclick();
  assert.equal(ui.workers.length, 1);
  const current = ui.workers[0];
  finishRead(new ArrayBuffer(2));
  await first;
  assert.equal(ui.workers.length, 1);
  assert.equal(current.terminated, false);
  assert.equal(ui.get('cancel').disabled, false);
});

test('Late callbacks from a cancelled worker cannot stop the current run', async () => {
  const ui = page();
  await ui.get('run').onclick();
  const old = ui.workers[0];
  ui.get('cancel').onclick();
  await ui.get('run').onclick();
  const current = ui.workers[1];
  old.onmessage({ data: { progress: 'Stale result', error: 'Stale failure' } });
  old.onerror({ message: 'Stale worker failure' });
  assert.equal(ui.get('status').textContent, 'Starting worker…');
  assert.equal(current.terminated, false);
  assert.equal(ui.get('cancel').disabled, false);
});
