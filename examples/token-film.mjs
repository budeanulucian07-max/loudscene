#!/usr/bin/env node
// A launch film for any token, straight from its contract address, with the loudscene REST API.
//
//   LOUDSCENE_API_KEY=ls_live_… node examples/token-film.mjs 0xCD291FA4d3e2Eb43e4639625092D31ae10E61111
//
// Creates the film (its live figures and its image go in), waits for the AI generation, renders a
// 16:9 MP4 and saves it next to you. No dependencies: Node 20+ has fetch.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const API = process.env.LOUDSCENE_API_URL ?? "https://www.loudscene.com";
const KEY = process.env.LOUDSCENE_API_KEY;
const token = process.argv[2];
if (!KEY || !token) {
  console.error("usage: LOUDSCENE_API_KEY=ls_live_… node examples/token-film.mjs <contract address or token link>");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { "content-type": "application/json", "idempotency-key": randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${json?.error?.message ?? res.status}`);
  return json;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let video = await api("POST", "/v1/videos", { token, format: "16:9" });
console.log(`film ${video.id} created, writing it…`);
while (video.status === "generating") {
  await wait(5000);
  video = await api("GET", `/v1/videos/${video.id}`);
  if (video.job) console.log(`  ${video.job.stage ?? video.job.status} ${Math.round((video.job.progress ?? 0) * 100)}%`);
}
if (video.status === "failed") throw new Error(video.job?.error ?? "the generation failed");

let [render] = (await api("POST", `/v1/videos/${video.id}/variants`, { formats: ["16:9"] })).renders;
console.log(`rendering ${render.id}…`);
while (render.status !== "succeeded") {
  if (render.status === "failed") throw new Error(render.error ?? "the render failed");
  await wait(5000);
  render = await api("GET", `/v1/renders/${render.id}`);
}
const mp4 = Buffer.from(await (await fetch(render.url)).arrayBuffer());
await writeFile(`launch-film-${video.id}.mp4`, mp4);
console.log(`saved launch-film-${video.id}.mp4 (${(mp4.length / 1e6).toFixed(1)} MB)`);
