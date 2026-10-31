# gbrain's QM memory provider contract

`qm-memory-provider-v1.json` is gbrain's machine-readable contract for the two tools QM's [gbrain recipe](../../../docs/memory-providers.md#gbrain) calls, `memory_recall` and `memory_write`: their input schemas, the `x-qm-actor` rules, the answer shapes and every refusal code with its class. [`test/gbrain-memory-provider.test.ts`](../../gbrain-memory-provider.test.ts) serves these tools from a fake gbrain and checks that the documented recipe sends requests the schemas accept and records each answer and refusal as the contract classes it.

| Field   | Value                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Source  | `docs/contracts/qm-memory-provider/v1.json` in [garrytan/gbrain](https://github.com/garrytan/gbrain) |
| Status  | **Candidate**: branch `capy/gbra218-qm-memory-tools` at `bc27793b`, not a tagged release             |
| SHA-256 | `e467f2286d29eb8785920aeaf5bd44b1a2159707608f04ed48a7e2c3d1ca20df`                                   |

The file is gbrain's bytes, unchanged, so `sha256sum qm-memory-provider-v1.json` proves which release it came from. Prettier skips it for that reason.

## Updating to a new gbrain release

1. Copy `docs/contracts/qm-memory-provider/v1.json` from the release tag over `qm-memory-provider-v1.json` without reformatting it.
2. Update the table above with the tag, its commit and the new `sha256sum`, and the gbrain line under "Pinned versions" in [docs/memory-providers.md](../../../docs/memory-providers.md#gbrain).
3. Run `node --test test/gbrain-memory-provider.test.ts`. A failure names the request field or outcome that no longer matches; fix QM or the recipe, never the fixture.
4. Repeat the recipe's [Verify](../../../docs/memory-providers.md#verify) steps against a brain running that release.

A new contract version (`v2.json`) is a new fixture beside this one, not an edit to it.
