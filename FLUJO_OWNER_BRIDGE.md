# FLUJO owner bridge: next offline slice

This contains a tested offline component and the remaining integration plan. The local model-step journal has a qualified logical claim witness; it does not authorize a physical model request. The separate owner-wire fixture connects FLUJO's real SDK request seam to an independently fixed request and stops at PHYSICAL_SEND_HOLD. Production original authority, a real Flow graph and a CommunityAI receiver remain separate qualifications.

## Implemented offline component

`src/fixture-owner-wire.mjs` owns a separate SQLite fixture with explicit trusted-fixture-only mode. It commits an immutable parent-start witness before entering the fixture callback. Entry failure preserves unknown; duplicate/restarted parents suppress entry, and a zero-child interrupted parent cannot obtain fresh child authority. A fresh handle lasts only while its entry callback is active. The fixture cannot authorize native POST and has no credential resolver or physical sender.

The owner compares the closed SDK projection with the pre-existing literal commitment: model and credential-binding identity, URL/method, all ten ordered non-auth headers, routing digests, and exact UTF-8 body bytes. One transaction records the logical child witness as unknown, then PHYSICAL_SEND_HOLD escapes. Existing claims remain observation-only after OFF, expiry or restart. This fixture is not the existing original-model-step journal, paid ledger or a production authentication boundary; its host supplies the database path, clock and trusted fixture constants.

Twenty Node regressions passed for entry ordering, interruption, duplicate/restart observation, retained handle refusal, exact projection changes, OFF/expiry/generation failure, abort/native refusal, malformed arrays and aborted signals. The two-connection test is sequential; it is not a concurrent writer qualification.

The isolated real-SDK exercise passed one case through FLUJO's actual OpenAiAdapter, installed OpenAI SDK 7.3.0, guarded final fetch and execution-extension dispatch. It produced one owner dispatch, unknown parent/child and zero attempts at all ten guarded transports. Expected body and headers come from independent fixture constants and pinned source, not from the observed request. No real credential was configured. Duplicate child use and restarted parent observation did not dispatch again. The SDK default client timeout does not add a request timeout header; the first incorrect header commitment remains a retained failed run with zero claims.

The harness uses a sanitized environment and dedicated Next SWC/Jest configuration without application setup or .env loading. Its source-specific Windows/Node 24.19.0 pins are an offline qualification harness, not a portable worker package or complete dependency-closure proof. Its fixture/config live in scripts/fixtures, outside Node's default test discovery. Invoke the pinned Node executable with `scripts/flujo-owner-wire-fixture.mjs`. The current isolated harness passed at `.factory/flujo-owner-wire-sdk-run-38afccfd-ea42-4ccc-873e-340cc7ae73ab`; Root consumed 58 inputs and independent review consumed 59, including the post-close SQLite bytes. The earlier accepted receipt `71f070f3-7c7f-477e-892e-08c9b7457eb0` remains historical evidence, with the three earlier harness sources archived byte-for-byte.

## Receiver probe and incompatible stream option

The selected admission-enabled CommunityAI `server.py` snapshot (SHA-256 `665bcde7f4fae8462d049cf8c3cb54232ad0cc1d474b6644d42f89291077674b`) forbids unknown fields and has no stream_options. The real SDK fixture body's `stream_options.include_usage=true` therefore fails its extracted Pydantic schema. This is specific to that pinned ingress. The newer bare server generation is reported to ignore that field and lacks this Factory admission integration; it is not a substitute receiver qualification.

The R3 Python probe executed only the exact three request-schema classes and two digest definitions extracted from pinned source. It confirmed the original SDK refusal and, separately, normalization of an explicitly fixed transport fixture without the unsupported option. That positive probe includes default n=1 and Python float spelling temperature=1.0; its normalized SHA-256 is `67cb21366cfedc5f4738d384b90be84780205d89caf20cdee592ca8a9f728850`. It does not alter any actual SDK request or authorize a production transform. No ASGI route, original admission, model selection, peer or provider ran.

Run `scripts/communityai-receiver-fixture-r3.py` with the pinned bundled Python and `-I -S -B` only within the documented local harness. Earlier R1/R2 captures remain failed before schema execution; their source files retain their captured bytes. R3 retains complete Python path/descriptor identities separately because their Windows ctime and executable mode projections differ; Root independently checked all fourteen inputs with Node's strict full ten-field path/descriptor identities before and after, and independent review revalidated all eighteen script/input/receipt files. The accepted receiver receipt is `.factory/communityai-receiver-run-45cbe764-494e-43a1-9a59-03990791f41e`.

An explicit CommunityAI transport profile must preserve or deliberately bind the SDK options and exact receiver-normalized bytes. A source candidate elsewhere is not adoption. The sender, original issuer/registry, complete Flow call plan, receiver runtime and every distributed inference descendant remain open work.

## Contract and ownership

Use a distinct `factory-flujo-openai-sdk-wire-v1` contract. The existing CommunityAI Python JSON renderer, manifest model identity and coordinator recipient cannot be relabeled as OpenAI. A final SDK fetch projection also does not describe every HTTP/TLS byte emitted later by a sender.

The owner's authenticated registry supplies the trusted original context and opaque step handle. Caller request metadata cannot create either. The issuer independently commits the expected request from complete original context before seeing the observed request. Signing the observed request would provide no independent comparison.

| Binding | Committed content |
| --- | --- |
| Original authority | Complete native specification, task/spec digest, parent/Flow/graph identity, principal and role |
| Call identity | Fixed node/ordinal, request ID, nonce and manifest digest |
| Model and recipient | Exact technical model, provider, endpoint, routing/account headers and receiver identity |
| Credential ownership | Owner ID, credential ID and immutable credential generation; secret stays with the owner |
| SDK projection | Renderer version, pinned SDK/build/runtime, POST URL, closed non-auth header projection and exact UTF-8 body bytes with lengths and hashes |
| Admission | Original lease/token digest/expiry plus the correctly owned provider reservation and physical ceiling |

The current issuance seam receives the model without a qualified call-site selector. The first exercise must have exactly one independently eligible fixed slot. Ambiguous selection refuses. Multiple slots require an authenticated call-site selector. A fixed plan declared by a caller does not prove a concrete Flow has a static call count.

## Streaming exercise

The first owned fixture should use the real FLUJO streaming request construction and its guarded final-fetch seam. Delta handling selects streaming; the SDK body includes `stream: true`, usage options and potentially prompt-cache fields. Exact model, prompt, cache policy, headers and endpoint must be independently derivable from the trusted fixture context and pinned renderer. Runtime-selected fields that cannot be independently committed remain a refusal.

The fixture exercises this order:

1. Copy and validate the actual final SDK URL, non-auth headers and body against the independently committed slot.
2. Authenticate the original capability and claim its logical slot once. An existing claim enters observation/recovery.
3. Throw `PHYSICAL_SEND_HOLD` before any real credential access or socket initiation.
4. Preserve the claimed child as unresolved/unknown. It must never become `not_applied` or be automatically resent.

Parent-running state is explicitly synthetic in this exercise: native execution of the flagged task remains held. The original journal's parent admission leaves it accepted, while registration and claim require it running; existing native start APIs refuse flagged tasks. Its existing journal fixtures use owned fixture SQL to establish running. The separate owner-wire fixture above provides its own mode and SQLite start witness; it does not close the supported production broker parent-transition gap or integrate that original journal. No concrete one-call Flow is currently qualified. Disable SDK retries, wrapper retries, fallback, cache replay and request regeneration; an extra or ambiguous call refuses.

Useful regressions are mismatched stream/cache/body/URL/account/model projections; unavailable or ambiguous slots; credential-generation mismatch without secret access; duplicate/restarted claims; and OFF after claim without a physical send. Passing this exercise establishes request comparison and logical CAS only.

## Parent start before Flow entry

Preserve the production flow_call invariant: commit running before the admitted native POST, then apply the original lease/OFF/paid dispatch fence. A first model-step claim occurs inside an already-entered Flow and may follow resource, MCP, state or other preparation. Moving parent accepted-to-running into that child claim can leave an interrupted, already-executed parent recorded as accepted and incorrectly abortable. A private SQL start gate does not correct the timing.

For a future full-Flow offline exercise, a trusted startFixtureFlow() harness seam should record an immutable fixture-start witness before internal runFlow entry. The tested reduced fixture above commits before its adapter-entry callback; internal runFlow has not been exercised. Its distinct mode cannot authorize production native POST and is not an existing original journal API. Retain the fresh-child requirement for an already-running authenticated parent. A combined parent/child start is appropriate only for a reduced model-only fixture with independently demonstrated absence of earlier work.

Regressions must cover interruption before the first model, a pre-model synthetic effect with a started witness, duplicate/restart without Flow re-entry, unauthorized parent starts, first-child failure preserving parent start, abort refusal after entry even with zero claimed children, final admission failure preserving the start record and fixture mode retaining production HOLD. Interrupted parents remain running/unknown and observation-only; explicit qualified resume semantics remain open. The reported newer FLUJO Process guard does not establish all pre-model work as pure and remains foreign source evidence.

## Physical sender still required

The eventual owner gate must recheck OFF, lease, credential generation and the correct provider budget, durably consume the physical attempt and initiate the pinned send. That gate must serialize ordinary OFF and budget mutations through the same authority. A remote approval followed by a later worker POST does not create a final OFF fence.

Retain exact response status, headers and complete body or stream evidence. A crash or ambiguous acknowledgement preserves unknown and prevents automatic resend. Control, spending and a network operation are not a distributed atomic transaction; logical claim success does not prove affordable inference or provider absence.

CommunityAI needs its own receiver and every Hivemind text, tensor, forward/backward, push and retry descendant needs exact request-scoped authority. A gateway text handoff hook alone does not cover all descendants or establish physical cancellation. Any transport fork/extension needs source review; editing installed site-packages is not the integration plan.

## Delivery and network boundary

This slice creates no worker, cloud allocation, live migration or provider request. Existing cells may continue previously allocated local work while a coordinator is unreachable. New external effects still require their original admission authority. Peer observations can inform recovery; they do not authorize taking over a lease, spending another cell's allocation or promoting a result. Shared promotion waits for its governing authority.

Measure factory improvement as elapsed time from an accepted requirement to an independently accepted result, including review, rework and recovery. The 129 passing local journal cases improve a correctness boundary; they do not establish a development-speed improvement.

The pilot's total cap remains $100. All $100 is held in unresolved reservations, $0 is unallocated, final spend is unknown and cloud admission remains paused.
