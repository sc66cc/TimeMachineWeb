# ByteStream wire fixtures

These `.bin` files are **synthetic** frames produced by the real C#
`ViSerializer` shipped in the running TimeMachine server build (contract
2026-09-19), not by the TypeScript encoder in this repository.

- Generator: `wire-fixture-generator.cs` (copied verbatim from
  `/tmp/timemachineweb-test/wire-fixture/Program.cs`). It builds
  `PlateModelRO` / `PageRO<PlateModelSimpleRO>` / `List<PlateModelSimpleRO>`
  DTOs in memory, appends `Int32 Code = 200`, the packed empty `Message`, and
  then calls `ViSerializerInstance.Append(stream, dto)`.
- The project referenced the already-running server DLLs and performed **no
  database access**; the build reported 0 warnings.
- Model ID 42, name `Synthetic 模型`, `Creator` 7, one triangle plate 101
  (100..0 Ma), two rotations at 0/100 Ma, first page `Total = 1`.

| file | bytes | covers |
| --- | --- | --- |
| `catalog-with-one.bin` | 281 | `PageRO<PlateModelSimpleRO>` — the **Display** payload only |
| `detail-null-update.bin` | 435 | `PlateModelRO` with `UpdateTime == null` |
| `detail-with-update.bin` | 483 | `PlateModelRO` with a real `UpdateTime` |
| `detail-all-nested.bin` | 596 | `PlateModelRO` with every nested collection populated |
| `mine-with-one.bin` | 285 | `List<PlateModelSimpleRO>` — the **DisplayMine** shape |

`DisplayMine` returns a bare `List<PlateModelSimpleRO>`, not a `PageRO`, which
is why `mine-with-one.bin` is the only fixture that pins that shape down.

`detail-with-update.bin` and `detail-null-update.bin` differ by exactly 48
bytes, which is the payload of the 24-character date string written by
`ViDateTimePtrSerializer`. Together they pin down both branches of the
nullable `DateTime` field without any TypeScript encoder being involved.

`detail-all-nested.bin` is the only fixture with non-empty `Position`, `Line`,
`Attribute`, `Polygon.Mesh` and `RecommandList`, so it is what locks the
decoder's handling of those collections. It is still a synthetic DTO: it is
**not** an end-to-end capture of a real signed-in user's private model.

No real private plate-model content, user data, or credentials are contained
in these files.
