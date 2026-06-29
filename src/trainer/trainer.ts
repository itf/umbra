/**
 * Echolocation Trainer controller.
 *
 * Eyes-free / screen-reader-first drill page. A pure generator (`exercises.ts`)
 * produces a Question — either an A/B room-discrimination or a single-room
 * direction task. We reuse the debug `ScenePlayer` for playback: it already
 * fires a clap through the room IR (size/material cues) and renders a positioned
 * HRTF tone (direction cue). A/B scenes share one player; we `load` whichever
 * room the listener asks to hear, so they can replay A and B freely.
 *
 * Audio is gated behind a Begin button (browsers require a user gesture).
 * Everything is announced via an aria-live region so it plays with eyes closed.
 */
import { initAcoustics } from '../engine/acoustics/core';
import { startAudio } from '../engine/audioGraph';
import { HrtfRenderer } from '../engine/hrtf/renderer';
import { ScenePlayer } from '../debug/scenePlayer';
import {
  makeRandomQuestion,
  type Question,
  type ExerciseType,
} from './exercises';

const HRTF_URL = '/assets/hrtf/sadie_h3.hrtf';
const $ = (id: string) => document.getElementById(id)!;

let player: ScenePlayer | null = null;
let current: Question | null = null;
let answered = false;
let score = 0;
let asked = 0;
let streak = 0;
let seedCounter = (Math.random() * 1e9) | 0;
/** Which room is currently loaded into the shared player, for A/B replay. */
let loadedRoom: 'A' | 'B' | null = null;

function announce(msg: string) {
  ($('live') as HTMLElement).textContent = msg;
}

/** Difficulty grows with the streak (contrast shrinks): easy -> subtle. */
function difficulty(): number {
  return Math.min(1, streak * 0.12);
}

async function ensurePlayer(): Promise<ScenePlayer> {
  if (player) return player;
  await initAcoustics();
  const graph = await startAudio();
  const renderer = await HrtfRenderer.create(graph.ctx, HRTF_URL);
  player = new ScenePlayer(graph, renderer);
  return player;
}

function typeFilter(): ExerciseType[] | undefined {
  const sel = $('type') as HTMLSelectElement;
  return sel.value === 'all' ? undefined : ([sel.value] as ExerciseType[]);
}

function nextQuestion() {
  asked++;
  answered = false;
  loadedRoom = null;
  current = makeRandomQuestion(seedCounter++, { difficulty: difficulty(), types: typeFilter() });
  renderQuestion(current);
}

function renderQuestion(q: Question) {
  ($('prompt') as HTMLElement).textContent = q.prompt;
  const isAB = q.type !== 'direction';

  // Play controls.
  ($('play-ab') as HTMLElement).hidden = !isAB;
  ($('play-single') as HTMLElement).hidden = isAB;

  // Answer buttons.
  const answers = $('answers');
  answers.innerHTML = '';
  for (const choice of q.choices) {
    const btn = document.createElement('button');
    btn.className = 'answer';
    btn.textContent = choice;
    btn.setAttribute('aria-label', `Answer ${choice}`);
    btn.addEventListener('click', () => onAnswer(choice, btn));
    answers.appendChild(btn);
  }

  ($('feedback') as HTMLElement).textContent = '';
  ($('next') as HTMLButtonElement).disabled = true;
  announce(`Question ${asked}. ${q.prompt} Play the sounds, then choose.`);
}

async function playRoom(room: 'A' | 'B') {
  if (!current) return;
  const p = await ensurePlayer();
  const scene = room === 'A' ? current.sceneA : current.sceneB!;
  if (loadedRoom !== room) {
    p.load(scene);
    loadedRoom = room;
  }
  p.clap();
  announce(`Playing Room ${room}.`);
}

async function playSingle() {
  if (!current) return;
  const p = await ensurePlayer();
  if (loadedRoom !== 'A') {
    p.load(current.sceneA);
    loadedRoom = 'A';
  }
  // Direction scenes use a continuous tone beacon (loaded on `load`); for any
  // clap-bearing scene also fire a clap.
  if (p.hasClap) p.clap();
  announce('Playing the sound. Where is it coming from?');
}

function onAnswer(choice: string, btn: HTMLButtonElement) {
  if (!current || answered) return;
  answered = true;
  const correct = choice === current.correctAnswer;
  if (correct) {
    score++;
    streak++;
  } else {
    streak = 0;
  }

  for (const el of Array.from($('answers').children) as HTMLButtonElement[]) {
    el.disabled = true;
    if (el.textContent === current.correctAnswer) el.classList.add('correct');
    else if (el === btn) el.classList.add('wrong');
  }

  const verdict = correct
    ? 'Correct.'
    : `Incorrect. The answer was ${current.correctAnswer}.`;
  ($('feedback') as HTMLElement).textContent = verdict;
  ($('score') as HTMLElement).textContent = `Score ${score} / ${asked}`;
  ($('next') as HTMLButtonElement).disabled = false;
  announce(`${verdict} Score ${score} of ${asked}. Press Next to continue.`);
  ($('next') as HTMLButtonElement).focus();
}

function main() {
  $('begin').addEventListener('click', async () => {
    ($('begin') as HTMLButtonElement).disabled = true;
    announce('Loading audio…');
    await ensurePlayer();
    ($('begin') as HTMLElement).hidden = true;
    ($('drill') as HTMLElement).hidden = false;
    nextQuestion();
  });

  $('play-a').addEventListener('click', () => playRoom('A'));
  $('play-b').addEventListener('click', () => playRoom('B'));
  $('play-s').addEventListener('click', () => playSingle());
  $('next').addEventListener('click', () => nextQuestion());
}

main();
