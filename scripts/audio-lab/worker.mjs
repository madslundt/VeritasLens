import { runSuite } from './rnnoise-suite.mjs';
import { decodeWav, wav } from './dsp.mjs';

self.onmessage = async ({ data }) => {
  try {
    const source = data.wav ?? await (await fetch('/reference.wav')).arrayBuffer();
    const result = await runSuite(decodeWav(source), (message) => self.postMessage({ progress: message }), { variant: data.variant ?? 'small' });
    const samples = Object.fromEntries(Object.entries(result.samples).map(([name, audio]) => [name, wav(audio)]));
    self.postMessage({ report: result.report, samples }, Object.values(samples).map((bytes) => bytes.buffer));
  } catch (error) { self.postMessage({ error: error.stack ?? String(error) }); }
};
