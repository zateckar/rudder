# Application lifecycle verification

The eight lifecycle failures identified by the original models now have implementation fixes and machine-checked safety properties for their repaired policies. Original counterexamples remain as historical regression witnesses: they describe the previous transitions, not the repaired implementation.

Verified with Lean **4.34.1** on 2026-09-30:

```powershell
bun run verify:lifecycle
```

The command checks [Lifecycle.lean](Lifecycle.lean), rejects proof placeholders and warnings, and audits every theorem's dependencies. All **52 theorem declarations** pass: 27 original properties/witnesses and 25 properties in `Rudder.Repaired`. It uses an existing pinned Lean installation, optionally selected with `LEAN_BIN`; it does not install software or change global settings. [lean-toolchain](lean-toolchain) pins the version. No Mathlib or downloaded libraries are required.

## State inventory

Application state is a product of independent dimensions:

| Dimension | Values and meaning |
| --- | --- |
| Application intent | `applications.desiredStatus`: running or stopped |
| Container override | `containers.desiredStatus`: null inherits application intent; explicit running/stopped takes precedence |
| Actual runtime | Podman absent, created, running, exited, paused, restarting, removing, unknown |
| Recorded runtime | Cached `containers.status`; `missing` represents absence and can lag actual runtime |
| Health/specification | Unhealthy or otherwise; stale specification or otherwise |
| Generation role | Pending candidate, active serving generation, draining superseded/retained generation |
| Deployment history | Pending, running, succeeded, failed, rolled back; durable `cutoverAt` distinguishes committed cutover from build interruption |
| Worker ownership | Process-local lock until callback finishes; TTL is diagnostic only |
| Observation freshness | Monotone worker epoch advances on lock acquisition/release, even if Podman ID is unchanged |
| Routing | Desired content, one worker fetch/install pipeline, installed content, full hash ACK; routing revision rejects obsolete snapshot ACKs |
| Retention | Dedicated `containers.retainedAt`; observation does not extend retention |
| Worker boot intent | Durable marker by full Podman ID: running/stopped; managed containers without a running marker are excluded from replay |
| Reconciliation result | Clean, missing, stale, unhealthy, unexpected running, orphan, foreign, retained, unreaped; parse error separately |

An active generation can be intentionally stopped; a draining generation can run during grace. Running against stopped intent is a failed stop or unexpected restart, never permission to start it.

## Repaired transitions

| Trigger | Behavior and serialization |
| --- | --- |
| App Stop/Start/Restart | Save app intent, clear active overrides, persist worker boot marker before remote lifecycle call; hold worker lock throughout |
| Container Stop/Start/Restart | Save selected override and marker; preserve siblings; re-read identity under worker lock; Start/Restart require an active generation (rollback activates retained versions) |
| Resource recreation | Preserve fresh intent; replace Podman ID; start only desired-running replacement; marker follows new identity |
| Blue/green deploy | Build pending candidate; suppress previous boot replay; transactionally switch roles and persist cutover phase/intent; require installed routing ACK before destroying old backends |
| Failed cutover ACK | Atomically revert roles; retain candidate until exclusion ACK and grace; lack of ACK never proves candidate was not installed |
| Legacy deploy | Remove previous generation, create active rows; preserve usable partial deploys on failure; capture external IDs immediately before further awaits/insertion |
| Corrective deploy | Reject stopped app or any stopped active override using current intent under lock |
| Fast rollback | Start/verify retained generation; atomically switch/revert roles; same lock as cleanup; ACK before destructive effects |
| Metrics | Current epoch and matching database/Podman IDs required; synchronous status transaction preserves retention and invalidates routing ACK when status changes |
| Reconciliation | Reject stale supplied observation or assembled report; validate immediately before synchronous publication; on-demand conflict returns 409 |
| Cleanup | Acquire worker lock, then read eligible draining/abandoned pending rows and require current routing exclusion ACK; deploy uses helper inside its own lock |
| App deletion | Re-read app and targets inside shared worker lock; cannot overlap deploy/create/rollback |
| Control-plane restart | Preserve atomic roles and intent; report pre/post-cutover interruption accurately; retry marker sync and cleanup |
| Worker boot | Require durable running marker for managed/adopted workload and applicable boot restart policy; exclude pending/retained generations |

Source: [locks.ts](../src/lib/server/locks.ts), [metrics.ts](../src/lib/server/metrics.ts), [reconcile.ts](../src/lib/server/reconcile.ts), [deploy.ts](../src/lib/server/deploy.ts), [lifecycle-cutover.ts](../src/lib/server/lifecycle-cutover.ts), [recover.ts](../src/lib/server/recover.ts), [routing-convergence.ts](../src/lib/server/routing-convergence.ts), [runtime-policy.ts](../src/lib/server/runtime-policy.ts), and [worker boot script](../src/lib/server/provisioning/shell/scripts/rudder-container-boot.sh).

## Checked repaired properties

These theorem names are in `Rudder.Repaired`. Trace proofs use induction over arbitrary finite traces, not bounded simulation.

| Failure family | Checked property | Theorems |
| --- | --- | --- |
| 1. TTL steals ownership | Live callbacks cannot overlap, including arbitrary timeout events | `lock_step_safe`, `arbitrary_lock_trace_safe`, `callback_exclusion_including_timeouts` |
| 2. Sweep removes rollback target | Reap preserves active targets, cannot cross rollback ownership, and requires exclusion ACK | `reap_preserves_active`, `reap_cannot_cross_rollback`, `reap_requires_routing_exclusion` |
| 3. Delete races create | Delete cannot cross deploy ownership; failed insert retains external identity for compensation | `delete_cannot_cross_live_deploy`, `failed_insert_retains_external_identity` |
| 4. Stale observation | Changed identity/epoch or active mutation rejects write; same-ID mutation rejects old status | `changed_identity_rejects_observation`, `changed_epoch_rejects_observation`, `active_mutation_rejects_observation`, `same_identity_mutation_rejects_old_status` |
| 5. Non-atomic cutover | Commit/revert/recovery preserve exclusive roles for arbitrary traces; committed recovery does not claim previous generation kept serving | `atomic_cutover_step_preserves_exclusive_roles`, `arbitrary_cutover_trace_exclusive`, `recovery_does_not_claim_previous_after_commit` |
| 6. False routing ACK | Current ACK implies installed content; fetch alone leaves ACK unchanged; failed exclusion ACK preserves candidate | `routing_step_preserves_acknowledgement`, `arbitrary_routing_trace_acknowledges_installed_content`, `response_fetch_is_not_install_ack`, `failed_ack_preserves_candidate` |
| 7. Stale reconciliation | Version monotonicity; unchanged epoch across arbitrary trace implies unchanged state; stale report publishes nothing | `version_trace_epoch_monotone`, `unchanged_epoch_preserves_snapshot`, `stale_reconciliation_publishes_nothing` |
| 8. Boot resurrection | Stopped marker prevents start; stopped intent/non-active role yield stopped marker | `stopped_marker_prevents_boot_replay`, `manual_stop_prevents_boot_replay`, `retained_or_pending_prevents_boot_replay` |

Original positive properties remain checked: Stop intent survives arbitrary background observation traces; stopped targets cannot produce additive correction/stale findings; app Stop clears active overrides; selected-container resume preserves siblings; corrective deploy admission excludes stopped active targets; fresh recreation preserves intent.

All dependency audits pass. Proofs use only standard Lean axioms `propext`, `Quot.sound`, and (for some arithmetic proofs) `Classical.choice`; historical concrete witnesses use no axioms. No custom axioms, unchecked placeholders, or native decision trust are used.

## Historical schedules

Original `Lock`/`Counterexamples` transitions intentionally retain the vulnerable behavior:

| Historical schedule | Witness | Repair |
| --- | --- | --- |
| Deploy → TTL expires → Stop completes → old deploy writes running | `stop_can_be_overwritten_after_expiry` | Callback-lifetime lock, acquisition-identity release |
| Select draining → rollback promotes active → remove saved target | `unlocked_sweep_removes_active_rollback` | Cleanup ownership and fresh eligibility |
| Create begins → delete app → create returns → FK insert fails | `unlocked_delete_can_leave_unrecorded_container` | Serialized deletion, immediate external ID capture |
| Observe exited → recreate new ID running → write old status by row ID | `old_observation_overwrites_replacement_status` | Epoch/identity guard and synchronous transaction |
| Promote new active → crash before old demotion | `crash_between_cutover_statements_leaves_both_active` | Transactional roles and durable crash phase |
| Build old body → cutover → fresh fetch timestamp | `fetch_timestamp_does_not_prove_config_installation` | Content hash, revision check, serialized install/load/ACK |
| Read app running → Stop → observe exited → classify old intent | `stale_reconcile_snapshot_can_report_manual_stop_as_missing` | Snapshot epoch validation before publication |
| Stop/retain → restart-policy boot selection → start | `boot_can_resurrect_manually_stopped`, `boot_can_resurrect_retained_generation` | Durable intent marker and boot guard |

The earlier `stale_recreate_snapshot_can_undo_stop` witness is also retained. [runtime-intent-db.test.ts](../src/lib/server/runtime-intent-db.test.ts) exercises its delayed-body schedule against the repaired handler. [lifecycle-freshness-db.test.ts](../src/lib/server/lifecycle-freshness-db.test.ts) exercises real delayed Podman HTTP listings across Stop/recreation and report publication. Focused database/worker suites cover cutover atomicity, phase recovery, cleanup ownership/ACK gates, durable marker writes, and routing ACK validation.

## Assumptions and limits

The proof subject is the Lean abstraction. There is **no verified extraction, compiler bridge, or TypeScript/SQL/shell refinement proof**. Source correspondence is reviewed and exercised by implementation tests; Lean does not automatically certify future source changes.

Assumptions: one control-plane process; lifecycle mutations use the worker lock; callbacks cannot outlive ownership; epochs are monotone within that process; stable application/worker assignment and authorization; correct identity matching; synchronous SQLite transactions/check-and-write blocks are atomic with respect to this process; declared remote success reflects the operation; SHA-256 identities are treated as collision-free; the worker installer holds its singleton lock through fetch/install/load/ACK; Traefik load verification accurately represents installed routing; marker-helper success reflects a durable worker write; boot uses the updated script.

Cutover projects two generations and successful atomic SQL commit/revert. Cleanup projects the protected eligibility/effect interval. Deletion proves ownership and captured compensation identity, not guaranteed compensation success. Routing models one serialized in-flight content snapshot: rejected old ACKs preserve existing ACK, while routing mutations invalidate it. The generic reconciliation model advances the epoch for relevant state mutations. A rollback target reverted to non-active can remain draining in source; the abstraction projects it as pending.

Unproved: eventual stop/start/cleanup; distributed transactions; transport failure after remote success; power loss inside marker persistence; partial failed recreation; all manifest/name/ownership matching rules; multi-process coordination; arbitrary commands bypassing Rudder; correctness of SQLite/Podman/Traefik; graceful completion of every in-flight request; all webhook orderings. Failed Stop preserves desired intent but may leave a running container. Hung callbacks retain their locks until completion or process restart. Physical drain timing is an operational assumption, not a theorem.

## Worker rollout

Lifecycle actions and startup/periodic synchronization atomically install the bundled boot guard on existing workers before persisting their intent markers. A successful Stop therefore also confirms guard installation. Unreachable workers retry synchronization when they become reachable; failures preserve desired intent and are reported rather than counted as successful stops.

The routing acknowledgement protocol requires updating/reprovisioning the worker's fetch script, verifier, and loopback Traefik API configuration. Workers without that support retain previous/candidate containers and report convergence failure instead of authorizing destruction from a fetch timestamp. No live worker deployment was performed as part of this change.
