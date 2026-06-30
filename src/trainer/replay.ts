/**
 * PURE freeze-frame post-answer replay planning for the Echolocation Trainer.
 *
 * After an A/B discrimination question the trainer plays the CORRECT comparison
 * back-to-back (Room A, gap, Room B) so the learner HEARS what they missed —
 * the biggest learning win, since a wrong answer otherwise teaches nothing. This
 * module decides PURELY whether to replay, in what order, and with which spoken /
 * on-screen labels; the actual scene playback + timing live in trainer.ts.
 *
 * No DOM, no audio: same (question, correctness) → identical plan, so the
 * sequencing decision and label wording are fully unit-testable.
 */
import type { Question } from './exercises';
import { hasRoomB } from './exercises';

/** One step of the replay: which room to play, plus the label spoken/shown for it. */
export interface ReplayStep {
  room: 'A' | 'B';
  /** Spoken/visible label, e.g. "A is the larger room (correct)." */
  label: string;
  /** True for the step that is the correct answer (for highlighting). */
  isCorrect: boolean;
}

/** A full replay plan: the steps in play order + the gap (ms) between scenes. */
export interface ReplayPlan {
  steps: ReplayStep[];
  /** Silent gap between the two scenes, milliseconds. */
  gapMs: number;
  /** Lead-in line spoken before the replay starts. */
  intro: string;
}

/**
 * The short descriptor naming WHAT each room is, per exercise type. Returns a
 * pair { correct, other }: the phrase for the correct room and for the other one
 * (e.g. larger → { correct: 'the larger room', other: 'smaller' }). Falls back to
 * a generic "the correct room" / "the other room" for anything unmapped, so a new
 * exercise type still replays sensibly.
 */
export function replayDescriptors(type: Question['type']): { correct: string; other: string } {
  switch (type) {
    case 'larger': return { correct: 'the larger room', other: 'smaller' };
    case 'wider': return { correct: 'the wider room', other: 'narrower' };
    case 'longer': return { correct: 'the longer room', other: 'shorter' };
    case 'carpet': return { correct: 'the carpeted (soft) room', other: 'hard-walled' };
    case 'brick': return { correct: 'the brick (scattered) room', other: 'concrete (sharp)' };
    case 'material': return { correct: 'the target material', other: 'the foil material' };
    case 'metal': return { correct: 'the metal-absorber room', other: 'carpeted' };
    case 'reflector': return { correct: 'the panel on the correct side', other: 'the other side' };
    case 'distance': return { correct: 'the room with the closer wall', other: 'the farther wall' };
    default: return { correct: 'the correct room', other: 'the other room' };
  }
}

/**
 * Plan the freeze-frame replay for a just-answered question, or null when there
 * should be NO replay (single-scene exercises with no Room B — direction / gap /
 * orientation — keep their current behaviour).
 *
 * The replay ALWAYS plays Room A first then Room B (the order the learner heard
 * them), with a labelled call-out of which is which and which was correct, so it
 * reinforces a right answer and corrects a wrong one identically. `correct` only
 * tweaks the intro wording (reinforce vs correct).
 */
export function planReplay(
  q: Pick<Question, 'type' | 'correctAnswer'>,
  correct: boolean,
  /**
   * Optional per-room reveal text (e.g. dimensions "8.4 × 4.6 × 7.1 m" for the
   * size drills, or the wall distance for the distance drill) appended to each
   * step label so the ground-truth numbers stay VISIBLE while that room plays —
   * the replay overwrites #feedback, so this is where the size reveal must live.
   */
  reveal?: { a?: string; b?: string },
): ReplayPlan | null {
  if (!hasRoomB(q as Question)) return null; // single-scene: nothing to compare

  // The A/B drills label their correct choice as "Room A"/"Room B" (or Left/Right
  // for gap, but gap is single-scene so excluded above). Map to the room letter.
  const correctRoom: 'A' | 'B' = q.correctAnswer === 'Room B' ? 'B' : 'A';
  const d = replayDescriptors(q.type);

  const stepFor = (room: 'A' | 'B'): ReplayStep => {
    const isCorrect = room === correctRoom;
    const dims = room === 'A' ? reveal?.a : reveal?.b;
    const what = isCorrect ? `${d.correct} (correct)` : d.other;
    const label = dims
      ? `${room} is ${what} — ${dims}.`
      : `${room} is ${what}.`;
    return { room, label, isCorrect };
  };

  const intro = correct
    ? 'Hear it again: '
    : 'Listen to the difference: ';

  return {
    steps: [stepFor('A'), stepFor('B')],
    gapMs: 500,
    intro,
  };
}

/** Joined spoken line for a whole plan (intro + each step's label). */
export function replayAnnouncement(plan: ReplayPlan): string {
  return plan.intro + plan.steps.map((s) => s.label).join(' ');
}
