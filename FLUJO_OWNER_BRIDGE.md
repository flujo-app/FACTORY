# FLUJO owner bridge: next offline slice

This is an implementation plan. The local model-step journal has a qualified logical claim witness; it does not authorize a physical model request. The first bridge should connect FLUJO's existing owner request seam to a distinct exact SDK request contract and stop before credentials or a socket.

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

Parent-running state is explicitly synthetic in this exercise: native execution of the flagged task remains held. The journal's parent admission leaves it accepted, while registration and claim require it running; existing native start APIs refuse flagged tasks. Current journal fixtures use owned fixture SQL to establish running. A supported broker parent transition is a separate design and qualification gap, and an offline harness must identify this setup explicitly. No concrete one-call Flow is currently qualified. Disable SDK retries, wrapper retries, fallback, cache replay and request regeneration; an extra or ambiguous call refuses.

Useful regressions are mismatched stream/cache/body/URL/account/model projections; unavailable or ambiguous slots; credential-generation mismatch without secret access; duplicate/restarted claims; and OFF after claim without a physical send. Passing this exercise establishes request comparison and logical CAS only.

## Parent start before Flow entry

Preserve the production flow_call invariant: commit running before the admitted native POST, then apply the original lease/OFF/paid dispatch fence. A first model-step claim occurs inside an already-entered Flow and may follow resource, MCP, state or other preparation. Moving parent accepted-to-running into that child claim can leave an interrupted, already-executed parent recorded as accepted and incorrectly abortable. A private SQL start gate does not correct the timing.

For the offline exercise, a trusted startFixtureFlow() harness seam should record an immutable fixture-start witness before internal runFlow entry. Its distinct parent kind or execution mode must be incapable of authorizing production native POST; this needs an explicit fixture contract/harness and is not an existing journal API. Retain the fresh-child requirement for an already-running authenticated parent. A combined parent/child start is appropriate only for a reduced model-only fixture with independently demonstrated absence of earlier work.

Regressions must cover interruption before the first model, a pre-model synthetic effect with a started witness, duplicate/restart without Flow re-entry, unauthorized parent starts, first-child failure preserving parent start, abort refusal after entry even with zero claimed children, final admission failure preserving the start record and fixture mode retaining production HOLD. Interrupted parents remain running/unknown and observation-only; explicit qualified resume semantics remain open. The reported newer FLUJO Process guard does not establish all pre-model work as pure and remains foreign source evidence.

## Physical sender still required

The eventual owner gate must recheck OFF, lease, credential generation and the correct provider budget, durably consume the physical attempt and initiate the pinned send. That gate must serialize ordinary OFF and budget mutations through the same authority. A remote approval followed by a later worker POST does not create a final OFF fence.

Retain exact response status, headers and complete body or stream evidence. A crash or ambiguous acknowledgement preserves unknown and prevents automatic resend. Control, spending and a network operation are not a distributed atomic transaction; logical claim success does not prove affordable inference or provider absence.

CommunityAI needs its own receiver and every Hivemind text, tensor, forward/backward, push and retry descendant needs exact request-scoped authority. A gateway text handoff hook alone does not cover all descendants or establish physical cancellation. Any transport fork/extension needs source review; editing installed site-packages is not the integration plan.

## Delivery and network boundary

This slice creates no worker, cloud allocation, live migration or provider request. Existing cells may continue previously allocated local work while a coordinator is unreachable. New external effects still require their original admission authority. Peer observations can inform recovery; they do not authorize taking over a lease, spending another cell's allocation or promoting a result. Shared promotion waits for its governing authority.

Measure factory improvement as elapsed time from an accepted requirement to an independently accepted result, including review, rework and recovery. The 129 passing local journal cases improve a correctness boundary; they do not establish a development-speed improvement.

The pilot's total cap remains $100. All $100 is held in unresolved reservations, $0 is unallocated, final spend is unknown and cloud admission remains paused.
