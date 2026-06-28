import { startAudio } from './engine/audioGraph';
import { HrtfRenderer } from './engine/hrtf/renderer';
import { Compass } from './game/compass';
import { initAcoustics } from './engine/acoustics/core';
import { ClapRoom } from './engine/acoustics/clapRoom';
import type { ShoeboxParams } from './engine/acoustics/core';
import { Game, type GameLevel } from './game/game';
import { Heading } from './game/heading';
import { currentEditorLevel, loadLevel } from './level/load';

const HRTF_URL = '/assets/hrtf/sadie_h3.hrtf';

const statusEl = document.getElementById('status')!;
const alertsEl = document.getElementById('alerts')!;
const startScreen = document.getElementById('start-screen')!;
const gameScreen = document.getElementById('game-screen')!;
const startButton = document.getElementById('start-button') as HTMLButtonElement;

function say(msg: string) {
  statusEl.textContent = msg;
}
function alert(msg: string) {
  alertsEl.textContent = msg;
}

// Default level: a 8×10 m room; start at one end, beacon at the far end. If the
// page was opened with ?level=current, load the level designed in the editor
// (stored in localStorage) instead.
let ROOM: [number, number, number] = [8, 3, 10];
let LEVEL: GameLevel = {
  start: { x: 4, z: 8.5, yaw: 0 }, // facing -z (toward the beacon end)
  beacon: { x: 4, z: 1.5, freq: 440 },
  goalRadius: 0.8,
};

if (new URLSearchParams(location.search).get('level') === 'current') {
  const edited = currentEditorLevel();
  if (edited) {
    const loaded = loadLevel(edited);
    LEVEL = loaded.game;
    ROOM = loaded.roomSize;
  }
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  say('Loading spatial audio…');
  try {
    const { ctx, master } = await startAudio();
    const renderer = await HrtfRenderer.create(ctx, HRTF_URL);
    await initAcoustics();

    startScreen.hidden = true;
    gameScreen.hidden = false;

    let won = false;
    const game = new Game({ ctx, master }, renderer, LEVEL, {
      onStep: (foot, stride) =>
        say(`Step ${foot === 'L' ? 'left' : 'right'} (${stride.toFixed(2)} m).`),
      onStumble: (reason) =>
        alert(
          reason === 'wall'
            ? 'You bumped into a wall.'
            : reason === 'too-fast'
              ? 'You stumbled — slow down!'
              : reason === 'wrong-foot'
                ? 'Wrong foot — alternate left and right.'
                : 'Recovering…',
        ),
      onWin: () => {
        won = true;
        alert('You reached the beacon. Level complete!');
      },
      onProgress: (d) => updateFootHints(d),
    });

    // --- Turn control: the compass dial (only turn control) ---
    setupTurning(game);

    // --- Step buttons ---
    const stepLeft = document.getElementById('step-left') as HTMLButtonElement;
    const stepRight = document.getElementById('step-right') as HTMLButtonElement;
    const doStep = (foot: 'L' | 'R') => {
      if (won) return;
      game.step(foot);
      updateFeet(game); // refresh immediately after a step
    };
    // pointerdown (not click) for tight rhythm response.
    stepLeft.addEventListener('pointerdown', (e) => { e.preventDefault(); doStep('L'); });
    stepRight.addEventListener('pointerdown', (e) => { e.preventDefault(); doStep('R'); });
    // Keyboard step keys (arrows are reserved for turning): A = left, L = right.
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key === 'a' || e.key === 'A') doStep('L');
      else if (e.key === 'l' || e.key === 'L') doStep('R');
    });

    // --- Clap to hear the room (echo button) ---
    setupClap(ctx, master, renderer, game);

    // Foot display loop: only the expected foot shows while walking; after the
    // player settles (idle ~1.4s) BOTH feet appear so either can lead. Polled so
    // the time-based settle transition happens on its own.
    const footLoop = () => {
      updateFeet(game);
      requestAnimationFrame(footLoop);
    };
    footLoop();
    say('Walk to the beacon ahead. Alternate left and right steps — and don\'t rush.');
  } catch (err) {
    console.error(err);
    alert('Could not start audio: ' + (err as Error).message);
    startButton.disabled = false;
  }
});

/**
 * Show/hide the footprints. While walking, only the expected foot is visible (the
 * other is hidden); once settled (idle), BOTH show so either foot can lead. The
 * visible foot(s) glow as "active".
 */
function updateFeet(game: Game) {
  const l = document.getElementById('step-left')!;
  const r = document.getElementById('step-right')!;
  const settled = game.isSettled();
  const next = game.nextFoot;

  const leftShown = settled || next === 'L';
  const rightShown = settled || next === 'R';
  l.classList.toggle('hidden', !leftShown);
  r.classList.toggle('hidden', !rightShown);
  // The foot(s) you may press glow as active.
  l.classList.toggle('active', leftShown);
  r.classList.toggle('active', rightShown);
}

/** Announce closing distance at coarse thresholds (eyes-free progress feedback). */
let lastBand = -1;
function updateFootHints(distance: number) {
  const band = distance < 1 ? 0 : distance < 3 ? 1 : distance < 6 ? 2 : 3;
  if (band !== lastBand) {
    lastBand = band;
    const labels = ['Almost there', 'Close', 'Getting closer', 'Far'];
    say(`${labels[band]} — ${distance.toFixed(1)} m to the beacon.`);
  }
}

function setupTurning(game: Game) {
  const turnPad = document.getElementById('turn-pad')!;

  // Rate-limited heading: the compass sets a TARGET; the actual heading slews
  // toward it at a capped angular speed (physically plausible, and it keeps the
  // HRTF direction changing slowly so fast drags don't cause audio artifacts).
  const heading = new Heading(LEVEL.start.yaw);

  // The compass is the only turn control. Dragging one full compass width turns
  // you exactly ARC_DEG (120°). The dial + audio both follow the SLEWED heading.
  const compass = new Compass({
    size: 300,
    onYaw: (yaw) => heading.setTarget(yaw),
    // On release, stop where the heading actually IS — snap the target to the
    // current slewed value so it doesn't keep coasting toward the last drag point.
    onRelease: () => heading.setTarget(heading.current),
  });
  turnPad.appendChild(compass.el);

  heading.reset(LEVEL.start.yaw);
  game.setYaw(heading.current);
  compass.setHeading(heading.current);

  // Slew loop: advance toward target, then apply the SLEWED value to both the
  // audio (game) and the compass so they stay in lockstep and catch up together.
  let lastT = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (heading.tick(dt)) {
      game.setYaw(heading.current);
      compass.setHeading(heading.current);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function setupClap(
  ctx: AudioContext,
  master: GainNode,
  renderer: HrtfRenderer,
  game: Game,
) {
  const room: ShoeboxParams = {
    size: ROOM,
    materials: { '-y': 'carpet', '-z': 'concrete', '+z': 'concrete', '-x': 'concrete', '+x': 'concrete', '+y': 'concrete' },
    listener: [LEVEL.start.x, 1.6, LEVEL.start.z],
    source: [LEVEL.start.x, 1.6, LEVEL.start.z],
    maxOrder: 2,
  };
  const clapRoom = new ClapRoom({ ctx, master }, renderer);
  const listenBtn = document.getElementById('listen');
  listenBtn?.addEventListener('click', () => {
    // Clap from the player's current position (game owns the listener pose).
    const p = game.listenerPos;
    room.listener = [p.x, p.y, p.z];
    room.source = [p.x, p.y, p.z];
    clapRoom.updateRoom(room, p.yaw);
    clapRoom.clap();
    say('Clap! Listen to the room around you.');
  });
}
