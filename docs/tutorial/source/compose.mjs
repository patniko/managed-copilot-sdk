// Builds the tutorial from the recordings, slides, captions, and narration: one encoded segment per shot (a slide, or
// recorded footage time-fitted to its narration, with captions and scene fades), a narration track assembled
// sample-exactly from the per-page speech, then out/build/managed-copilot-tour.mp4 (loudness-normalized) and .srt.
// Usage: node compose.mjs [shot-id]   (a shot id encodes just that shot, for previews)
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG, OUT } from "./common.mjs";
import { pagesOf, scenes } from "./shots.mjs";

const run = promisify(execFile);
const FPS = 30;
const SR = 24000;
const LEAD = 0.35; // silence before the first page of a shot
const GAP = 0.3; // between pages
const TAIL = 0.5; // after the last page
const FADE = 0.4;
const FOOTAGE = { x: 192, y: 24, w: 1536, h: 864 };
const BUILD = join(OUT, "build");
mkdirSync(join(BUILD, "shots"), { recursive: true });
const only = process.argv[2];

function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${path}: not a WAV file`);
  let offset = 12;
  let fmt;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!fmt || fmt.channels !== 1 || fmt.rate !== SR || fmt.bits !== 16) throw new Error(`${path}: expected 24 kHz 16-bit mono`);
      const pcm = buf.subarray(body, body + size);
      return { pcm, seconds: pcm.length / 2 / SR };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

const clips = new Map();
function clip(name) {
  if (!clips.has(name)) clips.set(name, JSON.parse(readFileSync(join(OUT, "clips", name, "clip.json"), "utf8")));
  return clips.get(name);
}
function at(c, spec, offset = 0) {
  let t;
  if (typeof spec === "number") t = spec;
  else if (spec === "end") t = c.duration;
  else if (spec.startsWith("mark:")) {
    const label = spec.slice(5);
    const mark = c.marks.find((m) => m.label.startsWith(label));
    if (!mark) throw new Error(`${c.name}: no mark "${label}"`);
    t = mark.t;
  } else throw new Error(`bad time ${spec}`);
  return Math.min(c.duration, Math.max(0, t + offset));
}

/** An ffconcat list (paths relative to build/shots) showing frames t0..t1 at `speed`, then holding the last one. */
function frameList(c, t0, t1, speed, total) {
  const frames = c.frames;
  let i = 0;
  while (i + 1 < frames.length && frames[i + 1].t <= t0) i++;
  const items = [];
  for (; i < frames.length && frames[i].t < t1; i++) {
    const start = Math.max(frames[i].t, t0);
    const end = Math.min(i + 1 < frames.length ? frames[i + 1].t : c.duration, t1);
    if (end > start) items.push({ file: `../../clips/${c.name}/${frames[i].file}`, dur: (end - start) / speed });
  }
  if (!items.length) items.push({ file: `../../clips/${c.name}/${frames[Math.max(0, i - 1)].file}`, dur: total });
  const sum = items.reduce((s, it) => s + it.dur, 0);
  if (sum < total) items.at(-1).dur += total - sum;
  const lines = ["ffconcat version 1.0"];
  for (const it of items) lines.push(`file '${it.file}'`, `duration ${it.dur.toFixed(4)}`);
  lines.push(`file '${items.at(-1).file}'`);
  return lines.join("\n");
}

// Lay out the timeline; shots whose footage wasn't recorded are left out.
const shots = [];
let cursor = 0;
for (const scene of scenes) {
  const present = scene.shots.filter((shot) => {
    if (!shot.clip || existsSync(join(OUT, "clips", shot.clip, "clip.json"))) return true;
    console.warn(`  skipping ${shot.id}: no recording of ${shot.clip}`);
    return false;
  });
  present.forEach((shot, index) => {
    const pages = pagesOf(shot).map((p, j) => ({ ...p, ...readWav(join(OUT, "audio", `${shot.id}-${j}.wav`)), png: join(OUT, "captions", `${shot.id}-${j}.png`) }));
    let t = LEAD;
    for (const page of pages) {
      page.start = t;
      t += page.seconds + GAP;
    }
    const frames = Math.ceil((t - GAP + TAIL) * FPS);
    const duration = frames / FPS;
    pages.forEach((page, j) => {
      page.showFrom = Math.max(0, page.start - 0.12);
      page.showTo = j + 1 < pages.length ? pages[j + 1].start - 0.12 : duration - 0.2;
    });
    shots.push({ ...shot, scene: scene.id, first: index === 0, last: index === present.length - 1, pages, frames, duration, at: cursor });
    cursor += duration;
  });
}
console.log(`${shots.length} shots, ${Math.floor(cursor / 60)}:${String(Math.round(cursor % 60)).padStart(2, "0")}`);

async function encode(shot) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  const filters = [];
  let base;
  if (shot.slide) {
    args.push("-loop", "1", "-framerate", String(FPS), "-t", shot.duration.toFixed(3), "-i", join(OUT, "slides", `${shot.slide}.png`));
    filters.push("[0:v]setsar=1[b0]");
    base = 1;
  } else {
    const c = clip(shot.clip);
    const t0 = at(c, shot.from, shot.fromOffset);
    const t1 = at(c, shot.to, shot.toOffset);
    shot.speed = Math.max(1, (t1 - t0) / (shot.duration - 0.3));
    const list = join(BUILD, "shots", `${shot.id}.ffconcat`);
    writeFileSync(list, frameList(c, t0, t1, shot.speed, shot.duration + 1));
    args.push("-loop", "1", "-framerate", String(FPS), "-t", shot.duration.toFixed(3), "-i", join(OUT, "slides", "frame.png"));
    // ffmpeg resolves the list's relative paths against its folder only when the path uses forward slashes.
    args.push("-f", "concat", "-safe", "0", "-i", list.replaceAll("\\", "/"));
    filters.push(`[1:v]scale=${FOOTAGE.w}:${FOOTAGE.h}:flags=lanczos,setsar=1,fps=${FPS}[f]`, `[0:v][f]overlay=${FOOTAGE.x}:${FOOTAGE.y}:eof_action=repeat[b0]`);
    base = 2;
  }
  shot.pages.forEach((page, j) => {
    args.push("-loop", "1", "-framerate", String(FPS), "-t", shot.duration.toFixed(3), "-i", page.png);
    filters.push(`[b${j}][${base + j}:v]overlay=0:0:enable='between(t,${page.showFrom.toFixed(3)},${page.showTo.toFixed(3)})'[b${j + 1}]`);
  });
  const fades = [];
  if (shot.first) fades.push(`fade=t=in:st=0:d=${FADE}`);
  if (shot.last) fades.push(`fade=t=out:st=${(shot.duration - FADE).toFixed(3)}:d=${FADE}`);
  filters.push(`[b${shot.pages.length}]${[...fades, "format=yuv420p"].join(",")}[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", String(shot.frames), "-r", String(FPS));
  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "19", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-an", join(BUILD, "shots", `${shot.id}.mp4`));
  await run(FFMPEG, args, { maxBuffer: 1 << 26 });
  console.log(`  ✓ ${shot.id} ${shot.duration.toFixed(1)}s${shot.speed ? ` (${shot.speed.toFixed(1)}x)` : ""}`);
}

const queue = shots.filter((s) => !only || s.id === only);
const started = Date.now();
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length) await encode(queue.shift());
  }),
);
console.log(`encoded in ${((Date.now() - started) / 1000).toFixed(0)} s`);
if (only) process.exit(0);

// Narration: each shot's pages at their offsets, padded to the shot's exact length.
const totalSamples = shots.reduce((n, s) => n + (s.frames * SR) / FPS, 0);
const pcm = Buffer.alloc(totalSamples * 2);
for (const shot of shots) {
  const shotStart = Math.round(shot.at * SR);
  for (const page of shot.pages) page.pcm.copy(pcm, (shotStart + Math.round(page.start * SR)) * 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(join(BUILD, "narration.wav"), Buffer.concat([header, pcm]));

const stamp = (s) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
let n = 0;
const srt = shots.flatMap((shot) => shot.pages.map((p) => `${++n}\n${stamp(shot.at + p.start)} --> ${stamp(shot.at + p.start + p.seconds)}\n${p.caption}\n`));
writeFileSync(join(BUILD, "managed-copilot-tour.srt"), srt.join("\n"));

writeFileSync(join(BUILD, "shots.txt"), shots.map((s) => `file 'shots/${s.id}.mp4'`).join("\n"));
await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(BUILD, "shots.txt").replaceAll("\\", "/"), "-c", "copy", join(BUILD, "video.mp4")]);
await run(FFMPEG, [
  "-y", "-hide_banner", "-loglevel", "error", "-i", join(BUILD, "video.mp4"), "-i", join(BUILD, "narration.wav"),
  "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
  "-movflags", "+faststart", "-metadata", "title=Managed Copilot: a tour of what we built", join(BUILD, "managed-copilot-tour.mp4"),
]);
writeFileSync(join(BUILD, "timeline.json"), JSON.stringify(shots.map(({ id, scene, at: start, duration, speed }) => ({ id, scene, start: +start.toFixed(2), duration: +duration.toFixed(2), speed: speed && +speed.toFixed(2) })), null, 1));
console.log(`done: ${join(BUILD, "managed-copilot-tour.mp4")}`);
