import { quaternionFromEulerPole } from "./quaternion";
import type {
  RotationParseDiagnostic,
  RotationParseResult,
  RotationSample,
  RotationSequence,
} from "./types";

const TIME_EPSILON = 1e-9;

interface ParsedLine {
  movingPlateId: number;
  fixedPlateId: number;
  sample: RotationSample;
}

interface MutableSequence {
  fixedPlateId: number;
  movingPlateId: number;
  samples: RotationSample[];
  sourceOrder: number;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= TIME_EPSILON;
}

function parseLine(
  line: string,
  lineNumber: number,
  diagnostics: RotationParseDiagnostic[],
): ParsedLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length < 6) {
    diagnostics.push({
      lineNumber,
      severity: "error",
      message: "Expected six PLATES rotation fields.",
    });
    return undefined;
  }

  const movingPlateId = Number.parseInt(fields[0] ?? "", 10);
  const timeMa = Number(fields[1]);
  const poleLatitudeDeg = Number(fields[2]);
  const poleLongitudeDeg = Number(fields[3]);
  const angleDeg = Number(fields[4]);
  const fixedPlateId = Number.parseInt(fields[5] ?? "", 10);

  if (
    !Number.isInteger(movingPlateId) ||
    !Number.isInteger(fixedPlateId) ||
    !Number.isFinite(timeMa) ||
    !Number.isFinite(poleLatitudeDeg) ||
    !Number.isFinite(poleLongitudeDeg) ||
    !Number.isFinite(angleDeg)
  ) {
    diagnostics.push({
      lineNumber,
      severity: "error",
      message: "Rotation line contains an invalid numeric field.",
    });
    return undefined;
  }
  if (poleLatitudeDeg < -90 || poleLatitudeDeg > 90) {
    diagnostics.push({
      lineNumber,
      severity: "error",
      message: `Invalid Euler-pole latitude ${poleLatitudeDeg}.`,
    });
    return undefined;
  }
  if (poleLongitudeDeg < -180 || poleLongitudeDeg > 180) {
    diagnostics.push({
      lineNumber,
      severity: "error",
      message: `Invalid Euler-pole longitude ${poleLongitudeDeg}.`,
    });
    return undefined;
  }
  if (movingPlateId === fixedPlateId && movingPlateId !== 999) {
    diagnostics.push({
      lineNumber,
      severity: "error",
      message: "Moving and fixed plate IDs are identical; pole was discarded.",
    });
    return undefined;
  }

  const commentIndex = line.indexOf("!");
  const comment =
    commentIndex === -1 ? "" : line.slice(commentIndex + 1).trim();
  const enabled = movingPlateId !== 999;

  return {
    movingPlateId,
    fixedPlateId,
    sample: {
      timeMa,
      poleLatitudeDeg,
      poleLongitudeDeg,
      angleDeg,
      quaternion: quaternionFromEulerPole(
        poleLatitudeDeg,
        poleLongitudeDeg,
        angleDeg,
      ),
      enabled,
      lineNumber,
      comment,
    },
  };
}

/**
 * Parse the legacy PLATES rotation format with the same sequence-boundary
 * rules used by PlatesRotationFormatReader.cc.
 */
export function parsePlatesRotationFile(text: string): RotationParseResult {
  const diagnostics: RotationParseDiagnostic[] = [];
  const mutableSequences: MutableSequence[] = [];
  let current: MutableSequence | undefined;
  let parsedLineCount = 0;
  let disabledSampleCount = 0;

  const createSequence = (line: ParsedLine): MutableSequence => {
    const sequence: MutableSequence = {
      fixedPlateId: line.fixedPlateId,
      movingPlateId: line.movingPlateId,
      samples: [line.sample],
      sourceOrder: mutableSequences.length,
    };
    mutableSequences.push(sequence);
    return sequence;
  };

  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    const parsed = parseLine(line, lineIndex + 1, diagnostics);
    if (!parsed) {
      continue;
    }
    parsedLineCount += 1;
    if (!parsed.sample.enabled) {
      disabledSampleCount += 1;
    }

    if (!current) {
      current = createSequence(parsed);
      continue;
    }

    const previous = current.samples.at(-1);
    if (!previous) {
      current = createSequence(parsed);
      continue;
    }

    // GPlates treats plate 999 as a disabled/commented sample in the current
    // sequence when its fixed plate still matches.
    const disabledBelongsToCurrent =
      parsed.movingPlateId === 999 &&
      parsed.fixedPlateId === current.fixedPlateId &&
      parsed.sample.timeMa + TIME_EPSILON >= previous.timeMa;

    if (disabledBelongsToCurrent) {
      current.samples.push(parsed.sample);
      continue;
    }

    const enabledAfterDisabledAtSameTime =
      !previous.enabled &&
      approximatelyEqual(parsed.sample.timeMa, previous.timeMa) &&
      parsed.fixedPlateId === current.fixedPlateId &&
      parsed.movingPlateId === current.movingPlateId;

    const timeStartsNewSequence =
      parsed.sample.timeMa < previous.timeMa - TIME_EPSILON ||
      (approximatelyEqual(parsed.sample.timeMa, previous.timeMa) &&
        !enabledAfterDisabledAtSameTime);
    const plateIdsChanged =
      parsed.fixedPlateId !== current.fixedPlateId ||
      parsed.movingPlateId !== current.movingPlateId;

    if (timeStartsNewSequence || plateIdsChanged) {
      current = createSequence(parsed);
    } else {
      current.samples.push(parsed.sample);
    }
  }

  const sequences: RotationSequence[] = [];
  for (const mutable of mutableSequences) {
    const samples = mutable.samples.filter((sample) => sample.enabled);
    if (mutable.movingPlateId === 999 || samples.length < 2) {
      continue;
    }

    const first = samples[0];
    const last = samples.at(-1);
    if (!first || !last) {
      continue;
    }

    sequences.push({
      id: `${mutable.movingPlateId}:${mutable.fixedPlateId}:${mutable.sourceOrder}`,
      fixedPlateId: mutable.fixedPlateId,
      movingPlateId: mutable.movingPlateId,
      samples,
      sourceOrder: mutable.sourceOrder,
      youngestTimeMa: first.timeMa,
      oldestTimeMa: last.timeMa,
    });
  }

  return {
    sequences,
    diagnostics,
    parsedLineCount,
    disabledSampleCount,
  };
}
