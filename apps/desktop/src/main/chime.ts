// the sound of a notification: two soft notes going up a fifth, under half a second. made here,
// like the tray's mark, so there is no audio file to package and none of anyone else's to ship.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * what a notification names. macOS plays a sound by name from ~/Library/Sounds. the app's own
 * bundle is where it is documented to look first, and from the ad-hoc signed app it did not find
 * one there: it played its default instead
 */
export const CHIME = "Grove.wav";

const RATE = 44_100;
const SECONDS = 0.45;
/** about as loud as the system's own alert sounds, which peak between -14 and -5 dB */
const PEAK = 0.3;
/** [hz, starts at, how fast it dies away]: G5, then D6 ringing a little longer */
const NOTES = [
  [783.99, 0, 0.07],
  [1174.66, 0.085, 0.11],
] as const;
/** a mallet on wood: the note, a little of its octave, a trace two octaves up that dies first */
const PARTIALS = [
  [1, 1, 1],
  [2, 0.18, 0.6],
  [4, 0.06, 0.35],
] as const;
/** long enough that a note does not start with a click */
const ATTACK = 0.004;

/** 16-bit mono PCM in a wav */
export function chimeWav(): Buffer {
  const samples = new Float64Array(Math.round(RATE * SECONDS));
  for (const [hz, at, decay] of NOTES) {
    for (let i = Math.round(at * RATE); i < samples.length; i++) {
      const t = i / RATE - at;
      for (const [times, gain, life] of PARTIALS) {
        samples[i] =
          (samples[i] ?? 0) +
          gain *
            Math.min(1, t / ATTACK) *
            Math.exp(-t / (decay * life)) *
            Math.sin(2 * Math.PI * hz * times * t);
      }
    }
  }
  // the last 20ms go to nothing, so the end is not a click either
  const fade = Math.round(0.02 * RATE);
  for (let i = 0; i < fade; i++) {
    const at = samples.length - 1 - i;
    samples[at] = ((samples[at] ?? 0) * i) / fade;
  }
  const loudest = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);

  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    data.writeInt16LE(Math.round((s / loudest) * PEAK * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  // a 16 byte format chunk: PCM, one channel, the rate, bytes a second, bytes a sample, bits
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * puts the chime where macOS looks for it. the file is grove's: one that differs is written over,
 * which is how a new version changes the sound. a name macOS cannot find plays its default sound,
 * so a failure here costs nothing
 */
export async function installChime(home: string): Promise<void> {
  const file = path.join(home, "Library", "Sounds", CHIME);
  const wav = chimeWav();
  const had = await readFile(file).catch(() => null);
  if (had?.equals(wav)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, wav);
}
