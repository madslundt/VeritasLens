// Shared by the Node benchmark and the phone worker. No Web Audio dependency.
export function pcmToFloat(pcm) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Float32Array.from({ length: pcm.length / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
}

export function floatToPcm(audio) {
  const pcm = new Uint8Array(audio.length * 2);
  const view = new DataView(pcm.buffer);
  audio.forEach((value, i) => view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true));
  return pcm;
}

// Benchmark the same resampler that the app ships.
export { resample } from '../../packages/even-g2/src/runtime/noiseReductionEngine.ts';

export function rms(audio) {
  let energy = 0;
  for (const value of audio) energy += value * value;
  return Math.sqrt(energy / Math.max(1, audio.length));
}

export function siSdr(reference, audio) {
  let dot = 0, energy = 0;
  for (let i = 0; i < reference.length; i++) { dot += reference[i] * audio[i]; energy += reference[i] ** 2; }
  const gain = dot / Math.max(energy, 1e-20);
  let error = 0;
  for (let i = 0; i < reference.length; i++) error += (audio[i] - gain * reference[i]) ** 2;
  return 10 * Math.log10(Math.max(gain * gain * energy, 1e-20) / Math.max(error, 1e-20));
}

export function findDelay(reference, audio, maximum = 1600) {
  let best = -Infinity, delay = 0;
  // Fixed stride bounds calibration cost; do not fit a new delay per noisy case.
  for (let lag = 0; lag <= maximum; lag++) {
    let dot = 0, energy = 0;
    for (let i = 1600; i < reference.length - maximum; i += 8) {
      dot += reference[i] * audio[i + lag]; energy += audio[i + lag] ** 2;
    }
    const score = dot / Math.sqrt(Math.max(energy, 1e-20));
    if (score > best) { best = score; delay = lag; }
  }
  return delay;
}

export function noise(length, seed = 42) {
  let low = 0;
  return Float32Array.from({ length }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const white = seed / 4294967296 * 2 - 1;
    low = low * 0.97 + white * 0.03;
    return white * 0.35 + low * 3 + 0.12 * Math.sin(2 * Math.PI * 100 * i / 16000);
  });
}

export function mix(clean, background, snrDb) {
  const gain = rms(clean) / (rms(background) * 10 ** (snrDb / 20));
  return Float32Array.from(clean, (value, i) => value + background[i] * gain);
}

export function wav(audio) {
  const pcm = floatToPcm(audio);
  const bytes = new Uint8Array(44 + pcm.length);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((c, i) => bytes[offset + i] = c.charCodeAt(0));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, pcm.length, true); bytes.set(pcm, 44);
  return bytes;
}

export function decodeWav(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('Expected RIFF WAV');
  let format = false, pcm;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + length > bytes.length) throw new Error('Truncated WAV');
    if (text(offset, 4) === 'fmt ') {
      format = length >= 16 && view.getUint16(start, true) === 1 && view.getUint16(start + 2, true) === 1 &&
        view.getUint32(start + 4, true) === 16000 && view.getUint16(start + 14, true) === 16;
    }
    if (text(offset, 4) === 'data') pcm = bytes.subarray(start, start + length);
    offset = start + length + length % 2;
  }
  if (!format || !pcm?.length || pcm.length % 2) throw new Error('Use mono PCM16 WAV at 16 kHz');
  return pcmToFloat(pcm);
}
