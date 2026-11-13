import type {
  GpmlParseResult,
  LonLat,
  PlateFeature,
  PlatePolygon,
} from "./types";

function elementsByLocalName(
  root: ParentNode,
  localName: string,
): Element[] {
  return Array.from(root.querySelectorAll("*")).filter(
    (element) => element.localName === localName,
  );
}

function firstByLocalName(
  root: ParentNode,
  localName: string,
): Element | undefined {
  return elementsByLocalName(root, localName)[0];
}

function directChildByLocalName(
  root: Element,
  localName: string,
): Element | undefined {
  return Array.from(root.children).find(
    (element) => element.localName === localName,
  );
}

function parseGeologicalTime(value: string | null): number {
  const normalized = value?.trim() ?? "";
  if (normalized.endsWith("/distantPast")) {
    return Number.POSITIVE_INFINITY;
  }
  if (normalized.endsWith("/distantFuture")) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid geological time "${normalized}".`);
  }
  return parsed;
}

function coordinatesEqual(left: LonLat, right: LonLat): boolean {
  return (
    Math.abs(left[0] - right[0]) <= 1e-12 &&
    Math.abs(left[1] - right[1]) <= 1e-12
  );
}

/**
 * GPML gml:posList coordinates are latitude/longitude in GPlates' spherical
 * convention. The application stores longitude/latitude for Cesium.
 */
function parsePositionList(element: Element): LonLat[] {
  const values = (element.textContent ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);

  if (values.length < 6 || values.length % 2 !== 0) {
    throw new Error("Polygon position list must contain at least three pairs.");
  }

  const coordinates: LonLat[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const latitude = values[index];
    const longitude = values[index + 1];
    if (
      latitude === undefined ||
      longitude === undefined ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      throw new Error("Polygon position list contains a non-numeric value.");
    }
    coordinates.push([longitude, latitude]);
  }

  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (first && last && coordinatesEqual(first, last)) {
    coordinates.pop();
  }
  if (coordinates.length < 3) {
    throw new Error("Polygon ring has fewer than three distinct coordinates.");
  }
  return coordinates;
}

function parsePolygon(element: Element): PlatePolygon {
  const exteriorElement = firstByLocalName(element, "exterior");
  const exteriorPositionList = exteriorElement
    ? firstByLocalName(exteriorElement, "posList")
    : undefined;
  if (!exteriorPositionList) {
    throw new Error("Polygon is missing an exterior gml:posList.");
  }

  const holes: LonLat[][] = [];
  for (const interiorElement of elementsByLocalName(element, "interior")) {
    const positionList = firstByLocalName(interiorElement, "posList");
    if (positionList) {
      holes.push(parsePositionList(positionList));
    }
  }

  return {
    exterior: parsePositionList(exteriorPositionList),
    holes,
  };
}

function readShapefileAttributes(featureElement: Element): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const dictionaryElement of elementsByLocalName(
    featureElement,
    "KeyValueDictionaryElement",
  )) {
    const key = directChildByLocalName(dictionaryElement, "key");
    const value = directChildByLocalName(dictionaryElement, "value");
    if (key?.textContent && value) {
      attributes.set(
        key.textContent.trim().toUpperCase(),
        value.textContent?.trim() ?? "",
      );
    }
  }
  return attributes;
}

export function isFeatureValidAtTime(
  feature: Pick<PlateFeature, "validFromMa" | "validToMa">,
  timeMa: number,
): boolean {
  return feature.validFromMa >= timeMa && timeMa >= feature.validToMa;
}

export function parseGpmlPlatePolygons(xmlText: string): GpmlParseResult {
  const document = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = firstByLocalName(document, "parsererror");
  if (parserError) {
    throw new Error(
      `Unable to parse GPML: ${parserError.textContent?.trim() ?? "XML error"}`,
    );
  }

  const features: PlateFeature[] = [];
  const warnings: string[] = [];
  let polygonCount = 0;
  let unsupportedGeometryCount = 0;

  const featureMembers = elementsByLocalName(document, "featureMember");
  for (const [sourceIndex, featureMember] of featureMembers.entries()) {
    const featureElement = featureMember.firstElementChild;
    if (!featureElement) {
      warnings.push(`Feature member ${sourceIndex} is empty.`);
      continue;
    }

    const identity =
      firstByLocalName(featureElement, "identity")?.textContent?.trim() ??
      `feature-${sourceIndex}`;
    const reconstructionPlateId = firstByLocalName(
      featureElement,
      "reconstructionPlateId",
    );
    const plateValue = reconstructionPlateId
      ? firstByLocalName(reconstructionPlateId, "value")
      : undefined;
    const plateId = Number.parseInt(plateValue?.textContent?.trim() ?? "", 10);
    if (!Number.isInteger(plateId)) {
      warnings.push(`${identity}: missing reconstruction plate ID.`);
      continue;
    }

    const validTime = firstByLocalName(featureElement, "validTime");
    const timePositions = validTime
      ? elementsByLocalName(validTime, "timePosition")
      : [];
    let validFromMa = Number.POSITIVE_INFINITY;
    let validToMa = Number.NEGATIVE_INFINITY;
    try {
      if (timePositions[0]) {
        validFromMa = parseGeologicalTime(timePositions[0].textContent);
      }
      if (timePositions[1]) {
        validToMa = parseGeologicalTime(timePositions[1].textContent);
      }
    } catch (error) {
      warnings.push(
        `${identity}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const polygons: PlatePolygon[] = [];
    for (const polygonElement of elementsByLocalName(
      featureElement,
      "Polygon",
    )) {
      try {
        polygons.push(parsePolygon(polygonElement));
        polygonCount += 1;
      } catch (error) {
        warnings.push(
          `${identity}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    unsupportedGeometryCount += elementsByLocalName(
      featureElement,
      "OrientableCurve",
    ).length;

    const shapefileAttributes = readShapefileAttributes(featureElement);
    const gmlName =
      directChildByLocalName(featureElement, "name")?.textContent?.trim() ?? "";
    const gmlDescription =
      directChildByLocalName(featureElement, "description")?.textContent?.trim() ??
      "";

    features.push({
      id: identity,
      plateId,
      name:
        shapefileAttributes.get("NAME") ||
        gmlName ||
        `Plate ${plateId}`,
      description:
        shapefileAttributes.get("DESCR") ||
        gmlDescription ||
        "",
      validFromMa,
      validToMa,
      polygons,
      sourceIndex,
    });
  }

  return {
    features,
    polygonCount,
    unsupportedGeometryCount,
    warnings,
  };
}
