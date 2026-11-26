/**
 * Synthesized Web Audio sound effects (zero external assets required).
 * Safe no-op in headless/non-audio environments.
 */

let sharedSfxCtx: AudioContext | null = null;

function getSfxAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedSfxCtx || sharedSfxCtx.state === 'closed') {
    sharedSfxCtx = new Ctor();
  }
  if (sharedSfxCtx.state === 'suspended') {
    void sharedSfxCtx.resume().catch(() => undefined);
  }
  return sharedSfxCtx;
}

/**
 * Pleasant ascending completion chime played when a video export finishes.
 */
export function playExportCompleteSound(): void {
  try {
    const ctx = getSfxAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    // C5 -> E5 -> G5 -> C6 warm marimba/bell triad chime
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const start = now + idx * 0.085;
      const dur = idx === notes.length - 1 ? 0.55 : 0.24;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = idx === notes.length - 1 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(idx === notes.length - 1 ? 0.16 : 0.12, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    });
  } catch {
    // non-fatal in muted/headless browsers
  }
}

/**
 * Crisp clock tick during live countdown preview when silent audio isn't loaded yet.
 */
export function playCountdownTickSound(urgent = false): void {
  try {
    const ctx = getSfxAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(urgent ? 1046.5 : 880, now);
    osc.frequency.exponentialRampToValueAtTime(urgent ? 784 : 620, now + 0.045);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(urgent ? 0.15 : 0.11, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.065);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.075);
  } catch {
    // non-fatal
  }
}

/**
 * Soft reveal ding when countdown ends during silent live preview.
 */
export function playCountdownRevealChime(): void {
  try {
    const ctx = getSfxAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [1318.5, 1975.5].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(idx === 0 ? 0.11 : 0.055, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.26);
    });
  } catch {
    // non-fatal
  }
}
