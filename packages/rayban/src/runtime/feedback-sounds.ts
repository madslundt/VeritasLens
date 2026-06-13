import { Audio } from 'expo-av';

let triggerSound: Audio.Sound | null = null;
let cancelSound: Audio.Sound | null = null;

export async function preloadFeedbackSounds(): Promise<void> {
  try {
    const trigger = new Audio.Sound();
    await trigger.loadAsync(require('../../assets/sounds/trigger.m4a'));
    triggerSound = trigger;
  } catch {
    // Placeholder asset — silently no-op until real audio is shipped.
  }
  try {
    const cancel = new Audio.Sound();
    await cancel.loadAsync(require('../../assets/sounds/cancel.m4a'));
    cancelSound = cancel;
  } catch {
    // ditto
  }
}

export async function playTrigger(): Promise<void> {
  if (!triggerSound) return;
  try { await triggerSound.replayAsync(); } catch { /* swallow */ }
}

export async function playCancel(): Promise<void> {
  if (!cancelSound) return;
  try { await cancelSound.replayAsync(); } catch { /* swallow */ }
}
