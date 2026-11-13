import {
  IDENTITY_QUATERNION,
  inverseQuaternion,
  multiplyQuaternions,
  slerp,
} from "./quaternion";
import type { Quaternion, RotationSequence } from "./types";

const TIME_EPSILON = 1e-9;

interface ActiveEdge {
  fixedPlateId: number;
  movingPlateId: number;
  quaternion: Quaternion;
  sourceOrder: number;
}

export interface RotationModelOptions {
  extendToDistantPast?: boolean;
}

function containsTime(sequence: RotationSequence, timeMa: number): boolean {
  return (
    timeMa >= sequence.youngestTimeMa - TIME_EPSILON &&
    timeMa <= sequence.oldestTimeMa + TIME_EPSILON
  );
}

function interpolateSequence(
  sequence: RotationSequence,
  timeMa: number,
): Quaternion {
  const samples = sequence.samples;
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) {
    return { ...IDENTITY_QUATERNION };
  }
  if (timeMa <= first.timeMa + TIME_EPSILON) {
    return { ...first.quaternion };
  }
  if (timeMa >= last.timeMa - TIME_EPSILON) {
    return { ...last.quaternion };
  }

  let lowerIndex = 0;
  let upperIndex = samples.length - 1;
  while (lowerIndex + 1 < upperIndex) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
    const middle = samples[middleIndex];
    if (!middle) {
      break;
    }
    if (middle.timeMa <= timeMa) {
      lowerIndex = middleIndex;
    } else {
      upperIndex = middleIndex;
    }
  }

  const younger = samples[lowerIndex];
  const older = samples[upperIndex];
  if (!younger || !older) {
    return { ...last.quaternion };
  }
  if (Math.abs(timeMa - younger.timeMa) <= TIME_EPSILON) {
    return { ...younger.quaternion };
  }
  if (Math.abs(timeMa - older.timeMa) <= TIME_EPSILON) {
    return { ...older.quaternion };
  }

  const ratio =
    (timeMa - younger.timeMa) / (older.timeMa - younger.timeMa);
  return slerp(younger.quaternion, older.quaternion, ratio);
}

export class RotationModel {
  readonly sequences: readonly RotationSequence[];
  readonly plateIds: ReadonlySet<number>;
  readonly minTimeMa: number;
  readonly maxTimeMa: number;

  private readonly extendToDistantPast: boolean;
  private readonly oldestSequenceByMovingPlate = new Map<
    number,
    RotationSequence
  >();

  constructor(
    sequences: readonly RotationSequence[],
    options: RotationModelOptions = {},
  ) {
    this.sequences = [...sequences];
    this.extendToDistantPast = options.extendToDistantPast ?? true;

    const plateIds = new Set<number>([0]);
    let minTimeMa = Number.POSITIVE_INFINITY;
    let maxTimeMa = Number.NEGATIVE_INFINITY;

    for (const sequence of sequences) {
      plateIds.add(sequence.fixedPlateId);
      plateIds.add(sequence.movingPlateId);
      minTimeMa = Math.min(minTimeMa, sequence.youngestTimeMa);
      maxTimeMa = Math.max(maxTimeMa, sequence.oldestTimeMa);

      const currentOldest = this.oldestSequenceByMovingPlate.get(
        sequence.movingPlateId,
      );
      if (
        !currentOldest ||
        sequence.oldestTimeMa > currentOldest.oldestTimeMa ||
        (sequence.oldestTimeMa === currentOldest.oldestTimeMa &&
          sequence.sourceOrder > currentOldest.sourceOrder)
      ) {
        this.oldestSequenceByMovingPlate.set(
          sequence.movingPlateId,
          sequence,
        );
      }
    }

    this.plateIds = plateIds;
    this.minTimeMa = Number.isFinite(minTimeMa) ? minTimeMa : 0;
    this.maxTimeMa = Number.isFinite(maxTimeMa) ? maxTimeMa : 0;
  }

  getRotationMap(
    timeMa: number,
    anchorPlateId = 0,
  ): ReadonlyMap<number, Quaternion> {
    const activeEdges: ActiveEdge[] = [];

    // ReconstructionGraph stores each newly parsed edge at the front of its
    // adjacency list, so later file sequences have crossover priority.
    const descendingSequences = [...this.sequences].sort(
      (left, right) => right.sourceOrder - left.sourceOrder,
    );

    for (const sequence of descendingSequences) {
      if (containsTime(sequence, timeMa)) {
        activeEdges.push({
          fixedPlateId: sequence.fixedPlateId,
          movingPlateId: sequence.movingPlateId,
          quaternion: interpolateSequence(sequence, timeMa),
          sourceOrder: sequence.sourceOrder,
        });
      }
    }

    if (this.extendToDistantPast) {
      for (const sequence of this.oldestSequenceByMovingPlate.values()) {
        if (timeMa > sequence.oldestTimeMa + TIME_EPSILON) {
          const oldestSample = sequence.samples.at(-1);
          if (oldestSample) {
            activeEdges.unshift({
              fixedPlateId: sequence.fixedPlateId,
              movingPlateId: sequence.movingPlateId,
              quaternion: { ...oldestSample.quaternion },
              sourceOrder: Number.MAX_SAFE_INTEGER,
            });
          }
        }
      }
    }

    const outgoing = new Map<number, ActiveEdge[]>();
    const incoming = new Map<number, ActiveEdge[]>();
    for (const edge of activeEdges) {
      const outgoingEdges = outgoing.get(edge.fixedPlateId) ?? [];
      outgoingEdges.push(edge);
      outgoing.set(edge.fixedPlateId, outgoingEdges);

      const incomingEdges = incoming.get(edge.movingPlateId) ?? [];
      incomingEdges.push(edge);
      incoming.set(edge.movingPlateId, incomingEdges);
    }

    const rotations = new Map<number, Quaternion>([
      [anchorPlateId, { ...IDENTITY_QUATERNION }],
    ]);

    const createSubtree = (
      currentPlateId: number,
      parentDirection: "forward" | "reverse" | undefined,
    ): void => {
      const currentRotation = rotations.get(currentPlateId);
      if (!currentRotation) {
        return;
      }

      // Match ReconstructionTree: only the root or a reverse branch can keep
      // walking upward, and only one incoming edge is followed.
      if (parentDirection === undefined || parentDirection === "reverse") {
        for (const edge of incoming.get(currentPlateId) ?? []) {
          if (
            edge.fixedPlateId === anchorPlateId ||
            rotations.has(edge.fixedPlateId)
          ) {
            continue;
          }
          rotations.set(
            edge.fixedPlateId,
            multiplyQuaternions(
              currentRotation,
              inverseQuaternion(edge.quaternion),
            ),
          );
          createSubtree(edge.fixedPlateId, "reverse");
          break;
        }
      }

      for (const edge of outgoing.get(currentPlateId) ?? []) {
        if (
          edge.movingPlateId === anchorPlateId ||
          rotations.has(edge.movingPlateId)
        ) {
          continue;
        }
        rotations.set(
          edge.movingPlateId,
          multiplyQuaternions(currentRotation, edge.quaternion),
        );
        createSubtree(edge.movingPlateId, "forward");
      }
    };

    createSubtree(anchorPlateId, undefined);
    return rotations;
  }

  getRotation(
    timeMa: number,
    movingPlateId: number,
    anchorPlateId = 0,
  ): Quaternion | undefined {
    return this.getRotationMap(timeMa, anchorPlateId).get(movingPlateId);
  }
}
