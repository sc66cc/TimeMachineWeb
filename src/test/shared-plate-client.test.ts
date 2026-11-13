import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { UserPlateModelInvoker } from "@timemachine/generated-api";

import {
  SharedPlateModelClient,
  SharedPlateRpcError,
  encodeDisplayRequest,
  encodeGetDetailRequest,
} from "../plate-model/shared-plate-client";

/**
 * The `.bin` fixtures under `src/test/fixtures` were produced by the real C#
 * `ViSerializer` from the running server build (see `fixtures/README.md`), so
 * decoding them proves the layout independently of the TypeScript encoder.
 *
 * The two request literals below are byte streams the running server accepted
 * for the same calls. They were captured on 2026-11-07 while verifying this
 * client against the 2026-09-19 server build; they are not Unity captures.
 */

function fixture(name: string): ArrayBuffer {
  const buffer = readFileSync(resolve("src/test/fixtures", name));
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/** `display` request body accepted by the 2026-09-19 server (2026-11-07). */
const REAL_DISPLAY_REQUEST = [
  0x00, // Condition.Name = "" (packed length 0)
  0x06, 0x00, 0x00, 0x00, // Condition.AccessRange mask = 6
  0x01, 0x00, 0x00, 0x00, // Page.Index = 1
  0x64, 0x00, 0x00, 0x00, // Page.Size = 100
];

/** `get_detail` request body for ID 1, accepted by the same server run. */
const REAL_GET_DETAIL_REQUEST = [1, 0, 0, 0, 0, 0, 0, 0];

/** Error frame returned by the same server run: Code 841, no Data. */
const REAL_ERROR_FRAME = [
  0x49, 0x03, 0x00, 0x00, // Code = 841
  0x0c, // Message packed length 12
  ...Array.from("DataNotExist").flatMap((character) => [
    character.charCodeAt(0) & 0xff,
    character.charCodeAt(0) >>> 8,
  ]),
];

/**
 * The generated `BaseEntityRO.UpdateTime? = null` carries no type annotation, so
 * TypeScript widens it to `null | undefined`; read the decoded `DateTime?`
 * through this widened view.
 */
function updateTimeOf(
  model: { UpdateTime?: Date | null } | undefined,
): Date | null | undefined {
  return model?.UpdateTime;
}

function createClient(fetchImplementation: typeof globalThis.fetch) {
  return new SharedPlateModelClient({
    baseUrl: "https://api.example.test/",
    fetch: fetchImplementation,
    getAccessToken: () => "token-value",
    getLanguage: () => 2,
    getTimeZone: () => "8",
  });
}

describe("SharedPlateModelClient request encoding", () => {
  it("reproduces the display byte stream the server accepts", () => {
    expect([
      ...encodeDisplayRequest({
        accessRangeMask: 6,
        pageIndex: 1,
        pageSize: 100,
      }),
    ]).toEqual(REAL_DISPLAY_REQUEST);
  });

  it("reproduces the get_detail byte stream the server accepts", () => {
    expect([...encodeGetDetailRequest(1)]).toEqual(REAL_GET_DETAIL_REQUEST);
  });

  it("encodes a non-empty display name as a packed UTF-16 string", () => {
    const bytes = encodeDisplayRequest({ name: "模型" });
    expect([...bytes]).toEqual([
      0x02, 0x21, 0x6a, 0x8b, 0x57, // Name = "模型"
      0x00, 0x00, 0x00, 0x00, // AccessRange mask = 0
      0x01, 0x00, 0x00, 0x00, // Page.Index = 1
      0x64, 0x00, 0x00, 0x00, // Page.Size = 100
    ]);
  });

  it("enforces the PageIndex contract", () => {
    expect(() => encodeDisplayRequest({ pageIndex: 0 })).toThrow(
      /Page.Index must be an integer in \[1, 2147483647\]/,
    );
    expect(() => encodeDisplayRequest({ pageSize: 101 })).toThrow(
      /Page.Size must be an integer in \[1, 100\]/,
    );
    expect(() => encodeGetDetailRequest(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      /safe integer/,
    );
  });

  it("keeps the Page.Index boundaries inside the Int32 range", () => {
    // 2147483647 is the largest value writeInt32 can encode losslessly.
    // Layout: nameLen(1) + mask(4) + index(4) + size(4).
    expect([
      ...encodeDisplayRequest({ pageIndex: 2147483647 }).slice(5, 9),
    ]).toEqual([0xff, 0xff, 0xff, 0x7f]);
    // 2147483648 would silently become -2147483648.
    expect(() => encodeDisplayRequest({ pageIndex: 2147483648 })).toThrow(
      /Page.Index must be an integer in \[1, 2147483647\]/,
    );
    // 4294967297 would silently wrap to 1.
    expect(() => encodeDisplayRequest({ pageIndex: 4294967297 })).toThrow(
      /Page.Index must be an integer in \[1, 2147483647\]/,
    );
  });
});

describe("SharedPlateModelClient transport", () => {
  it("posts multipart FormData with a _stream blob and RPC headers", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(fixture("catalog-with-one.bin"), {
          headers: { "content-type": "application/octet-stream" },
          status: 200,
        }),
    );
    const client = createClient(fetchMock);

    await client.display({ accessRangeMask: 6, pageIndex: 1, pageSize: 100 });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.example.test/d_planet/user_plate_model/display",
    );
    expect(init?.method).toBe("POST");

    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    const part = (body as FormData).get("_stream");
    expect(part).toBeInstanceOf(Blob);
    expect((part as Blob).type).toBe("application/octet-stream");
    expect((part as File).name).toBe("_stream");
    expect(new Uint8Array(await (part as Blob).arrayBuffer())).toEqual(
      new Uint8Array(REAL_DISPLAY_REQUEST),
    );

    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("token-value");
    expect(headers.get("Accept")).toBe("application/octet-stream");
    expect(JSON.parse(headers.get("Custom-Header") ?? "{}")).toEqual({
      TimeZone: "8",
      Language: "2",
    });
    // The multipart boundary must be left to the platform.
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("reuses the generated route constants instead of hand-written paths", () => {
    expect(UserPlateModelInvoker.URL).toBe("d_planet/user_plate_model");
    expect(UserPlateModelInvoker.URL_Display).toBe("display");
    expect(UserPlateModelInvoker.URL_DisplayMine).toBe("display_mine");
    expect(UserPlateModelInvoker.URL_GetDetail).toBe("get_detail");
  });

  it("sends an empty _stream for display_mine", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array([0xc8, 0, 0, 0, 0x00, 0x00]), {
          status: 200,
        }),
    );
    const client = createClient(fetchMock);

    await client.displayMine();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.example.test/d_planet/user_plate_model/display_mine",
    );
    const part = (init?.body as FormData).get("_stream") as Blob;
    expect(part.size).toBe(0);
  });

  it("reads the public catalog anonymously without an Authorization header", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        // The real 10-byte empty public catalog: Code 200, empty Message,
        // Total 0, packed list count 0.
        new Response(
          new Uint8Array([0xc8, 0, 0, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
          { status: 200 },
        ),
    );
    const client = new SharedPlateModelClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    const page = await client.display({ accessRangeMask: 6 });

    expect(page.Total).toBe(0);
    expect(page.List).toEqual([]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
    // The platform still sends its TimeZone/Language conventions.
    expect(Object.keys(JSON.parse(headers.get("Custom-Header") ?? "{}"))).toEqual(
      ["TimeZone", "Language"],
    );
  });

  it("rejects an anonymous private-model read with the server's error code", async () => {
    const client = new SharedPlateModelClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array(REAL_ERROR_FRAME), { status: 200 }),
    });

    await expect(client.getDetail(1)).rejects.toMatchObject({
      code: 841,
      message: "DataNotExist",
    });
  });

  it("raises an explicit error for a non-2xx response", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("nope", { status: 500 }));
    await expect(client.display()).rejects.toThrow(/returned HTTP 500/);
  });
});

describe("SharedPlateModelClient frame decoding", () => {
  it("decodes a real C# PageRO<PlateModelSimpleRO> catalog frame", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(fixture("catalog-with-one.bin"), { status: 200 }),
    );
    const page = await client.display();

    expect(page.Total).toBe(1);
    expect(page.List).toHaveLength(1);
    const [model] = page.List;
    expect(model?.ID.Value).toBe(42);
    expect(model?.State.Value).toBe(0);
    expect(model?.Name).toBe("Synthetic 模型");
    expect(model?.Description).toBe(
      "Independent C# wire fixture, no database access",
    );
    expect(model?.CreateTime.getTime()).toBe(Date.UTC(2020, 0, 2, 3, 4, 5, 0));
    expect(updateTimeOf(model ?? undefined)?.getTime()).toBe(
      Date.UTC(2021, 1, 3, 4, 5, 6, 0),
    );
    expect(model?.Author).toBe("fixture");
    expect(model?.Reference).toBe("");
    expect(model?.AgeStart).toBe(100);
    expect(model?.AgeEnd).toBe(0);
    expect(model?.AuthorPhoto).toEqual({
      Extention: "",
      MD5: "",
      Name: "",
      Path: "",
    });
    expect(model?.Creator.Value).toBe(7);
    expect(model?.AccessRange.Value).toBe(0);
    expect(model?.RecommandList).toEqual([]);
  });

  it("decodes a real C# PlateModelRO detail frame with a null UpdateTime", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(fixture("detail-null-update.bin"), { status: 200 }),
    );
    const model = await client.getDetail(42);

    expect(model.ID.Value).toBe(42);
    expect(model.Name).toBe("Synthetic 模型");
    expect(model.CreateTime.getTime()).toBe(Date.UTC(2020, 0, 2, 3, 4, 5, 0));
    // ViDateTimePtrSerializer writes an empty string, not a null flag.
    expect(updateTimeOf(model)).toBeNull();
    expect(model.Creator.Value).toBe(7);
    expect(model.Content.GeoFileName).toBe("fixture.gpml");
    expect(model.Content.RotationFileName).toBe("fixture.rot");

    expect(model.Content.GeoList).toHaveLength(1);
    const [geo] = model.Content.GeoList;
    expect(geo?.FeatureType).toBe("");
    expect(geo?.FeatureName).toBe("triangle");
    expect(geo?.PlateID).toBe(101);
    expect(geo?.FeatureID).toBe("fixture-feature");
    expect(geo?.RevisionID).toBe("");
    expect(geo?.ValidTime.Begin).toBe(100);
    expect(geo?.ValidTime.End).toBe(0);
    expect(geo?.Position).toEqual([]);
    expect(geo?.Line).toEqual([]);
    expect(geo?.Attribute).toEqual([]);
    expect(geo?.Polygon).toHaveLength(1);
    expect(
      geo?.Polygon[0]?.PosList.map((point) => [point.Longitude, point.Latitude]),
    ).toEqual([
      [0, 0],
      [10, 0],
      [0, 10],
    ]);
    expect(geo?.Polygon[0]?.Mesh.IndexList).toEqual([]);
    expect(geo?.Polygon[0]?.Mesh.PointList).toEqual([]);

    expect(model.Content.RotationList).toHaveLength(2);
    expect(model.Content.RotationList[0]).toMatchObject({
      Age: 0,
      Comment: "",
      ID: 101,
      ParentID: 0,
      PoleAngle: 0,
      PoleLatitude: 0,
      PoleLongitude: 0,
    });
    expect(model.Content.RotationList[1]).toMatchObject({
      Age: 100,
      Comment: "fixture",
      ID: 101,
      ParentID: 0,
      PoleAngle: 10,
      PoleLatitude: 90,
      PoleLongitude: 0,
    });

    expect(model.AccessRange.Value).toBe(0);
    expect(model.RecommandList).toEqual([]);
  });

  it("decodes the non-null UpdateTime branch of the same real frame", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(fixture("detail-with-update.bin"), { status: 200 }),
    );
    const model = await client.getDetail(42);

    expect(updateTimeOf(model)?.getTime()).toBe(Date.UTC(2021, 1, 3, 4, 5, 6, 0));
    expect(model.Content.GeoList).toHaveLength(1);
    expect(model.Content.RotationList).toHaveLength(2);
  });

  it("decodes every populated nested collection of a real C# detail frame", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(fixture("detail-all-nested.bin"), { status: 200 }),
    );
    const model = await client.getDetail(42);

    const [geo] = model.Content.GeoList;
    expect(geo?.Position.map((point) => [point.Longitude, point.Latitude]))
      .toEqual([[12.5, -4.25]]);
    expect(
      geo?.Line.map((line) =>
        line.PosList.map((point) => [point.Longitude, point.Latitude]),
      ),
    ).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
    ]);
    expect(geo?.Attribute).toEqual([
      { First: "fixture-key", Second: "合成属性" },
    ]);

    const [polygon] = geo?.Polygon ?? [];
    expect(polygon?.Mesh.IndexList).toEqual([0, 1, 2]);
    expect(
      polygon?.Mesh.PointList.map((point) => [point.X, point.Y, point.Z]),
    ).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);

    // RecommandList is a packed Int64 list, not a fixed-width one.
    expect(model.RecommandList.map((key) => key.Value)).toEqual([99]);
    expect(updateTimeOf(model)?.getTime()).toBe(
      Date.UTC(2021, 1, 3, 4, 5, 6, 0),
    );
  });

  it("decodes the DisplayMine List shape from a real C# frame", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(fixture("mine-with-one.bin"), { status: 200 }),
    );
    const models = await client.displayMine();

    expect(models).toHaveLength(1);
    expect(models[0]?.ID.Value).toBe(42);
    expect(models[0]?.Name).toBe("Synthetic 模型");
    expect(models[0]?.Creator.Value).toBe(7);
    expect(models[0]?.RecommandList.map((key) => key.Value)).toEqual([99]);
  });

  it("decodes an empty DisplayMine list", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array([0xc8, 0, 0, 0, 0x00, 0x00]), {
          status: 200,
        }),
    );
    await expect(client.displayMine()).resolves.toEqual([]);
  });

  it("throws a typed RPC error for the observed non-success frame", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array(REAL_ERROR_FRAME), { status: 200 }),
    );

    await expect(client.getDetail(1)).rejects.toThrow(SharedPlateRpcError);
    await expect(client.getDetail(1)).rejects.toMatchObject({
      code: 841,
      message: "DataNotExist",
    });
  });

  it("rejects a success frame that carries no Data", async () => {
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array([0xc8, 0, 0, 0, 0x00]), { status: 200 }),
    );
    await expect(client.display()).rejects.toThrow(
      /success frame carries no Data/,
    );
  });

  it("rejects trailing bytes so layout drift is not silently ignored", async () => {
    const frame = fixture("catalog-with-one.bin");
    const padded = new Uint8Array(frame.byteLength + 1);
    padded.set(new Uint8Array(frame));
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(padded, { status: 200 }));

    await expect(client.display()).rejects.toThrow(/trailing byte/);
  });

  it("rejects a frame truncated inside the payload", async () => {
    const frame = new Uint8Array(fixture("detail-null-update.bin"));
    const client = createClient(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(frame.slice(0, frame.length - 8), { status: 200 }),
    );

    await expect(client.getDetail(42)).rejects.toThrow(/truncated/);
  });
});
