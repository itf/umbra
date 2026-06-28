/**
 * Listenable debug scenes. Each scene describes geometry + sound sources so the
 * debug page can render and play it. Scenes are deliberately A/B-able (small vs
 * large room, room vs infinite space) so you can hear one variable at a time.
 */
import { MATERIALS, NUM_BANDS, type ShoeboxMaterialMap } from '../engine/acoustics/materials';
import type { WallDef, EdgeDef } from '../engine/acoustics/core';

export interface SceneSource {
  /** World position [x,y,z]. */
  pos: [number, number, number];
  /** 'tone' = pulsed beacon you can localize; 'clap' = impulse to excite the room. */
  kind: 'tone' | 'clap';
  freq?: number;
  label?: string;
}

export interface Scene {
  id: string;
  title: string;
  description: string;
  listener: [number, number, number];
  /** Box room dimensions [x,y,z], or null for infinite/open space (no walls). */
  roomSize: [number, number, number] | null;
  /** Per-wall materials for the box room. */
  materials?: ShoeboxMaterialMap;
  /** Extra free-standing walls (e.g. a large object's faces) as polygon walls. */
  extraWalls?: WallDef[];
  /** Diffracting edges (doorway jambs / corners). */
  edges?: EdgeDef[];
  sources: SceneSource[];
  /** Max image-source reflection order for this scene. */
  maxOrder: number;
}

const abs = (mat: keyof typeof MATERIALS): number[] => [...MATERIALS[mat]];

/**
 * Build the 6 axis-aligned walls of a box as polygon WallDefs, so box rooms and
 * free objects share one representation in the general solver.
 */
export function boxWalls(
  size: [number, number, number],
  origin: [number, number, number],
  material: keyof typeof MATERIALS,
): WallDef[] {
  const [sx, sy, sz] = size;
  const [ox, oy, oz] = origin;
  const a = abs(material);
  const v = (x: number, y: number, z: number): [number, number, number] => [ox + x, oy + y, oz + z];
  return [
    { verts: [v(0, 0, 0), v(0, 0, sz), v(0, sy, sz), v(0, sy, 0)], absorption: a }, // -x
    { verts: [v(sx, 0, 0), v(sx, sy, 0), v(sx, sy, sz), v(sx, 0, sz)], absorption: a }, // +x
    { verts: [v(0, 0, 0), v(sx, 0, 0), v(sx, 0, sz), v(0, 0, sz)], absorption: a }, // floor
    { verts: [v(0, sy, 0), v(0, sy, sz), v(sx, sy, sz), v(sx, sy, 0)], absorption: a }, // ceil
    { verts: [v(0, 0, 0), v(0, sy, 0), v(sx, sy, 0), v(sx, 0, 0)], absorption: a }, // -z
    { verts: [v(0, 0, sz), v(sx, 0, sz), v(sx, sy, sz), v(0, sy, sz)], absorption: a }, // +z
  ];
}

export const SCENES: Scene[] = [
  {
    id: 'beacon',
    title: 'Single beacon',
    description:
      'A pulsed tone fixed ahead and to your right. Turn to face it — it should center. Pure HRTF direction, minimal room.',
    listener: [4, 1.6, 5],
    roomSize: [8, 3, 10],
    materials: { '-y': 'carpet' }, // mostly dry so you hear direction, not echo
    sources: [{ pos: [6, 1.6, 3], kind: 'tone', freq: 440, label: 'beacon' }],
    maxOrder: 1,
  },
  {
    id: 'room-small',
    title: 'Room size — SMALL',
    description: 'Clap in a tight 3×2.5×3 m concrete room. Note how soon the echoes return.',
    listener: [1.5, 1.3, 1.5],
    roomSize: [3, 2.5, 3],
    materials: { '-x': 'concrete', '+x': 'concrete', '-z': 'concrete', '+z': 'concrete', '+y': 'concrete', '-y': 'concrete' },
    sources: [{ pos: [1.5, 1.3, 1.5], kind: 'clap', label: 'clap' }],
    maxOrder: 2,
  },
  {
    id: 'room-large',
    title: 'Room size — LARGE',
    description: 'Same clap in a big 18×8×24 m concrete hall. Echoes return much later — the size cue.',
    listener: [9, 1.6, 12],
    roomSize: [18, 8, 24],
    materials: { '-x': 'concrete', '+x': 'concrete', '-z': 'concrete', '+z': 'concrete', '+y': 'concrete', '-y': 'concrete' },
    sources: [{ pos: [9, 1.6, 12], kind: 'clap', label: 'clap' }],
    maxOrder: 2,
  },
  {
    id: 'material-hard',
    title: 'Material — GLASS (bright)',
    description: 'A medium room with glass walls. Clap: reflections stay bright and sharp.',
    listener: [3, 1.6, 4],
    roomSize: [6, 3, 8],
    materials: { '-x': 'glass', '+x': 'glass', '-z': 'glass', '+z': 'glass', '+y': 'glass', '-y': 'glass' },
    sources: [{ pos: [3, 1.6, 4], kind: 'clap', label: 'clap' }],
    maxOrder: 2,
  },
  {
    id: 'material-soft',
    title: 'Material — CARPET/FOAM (dull)',
    description: 'Same room, soft absorbent walls. Clap: reflections are dull and die fast.',
    listener: [3, 1.6, 4],
    roomSize: [6, 3, 8],
    materials: { '-x': 'carpet', '+x': 'carpet', '-z': 'acoustic_foam', '+z': 'acoustic_foam', '+y': 'acoustic_foam', '-y': 'carpet' },
    sources: [{ pos: [3, 1.6, 4], kind: 'clap', label: 'clap' }],
    maxOrder: 2,
  },
  {
    id: 'doorway',
    title: 'Diffraction — doorway',
    description:
      'A tone in the next room, around a corner. The direct path is blocked; you hear it bend through the doorway edge — quieter and duller.',
    listener: [2, 1.6, 4],
    roomSize: [8, 3, 8],
    materials: { '-y': 'concrete' },
    // A doorway edge (vertical jamb) the sound diffracts around.
    edges: [
      [
        [4, 0, 2],
        [4, 3, 2],
      ],
    ],
    sources: [{ pos: [6, 1.6, 1], kind: 'tone', freq: 330, label: 'next-room tone' }],
    maxOrder: 1,
  },
  {
    id: 'object-in-room',
    title: 'Large object — in a large room',
    description:
      'A big reflective block right beside you, inside a large hall. You hear both the object’s nearby reflection AND the room around it.',
    listener: [9, 1.6, 12],
    roomSize: [18, 8, 24],
    materials: { '-x': 'concrete', '+x': 'concrete', '-z': 'concrete', '+z': 'concrete', '+y': 'concrete', '-y': 'concrete' },
    // A 2×2×2 m concrete block 1.2 m to the listener's right.
    extraWalls: boxWalls([2, 2, 2], [10.2, 0, 11], 'concrete'),
    sources: [{ pos: [9, 1.6, 9], kind: 'clap', label: 'clap' }],
    maxOrder: 2,
  },
  {
    id: 'object-in-void',
    title: 'Large object — in infinite space',
    description:
      'The SAME block beside you, but no room at all. You hear only the object’s reflection against silence — isolate the object cue from the room.',
    listener: [0, 1.6, 0],
    roomSize: null, // open space: no room walls
    extraWalls: boxWalls([2, 2, 2], [1.2, 0, -1], 'concrete'),
    sources: [{ pos: [0, 1.6, -3], kind: 'clap', label: 'clap' }],
    maxOrder: 1,
  },
];

/** Assemble the full wall list for a scene (room box + any free objects). */
export function sceneWalls(scene: Scene): WallDef[] {
  const walls: WallDef[] = [];
  if (scene.roomSize) {
    const mat = scene.materials ?? {};
    // Build room walls honoring per-wall materials (default concrete).
    const [sx, sy, sz] = scene.roomSize;
    const wallMat = (w: keyof ShoeboxMaterialMap): keyof typeof MATERIALS =>
      (mat[w] as keyof typeof MATERIALS) ?? 'concrete';
    const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
    const named: Array<[keyof ShoeboxMaterialMap, [number, number, number][]]> = [
      ['-x', [v(0, 0, 0), v(0, 0, sz), v(0, sy, sz), v(0, sy, 0)]],
      ['+x', [v(sx, 0, 0), v(sx, sy, 0), v(sx, sy, sz), v(sx, 0, sz)]],
      ['-y', [v(0, 0, 0), v(sx, 0, 0), v(sx, 0, sz), v(0, 0, sz)]],
      ['+y', [v(0, sy, 0), v(0, sy, sz), v(sx, sy, sz), v(sx, sy, 0)]],
      ['-z', [v(0, 0, 0), v(0, sy, 0), v(sx, sy, 0), v(sx, 0, 0)]],
      ['+z', [v(0, 0, sz), v(sx, 0, sz), v(sx, sy, sz), v(0, sy, sz)]],
    ];
    for (const [name, verts] of named) {
      walls.push({ verts, absorption: abs(wallMat(name)) });
    }
  }
  if (scene.extraWalls) walls.push(...scene.extraWalls);
  return walls;
}

void NUM_BANDS;
