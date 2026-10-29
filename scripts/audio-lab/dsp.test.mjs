import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, findDelay, floatToPcm, noise, pcmToFloat, resample, rms, siSdr, wav } from './dsp.mjs';

test('16→48→16 kHz preserves speech-band tones and exact duration', () => {
  const input = Float32Array.from({ length: 16000 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 1000 * i / 16000));
  const high = resample(input, 16000, 48000);
  const low = resample(high, 48000, 16000);
  assert.equal(high.length, input.length * 3); assert.equal(low.length, input.length);
  assert.ok(siSdr(input.subarray(100, -100), low.subarray(100, -100)) > 50);
});

test('48→16 kHz rejects frequencies that would alias into the speech band', () => {
  const high = Float32Array.from({ length: 48000 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 12000 * i / 48000));
  const low = resample(high, 48000, 16000);
  assert.ok(20 * Math.log10(rms(low.subarray(100, -100)) / rms(high)) < -50);
});

test('specialized 3:1 resampling preserves reference values at both clip edges', () => {
  // Captured from the original full sinc convolution. The five-sample clip
  // exercises every interpolation phase, both zero-padded edges, and a
  // partial final decimation frame without relying on the optimized loop.
  const input = new Float32Array([0.2, -0.5, 1, -0.75, 0.125]);
  const expectedUp = [
    0.0528747886, -0.3430190384, -0.5410029888, -0.3485073447, 0.1612484753,
    0.6749880314, 0.8469496965, 0.5423548222, -0.0623170026, -0.5982731581,
    -0.7564422488, -0.4895515442, -0.0225822907, 0.3245714605, 0.3624210358,
  ];
  const expectedDown = [0.0547175817, -0.0061321291];
  for (const [actual, expected] of [[resample(input, 16000, 48000), expectedUp], [resample(input, 48000, 16000), expectedDown]]) {
    assert.equal(actual.length, expected.length);
    actual.forEach((sample, i) => assert.ok(Math.abs(sample - expected[i]) < 1e-7));
  }
  assert.equal(resample(new Float32Array(), 16000, 48000).length, 0);
  assert.equal(resample(new Float32Array(1), 48000, 16000).length, 0);
});

test('fixed-delay calibration recovers a known 30 ms delay', () => {
  const input = noise(16000);
  const output = new Float32Array(input.length + 1600); output.set(input, 480);
  assert.equal(findDelay(input, output), 480);
});

test('WAV round-trip preserves PCM with clipping and unaligned views', () => {
  const input = new Float32Array([-2, -0.5, 0, 0.5, 2]);
  const pcm = floatToPcm(input);
  const unaligned = new Uint8Array(pcm.length + 1); unaligned.set(pcm, 1);
  const expected = [-1, -0.5, 0, 0.5, 32767 / 32768];
  assert.deepEqual([...pcmToFloat(unaligned.subarray(1))], expected);
  assert.deepEqual([...decodeWav(wav(input))], expected);
  assert.throws(() => decodeWav(wav(input).subarray(0, 45)), /Truncated/);
});

test('rejects invalid resampling rates', () => {
  assert.throws(() => resample(new Float32Array(1), 0, 48000), /Invalid/);
});
