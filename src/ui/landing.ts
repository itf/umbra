/**
 * Landing / About screen — the app's front door at "/".
 *
 * Frames the project as BOTH an eyes-free binaural audio game AND a research-backed
 * human-echolocation TRAINER (copy grounded in docs/echolocation-training.md: human
 * echolocation / "flash sonar" is a trainable perceptual skill — presence, then
 * localization, then discrimination — and this project teaches it through play).
 *
 * Like the progress screen, this is a thin, accessible DOM mounted into a host
 * <section>. It is screen-reader-first: a real <h1>, sectioned content under
 * headings, primary actions as real buttons, and — because the whole app is
 * eyes-free-friendly — it focuses the first action on load and announces a concise
 * spoken overview through the same `say()` live-region path the rest of the app uses.
 */

export interface LandingScreenOptions {
  /** Go to the level picker (the "Play" action → /play). */
  onPlay: () => void;
  /** Go to the trainer entry (the "Train" action). */
  onTrain: () => void;
  /** Go to the progress screen (→ /progress). */
  onProgress: () => void;
  /** Go to the credits/licenses screen (→ /credits). Optional. */
  onCredits?: () => void;
  /** Go to the "types of clicks" help page (→ /clicks). Optional. */
  onClicks?: () => void;
  /** Polite live-region announcer (the app's say()). */
  say: (msg: string) => void;
}

/**
 * Render the landing page into `container`, focus the primary action, and announce a
 * short overview. Returns the primary "Play" button (handy for tests).
 */
export function renderLandingScreen(
  container: HTMLElement,
  opts: LandingScreenOptions,
): HTMLButtonElement {
  container.replaceChildren();

  const h1 = document.createElement('h1');
  h1.textContent = 'Audio Navigator';
  container.appendChild(h1);

  // Hero: what the project is, in one honest sentence.
  const hero = document.createElement('p');
  hero.className = 'landing-hero';
  hero.textContent =
    'An eyes-free, binaural audio game — and a human-echolocation trainer. ' +
    'Put on headphones, close your eyes, and learn to navigate a space by sound alone.';
  container.appendChild(hero);

  // Primary actions FIRST in the DOM (and focus order) so an eyes-free visitor lands
  // on something actionable immediately.
  const actions = document.createElement('div');
  actions.className = 'landing-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Get started');

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'primary landing-play';
  playBtn.textContent = 'Play';
  playBtn.setAttribute('aria-label', 'Play — choose a level');
  playBtn.addEventListener('click', opts.onPlay);

  const trainBtn = document.createElement('button');
  trainBtn.type = 'button';
  trainBtn.className = 'primary landing-train';
  trainBtn.textContent = 'Train';
  trainBtn.setAttribute('aria-label', 'Train — echolocation exercises');
  trainBtn.addEventListener('click', opts.onTrain);

  actions.append(playBtn, trainBtn);
  container.appendChild(actions);

  // "How it works" — 3 short points grounded in the research doc.
  const how = document.createElement('section');
  how.className = 'landing-how';
  const h2 = document.createElement('h2');
  h2.textContent = 'How it works';
  how.appendChild(h2);

  const list = document.createElement('ul');
  list.setAttribute('role', 'list');
  const points = [
    'Real binaural audio (HRTF) puts every sound in 3D space — left, right, near, far, ' +
      'above and below — using the interaural and spectral cues your ears already read.',
    'Click to hear the room: a short, broadband probe returns as echoes off the walls. ' +
      'Louder, earlier echoes mean closer, harder surfaces; a quiet direction is an opening.',
    'Human echolocation ("flash sonar") is a trainable skill — sighted and blind learners ' +
      'improve within an hour and keep gaining over weeks. You learn it here by playing: ' +
      'first notice an echo, then place it, then judge distance, size and material.',
  ];
  for (const text of points) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
  how.appendChild(list);
  container.appendChild(how);

  // Secondary navigation: progress + a credits placeholder (a /credits route is being
  // added separately; until then it 404s → landing, which is fine).
  const nav = document.createElement('nav');
  nav.className = 'page-links';
  nav.setAttribute('aria-label', 'More');

  const progressLink = document.createElement('button');
  progressLink.type = 'button';
  progressLink.className = 'linklike landing-progress';
  progressLink.textContent = 'Your progress / best times';
  progressLink.addEventListener('click', opts.onProgress);
  nav.appendChild(progressLink);

  // "Types of clicks" learn page (→ /clicks), when wired.
  if (opts.onClicks) {
    const clicksLink = document.createElement('button');
    clicksLink.type = 'button';
    clicksLink.className = 'linklike landing-clicks';
    clicksLink.textContent = 'Learn: types of clicks';
    clicksLink.addEventListener('click', opts.onClicks);
    nav.appendChild(clicksLink);
  }

  // Credits (→ /credits). A router button when wired; else a plain link that still
  // resolves via the SPA fallback (harmless full-load) under BASE_URL.
  if (opts.onCredits) {
    const creditsBtn = document.createElement('button');
    creditsBtn.type = 'button';
    creditsBtn.className = 'linklike landing-credits';
    creditsBtn.textContent = 'Credits';
    creditsBtn.addEventListener('click', opts.onCredits);
    nav.appendChild(creditsBtn);
  } else {
    const creditsLink = document.createElement('a');
    creditsLink.className = 'landing-credits';
    creditsLink.href = 'credits'; // relative → resolves under BASE_URL
    creditsLink.textContent = 'Credits';
    nav.appendChild(creditsLink);
  }

  container.appendChild(nav);

  // Eyes-free: land focus on the first action, then announce the overview (rides TTS).
  playBtn.focus();
  opts.say(
    'Audio Navigator. An eyes-free binaural audio game and echolocation trainer. ' +
      'Put on headphones. Choose Play to pick a level, or Train for echolocation exercises.',
  );

  return playBtn;
}
