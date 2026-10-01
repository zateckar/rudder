import Std

/-
Rudder lifecycle abstraction. Each namespace below states its scope explicitly.
The TypeScript-to-model correspondence is a reviewed assumption, not a theorem.
All proofs use the Lean kernel; no custom axioms or unchecked proof placeholders.
-/
namespace Rudder

inductive Intent where | running | stopped
  deriving DecidableEq, Repr
inductive Runtime where
  | absent | created | running | exited | paused | restarting | removing | unknown
  deriving DecidableEq, Repr
inductive Generation where | pending | active | draining
  deriving DecidableEq, Repr
inductive Deployment where | pending | running | succeeded | failed | rolledBack
  deriving DecidableEq, Repr
inductive Finding where | missing | stale | unhealthy | unexpectedRunning
  deriving DecidableEq, Repr

structure Row where
  overrideIntent : Option Intent := none
  runtime : Runtime := .running
  recorded : Runtime := .running
  generation : Generation := .active
  unhealthy : Bool := false
  stale : Bool := false
  podmanId : Nat := 0

-- Nat indices permit arbitrary replica counts; absent slots have no override.
structure App where
  intent : Intent := .running
  rows : Nat → Row := fun _ => {}
  deployment : Deployment := .succeeded

def effective (app : Intent) (row : Row) : Intent := row.overrideIntent.getD app

-- Matched desired container only. Orphans, foreign/helper ownership and retention
-- findings are distinct code paths, not approximated as runtime drift here.
def findings (app : Intent) (row : Row) : List Finding :=
  if effective app row = .stopped then
    if row.runtime = .running ∨ row.runtime = .paused then [.unexpectedRunning] else []
  else if row.runtime = .absent then [.missing]
  else
    (if row.stale then [.stale] else []) ++
    (if row.unhealthy then [.unhealthy]
      else if row.runtime ≠ .running then [.missing] else [])

def additive (finding : Finding) : Prop := finding = .missing ∨ finding = .unhealthy

theorem stopped_not_correctable (app : Intent) (row : Row)
    (h : effective app row = .stopped) (f : Finding) (hf : f ∈ findings app row) :
    ¬ additive f ∧ f ≠ .stale := by
  cases hr : row.runtime <;> simp_all [findings, additive]

def requestApp (s : App) (intent : Intent) : App :=
  { s with intent := intent, rows := fun i =>
      if (s.rows i).generation = .active then { s.rows i with overrideIntent := none }
      else s.rows i }

def requestContainer (s : App) (i : Nat) (intent : Intent) : App :=
  { s with rows := fun j =>
      if j = i then { s.rows j with overrideIntent := some intent } else s.rows j }

theorem app_stop_clears_active_overrides (s : App) (i : Nat)
    (h : (s.rows i).generation = .active) :
    effective (requestApp s .stopped).intent ((requestApp s .stopped).rows i) = .stopped := by
  simp [requestApp, effective, h]

theorem container_start_overrides_app_stop (s : App) (i : Nat) :
    effective (requestContainer s i .running).intent
      ((requestContainer s i .running).rows i) = .running := by
  simp [requestContainer, effective]

theorem container_request_preserves_sibling (s : App) (i j : Nat) (intent : Intent)
    (h : j ≠ i) :
    (requestContainer s i intent).rows j = s.rows j := by
  simp [requestContainer, h]

inductive Background where
  | persistObservation (i : Nat) (observed : Runtime)
  | externalRuntime (i : Nat) (runtime : Runtime)
  | reconcile
  | controlPlaneRestart
  | remoteFailure

-- Observation writes status, never desiredStatus. External runtime includes
-- crashes and out-of-band changes: these do not constitute operator intent.
def background (s : App) : Background → App
  | .persistObservation i observed =>
      { s with rows := fun j => if j = i then { s.rows j with recorded := observed } else s.rows j }
  | .externalRuntime i runtime =>
      { s with rows := fun j => if j = i then { s.rows j with runtime := runtime } else s.rows j }
  | .reconcile => s
  | .controlPlaneRestart => s
  | .remoteFailure => s

theorem background_preserves_intent (s : App) (e : Background) (i : Nat) :
    effective (background s e).intent ((background s e).rows i) =
      effective s.intent (s.rows i) := by
  cases e <;> simp [background, effective] <;> split <;> rfl

def runBackground (s : App) (events : List Background) : App := events.foldl background s

theorem arbitrary_background_trace_preserves_intent (s : App) (events : List Background) (i : Nat) :
    effective (runBackground s events).intent ((runBackground s events).rows i) =
      effective s.intent (s.rows i) := by
  induction events generalizing s with
  | nil => rfl
  | cons e events ih =>
      exact (ih (background s e)).trans (background_preserves_intent s e i)

theorem manual_stop_survives_background (s : App) (events : List Background) (i : Nat) :
    effective (runBackground (requestContainer s i .stopped) events).intent
      ((runBackground (requestContainer s i .stopped) events).rows i) = .stopped := by
  rw [arbitrary_background_trace_preserves_intent]
  simp [requestContainer, effective]

-- This matches the deploy guard: app must be running; no active explicit stop.
def repairAllowed (s : App) : Prop :=
  s.intent = .running ∧ ∀ i, (s.rows i).generation = .active →
    (s.rows i).overrideIntent ≠ some .stopped

theorem admitted_repair_has_no_stopped_active_target (s : App) (i : Nat)
    (allowed : repairAllowed s) (active : (s.rows i).generation = .active) :
    effective s.intent (s.rows i) = .running := by
  have appRunning := allowed.1
  have noStop := allowed.2 i active
  cases h : (s.rows i).overrideIntent with
  | none => simp [effective, h, appRunning]
  | some intent => cases intent <;> simp_all [effective]

-- Successful resource recreation uses the row re-read under the lock. Remote
-- failure is NOT assumed away in general; this theorem is about the success path.
def recreateFresh (s : App) (i : Nat) : App :=
  { s with rows := fun j => if j = i then
      { s.rows j with
        podmanId := (s.rows j).podmanId + 1
        runtime := if effective s.intent (s.rows j) = .running then .running else .created
        recorded := if effective s.intent (s.rows j) = .running then .running else .created }
    else s.rows j }

theorem recreation_preserves_stopped (s : App) (i : Nat)
    (h : effective s.intent (s.rows i) = .stopped) :
    ((recreateFresh s i).rows i).runtime = .created := by
  simp [recreateFresh, h]

theorem recreation_preserves_intent (s : App) (i j : Nat) :
    effective (recreateFresh s i).intent ((recreateFresh s i).rows j) =
      effective s.intent (s.rows j) := by
  simp [recreateFresh, effective]
  split <;> rfl

namespace Lock
inductive Actor where | deploy | stop
  deriving DecidableEq, Repr
structure State where
  holder : Option Actor := none
  expired : Bool := false
  deployAlive : Bool := false
  stopAlive : Bool := false
  deriving DecidableEq, Repr
inductive Event where | beginDeploy | beginStop | finishDeploy | finishStop | expire
  deriving DecidableEq, Repr

def acquire (s : State) (actor : Actor) : State :=
  if s.holder = none ∨ s.expired = true then
    { s with
      holder := some actor
      expired := false
      deployAlive := if actor = .deploy then true else s.deployAlive
      stopAlive := if actor = .stop then true else s.stopAlive }
  else s

def finish (s : State) (actor : Actor) : State :=
  { s with
    holder := if s.holder = some actor then none else s.holder
    deployAlive := if actor = .deploy then false else s.deployAlive
    stopAlive := if actor = .stop then false else s.stopAlive }

def step (s : State) : Event → State
  | .beginDeploy => acquire s .deploy
  | .beginStop => acquire s .stop
  | .finishDeploy => finish s .deploy
  | .finishStop => finish s .stop
  | .expire => { s with expired := true }

def safe (s : State) : Prop :=
  s.expired = false ∧
  (s.deployAlive = true → s.holder = some .deploy) ∧
  (s.stopAlive = true → s.holder = some .stop)

theorem stable_step_preserves_safe (s : State) (e : Event)
    (h : safe s) (noExpiry : e ≠ .expire) : safe (step s e) := by
  rcases s with ⟨holder, expired, a, b⟩
  cases holder with
  | none =>
      cases expired <;> cases a <;> cases b <;> cases e <;>
        simp_all [safe, step, acquire, finish]
  | some owner =>
      cases owner <;> cases expired <;> cases a <;> cases b <;> cases e <;>
        simp_all [safe, step, acquire, finish]

inductive StableReachable : State → Prop where
  | initial : StableReachable {}
  | next {s : State} (e : Event) : StableReachable s → e ≠ .expire → StableReachable (step s e)

theorem stable_reachable_safe {s : State} (h : StableReachable s) : safe s := by
  induction h with
  | initial => simp [safe]
  | next e _ noExpiry ih => exact stable_step_preserves_safe _ e ih noExpiry

theorem mutual_exclusion_without_expiry {s : State} (h : StableReachable s) :
    ¬ (s.deployAlive = true ∧ s.stopAlive = true) := by
  intro both
  have hs := stable_reachable_safe h
  have a := hs.2.1 both.1
  have b := hs.2.2 both.2
  rw [a] at b
  cases b

def expiryTrace : State := ([.beginDeploy, .expire, .beginStop] : List Event).foldl step {}

-- Reachability is by construction: this is an executable three-event schedule.
theorem expiry_allows_overlapping_callbacks :
    expiryTrace.deployAlive = true ∧ expiryTrace.stopAlive = true := by decide

-- Crucially, finally does not cancel the old callback when it loses ownership.
theorem old_finally_keeps_new_owner :
    (step expiryTrace .finishDeploy).holder = some .stop := by decide
end Lock

namespace Counterexamples
-- Each model below preserves precisely the source fields relevant to its race.
-- Events are individual await/statement boundaries, not one atomic HTTP request.

structure LateDeploy where
  mutex : Lock.State := {}
  intent : Intent := .running
  runtime : Runtime := .running
  stopCompleted : Bool := false
  deriving DecidableEq, Repr
inductive LateEvent where | beginDeploy | expire | stopAndFinish | deployStartAndFinish
  deriving DecidableEq, Repr
def lateStep (s : LateDeploy) : LateEvent → LateDeploy
  | .beginDeploy => { s with mutex := Lock.step s.mutex .beginDeploy }
  | .expire => { s with mutex := Lock.step s.mutex .expire }
  | .stopAndFinish =>
      let acquired := Lock.step s.mutex .beginStop
      if acquired.stopAlive then
        { s with
          mutex := Lock.step acquired .finishStop
          intent := .stopped, runtime := .exited, stopCompleted := true }
      else s
  | .deployStartAndFinish =>
      if s.mutex.deployAlive then
        { s with mutex := Lock.step s.mutex .finishDeploy, intent := .running, runtime := .running }
      else s
def stoppedDuringDeploy : LateDeploy :=
  ([.beginDeploy, .expire, .stopAndFinish] : List LateEvent).foldl lateStep {}
theorem stop_can_be_overwritten_after_expiry :
    stoppedDuringDeploy.intent = .stopped ∧ stoppedDuringDeploy.stopCompleted = true ∧
    (lateStep stoppedDuringDeploy .deployStartAndFinish).intent = .running ∧
    (lateStep stoppedDuringDeploy .deployStartAndFinish).runtime = .running := by decide

structure Retained where
  generation : Generation := .draining
  present : Bool := true
  selectedForRemoval : Bool := false
  rollbackOwnsLock : Bool := false
  runtime : Runtime := .exited
  deriving DecidableEq, Repr
inductive RetainEvent where | selectExpired | startRollback | promoteRollback | reapSnapshot
  deriving DecidableEq, Repr
def retainStep (s : Retained) : RetainEvent → Retained
  | .selectExpired => if s.generation = .draining then { s with selectedForRemoval := true } else s
  | .startRollback => if s.present && s.generation == .draining then
      { s with rollbackOwnsLock := true, runtime := .running } else s
  | .promoteRollback => if s.rollbackOwnsLock then { s with generation := .active } else s
  | .reapSnapshot => if s.selectedForRemoval then { s with present := false, runtime := .absent } else s
def reapedRollback : Retained :=
  ([.selectExpired, .startRollback, .promoteRollback, .reapSnapshot] : List RetainEvent).foldl retainStep {}
theorem unlocked_sweep_removes_active_rollback :
    reapedRollback.generation = .active ∧ reapedRollback.rollbackOwnsLock = true ∧
    reapedRollback.present = false := by decide

structure Deletion where
  appExists : Bool := true
  deployHasSnapshot : Bool := false
  deployOwnsLock : Bool := false
  remoteCreated : Bool := false
  rowRecorded : Bool := false
  deriving DecidableEq, Repr
inductive DeleteEvent where | beginDeploy | deleteApp | createRemote | insertRow
  deriving DecidableEq, Repr
def deleteStep (s : Deletion) : DeleteEvent → Deletion
  | .beginDeploy => { s with deployHasSnapshot := s.appExists, deployOwnsLock := true }
  | .deleteApp => { s with appExists := false, rowRecorded := false }
  | .createRemote => if s.deployHasSnapshot then { s with remoteCreated := true } else s
  | .insertRow => if s.appExists && s.remoteCreated then { s with rowRecorded := true } else s
def deletionTrace : Deletion :=
  ([.beginDeploy, .deleteApp, .createRemote, .insertRow] : List DeleteEvent).foldl deleteStep {}
theorem unlocked_delete_can_leave_unrecorded_container :
    deletionTrace.appExists = false ∧ deletionTrace.remoteCreated = true ∧
    deletionTrace.rowRecorded = false ∧ deletionTrace.deployOwnsLock = true := by decide

structure Observation where
  podmanId : Nat := 0
  runtime : Runtime := .exited
  recorded : Runtime := .running
  observedOld : Runtime := .unknown
  deriving DecidableEq, Repr
inductive ObserveEvent where | captureOld | recreateRunning | persistByRowId
  deriving DecidableEq, Repr
def observeStep (s : Observation) : ObserveEvent → Observation
  | .captureOld => { s with observedOld := s.runtime }
  | .recreateRunning => { s with podmanId := s.podmanId + 1, runtime := .running, recorded := .running }
  | .persistByRowId => { s with recorded := s.observedOld }
def staleObservation : Observation :=
  ([.captureOld, .recreateRunning, .persistByRowId] : List ObserveEvent).foldl observeStep {}
theorem old_observation_overwrites_replacement_status :
    staleObservation.podmanId = 1 ∧ staleObservation.runtime = .running ∧
    staleObservation.recorded = .exited := by decide

-- reconcileWorker reads app intent before independently reading rows/Podman.
-- A completed Stop can occur between those reads. Reports may transiently use
-- the old intent; the corrective deploy guard still re-reads authoritative DB intent.
structure ReconcileRead where
  actualIntent : Intent := .running
  snapshotIntent : Intent := .running
  runtime : Runtime := .running
  deriving DecidableEq, Repr
inductive ReadEvent where | readAppIntent | stopAppAndFinish
  deriving DecidableEq, Repr
def readStep (s : ReconcileRead) : ReadEvent → ReconcileRead
  | .readAppIntent => { s with snapshotIntent := s.actualIntent }
  | .stopAppAndFinish => { s with actualIntent := .stopped, runtime := .exited }
def staleReconcile : ReconcileRead :=
  ([.readAppIntent, .stopAppAndFinish] : List ReadEvent).foldl readStep {}
theorem stale_reconcile_snapshot_can_report_manual_stop_as_missing :
    staleReconcile.actualIntent = .stopped ∧
    .missing ∈ findings staleReconcile.snapshotIntent { runtime := staleReconcile.runtime } :=
  ⟨rfl, .head []⟩

structure Cutover where
  oldGeneration : Generation := .active
  newGeneration : Generation := .pending
  deployment : Deployment := .pending
  deriving DecidableEq, Repr
def promoteNew (s : Cutover) : Cutover := { s with newGeneration := .active }
def demoteOld (s : Cutover) : Cutover := { s with oldGeneration := .draining }
-- Startup fails pending deployments, but the interrupted-generation sweep only
-- removes container rows still marked pending, not these two active generations.
def recoverCrash (s : Cutover) : Cutover := { s with deployment := .failed }
theorem two_statement_cutover_exposes_two_active_generations :
    (promoteNew {}).oldGeneration = .active ∧ (promoteNew {}).newGeneration = .active := by decide
theorem crash_between_cutover_statements_leaves_both_active :
    (recoverCrash (promoteNew {})).oldGeneration = .active ∧
    (recoverCrash (promoteNew {})).newGeneration = .active ∧
    (recoverCrash (promoteNew {})).deployment = .failed := by decide
theorem completed_cutover_has_intended_roles :
    (demoteOld (promoteNew {})).oldGeneration = .draining ∧
    (demoteOld (promoteNew {})).newGeneration = .active := by decide

-- A response-generation timestamp is not an acknowledgment that the worker
-- received or installed that response. The body can precede a concurrent cutover.
structure ConfigAck where
  desiredGeneration : Nat := 1
  builtBodyGeneration : Nat := 0
  installedGeneration : Nat := 1
  fetchedAfterCutover : Bool := false
  deriving DecidableEq, Repr
inductive ConfigEvent where | buildOldBody | cutover | stampFetch
  deriving DecidableEq, Repr
def configStep (s : ConfigAck) : ConfigEvent → ConfigAck
  | .buildOldBody => { s with builtBodyGeneration := s.desiredGeneration }
  | .cutover => { s with desiredGeneration := s.desiredGeneration + 1 }
  | .stampFetch => { s with fetchedAfterCutover := true }
def falseAck : ConfigAck :=
  ([.buildOldBody, .cutover, .stampFetch] : List ConfigEvent).foldl configStep {}
theorem fetch_timestamp_does_not_prove_config_installation :
    falseAck.fetchedAfterCutover = true ∧
    falseAck.builtBodyGeneration ≠ falseAck.desiredGeneration ∧
    falseAck.installedGeneration ≠ falseAck.desiredGeneration := by decide

-- The worker script consults restart policy, not control-plane desiredStatus or
-- generation role. This is outside the background-intent-preservation theorem.
def bootReplay (row : Row) (hasBootRestartPolicy : Bool) : Row :=
  if hasBootRestartPolicy then { row with runtime := .running } else row
def stoppedRow : Row := { overrideIntent := some .stopped, runtime := .exited }
theorem boot_can_resurrect_manually_stopped :
    effective .running (bootReplay stoppedRow true) = .stopped ∧
    (bootReplay stoppedRow true).runtime = .running := by decide
theorem boot_can_resurrect_retained_generation :
    (bootReplay { runtime := .exited, generation := .draining } true).generation = .draining ∧
    (bootReplay { runtime := .exited, generation := .draining } true).runtime = .running := by decide

-- Regression witness for the earlier pre-lock snapshot bug, now corrected.
def recreateUsingSnapshot (snapshot : Intent) (current : Row) : Row :=
  { current with runtime := if snapshot = .running then .running else .created }
theorem stale_recreate_snapshot_can_undo_stop :
    effective .running (recreateUsingSnapshot .running stoppedRow) = .stopped ∧
    (recreateUsingSnapshot .running stoppedRow).runtime = .running := by decide
end Counterexamples

-- Audit output is part of the verification command. These proofs should have
-- only Lean's standard logical axioms, never custom assumptions or native trust.
#print axioms arbitrary_background_trace_preserves_intent
#print axioms manual_stop_survives_background
#print axioms stopped_not_correctable
#print axioms app_stop_clears_active_overrides
#print axioms container_start_overrides_app_stop
#print axioms container_request_preserves_sibling
#print axioms background_preserves_intent
#print axioms admitted_repair_has_no_stopped_active_target
#print axioms recreation_preserves_stopped
#print axioms recreation_preserves_intent
#print axioms Lock.stable_step_preserves_safe
#print axioms Lock.stable_reachable_safe
#print axioms Lock.mutual_exclusion_without_expiry
#print axioms Lock.expiry_allows_overlapping_callbacks
#print axioms Lock.old_finally_keeps_new_owner
#print axioms Counterexamples.stop_can_be_overwritten_after_expiry
#print axioms Counterexamples.unlocked_sweep_removes_active_rollback
#print axioms Counterexamples.unlocked_delete_can_leave_unrecorded_container
#print axioms Counterexamples.old_observation_overwrites_replacement_status
#print axioms Counterexamples.stale_reconcile_snapshot_can_report_manual_stop_as_missing
#print axioms Counterexamples.two_statement_cutover_exposes_two_active_generations
#print axioms Counterexamples.crash_between_cutover_statements_leaves_both_active
#print axioms Counterexamples.completed_cutover_has_intended_roles
#print axioms Counterexamples.fetch_timestamp_does_not_prove_config_installation
#print axioms Counterexamples.boot_can_resurrect_manually_stopped
#print axioms Counterexamples.boot_can_resurrect_retained_generation
#print axioms Counterexamples.stale_recreate_snapshot_can_undo_stop

/- Repaired policies. Counterexamples above intentionally retain the old,
   vulnerable transitions as executable historical regression witnesses. -/
namespace Repaired

-- A timeout is diagnostic and does not affect callback ownership.
def lockStep (s : Lock.State) (e : Lock.Event) : Lock.State :=
  if e = .expire then s else Lock.step s e

theorem lock_step_safe (s : Lock.State) (e : Lock.Event) (h : Lock.safe s) :
    Lock.safe (lockStep s e) := by
  by_cases he : e = .expire
  · simp [lockStep, he, h]
  · simpa [lockStep, he] using Lock.stable_step_preserves_safe s e h he

def runLock (s : Lock.State) (events : List Lock.Event) : Lock.State :=
  events.foldl lockStep s

theorem arbitrary_lock_trace_safe (s : Lock.State) (events : List Lock.Event)
    (h : Lock.safe s) : Lock.safe (runLock s events) := by
  induction events generalizing s with
  | nil => exact h
  | cons e events ih => exact ih (lockStep s e) (lock_step_safe s e h)

theorem callback_exclusion_including_timeouts (events : List Lock.Event) :
    ¬ ((runLock {} events).deployAlive = true ∧ (runLock {} events).stopAlive = true) := by
  have hs := arbitrary_lock_trace_safe {} events (by simp [Lock.safe])
  intro both
  have a := hs.2.1 both.1
  have b := hs.2.2 both.2
  rw [a] at b
  cases b

-- Cleanup reads the role only after acquiring the same worker lock. Atomic
-- eligibility+effect projects the interval protected from lifecycle mutations.
structure CleanupTarget where
  role : Generation := .draining
  present : Bool := true
  cleanupOwnsLock : Bool := false
  rollbackOwnsLock : Bool := false
  expired : Bool := true
  routingExcluded : Bool := false
  deriving DecidableEq, Repr

def reap (s : CleanupTarget) : CleanupTarget :=
  if s.cleanupOwnsLock && !s.rollbackOwnsLock && s.expired && s.routingExcluded &&
      s.role == .draining then { s with present := false } else s

theorem reap_preserves_active (s : CleanupTarget) (h : s.role = .active) :
    (reap s).present = s.present := by simp [reap, h]

theorem reap_cannot_cross_rollback (s : CleanupTarget) (h : s.rollbackOwnsLock = true) :
    reap s = s := by simp [reap, h]

theorem reap_requires_routing_exclusion (s : CleanupTarget) (h : s.routingExcluded = false) :
    reap s = s := by simp [reap, h]

-- Delete is an exclusive lifecycle operation; remote effects are captured before
-- row insertion can fail. Compensation success is not assumed for this property.
structure DeletionState where
  appExists : Bool := true
  deployOwnsLock : Bool := false
  remoteCreated : Bool := false
  capturedForCleanup : Bool := false
  rowRecorded : Bool := false
  deriving DecidableEq, Repr

def deleteApp (s : DeletionState) : DeletionState :=
  if s.deployOwnsLock then s else { s with appExists := false }

def captureCreated (s : DeletionState) : DeletionState :=
  { s with remoteCreated := true, capturedForCleanup := true }

def failedInsert (s : DeletionState) : DeletionState := s

theorem delete_cannot_cross_live_deploy (s : DeletionState) (h : s.deployOwnsLock = true) :
    deleteApp s = s := by simp [deleteApp, h]

theorem failed_insert_retains_external_identity (s : DeletionState) :
    (failedInsert (captureCreated s)).remoteCreated = true ∧
    (failedInsert (captureCreated s)).capturedForCleanup = true := by
  simp [failedInsert, captureCreated]

-- The process-local epoch advances on lock acquire/release, including operations
-- that retain the same Podman ID. Guard+SQLite writes contain no await boundary.
structure ObservationState where
  epoch : Nat := 0
  busy : Bool := false
  podmanId : Nat := 0
  recorded : Runtime := .running
  deriving DecidableEq, Repr

structure Snapshot where
  epoch : Nat
  podmanId : Nat
  status : Runtime
  deriving DecidableEq, Repr

def persist (s : ObservationState) (snapshot : Snapshot) : ObservationState :=
  if !s.busy && s.epoch == snapshot.epoch && s.podmanId == snapshot.podmanId then
    { s with recorded := snapshot.status } else s

theorem changed_identity_rejects_observation (s : ObservationState) (snapshot : Snapshot)
    (h : s.podmanId ≠ snapshot.podmanId) : persist s snapshot = s := by
  simp [persist, h]

theorem changed_epoch_rejects_observation (s : ObservationState) (snapshot : Snapshot)
    (h : s.epoch ≠ snapshot.epoch) : persist s snapshot = s := by
  simp [persist, h]

theorem active_mutation_rejects_observation (s : ObservationState) (snapshot : Snapshot)
    (h : s.busy = true) : persist s snapshot = s := by simp [persist, h]

def completedMutation (s : ObservationState) (status : Runtime) : ObservationState :=
  { s with epoch := s.epoch + 2, busy := false, recorded := status }

theorem same_identity_mutation_rejects_old_status (s : ObservationState) (observed current : Runtime) :
    persist (completedMutation s current) { epoch := s.epoch, podmanId := s.podmanId, status := observed } =
      completedMutation s current := by
  apply changed_epoch_rejects_observation
  simp [completedMutation]

-- Atomic role promotion/demotion and crash phase are one database transaction.
structure CutoverState where
  oldRole : Generation := .active
  newRole : Generation := .pending
  committed : Bool := false
  history : Deployment := .pending
  claimsPreviousServing : Bool := false
  deriving DecidableEq, Repr

inductive CutoverEvent where | commit | revert | recover
  deriving DecidableEq, Repr

def cutoverStep (s : CutoverState) : CutoverEvent → CutoverState
  | .commit => { s with oldRole := .draining, newRole := .active, committed := true }
  | .revert => { s with oldRole := .active, newRole := .pending, committed := false }
  | .recover => { s with history := .failed, claimsPreviousServing := !s.committed }

def exclusiveRoles (s : CutoverState) : Prop := ¬ (s.oldRole = .active ∧ s.newRole = .active)

theorem atomic_cutover_step_preserves_exclusive_roles (s : CutoverState) (e : CutoverEvent)
    (h : exclusiveRoles s) : exclusiveRoles (cutoverStep s e) := by
  cases e <;> simp_all [cutoverStep, exclusiveRoles]

theorem arbitrary_cutover_trace_exclusive (s : CutoverState) (events : List CutoverEvent)
    (h : exclusiveRoles s) : exclusiveRoles (events.foldl cutoverStep s) := by
  induction events generalizing s with
  | nil => exact h
  | cons e events ih => exact ih (cutoverStep s e) (atomic_cutover_step_preserves_exclusive_roles s e h)

theorem recovery_does_not_claim_previous_after_commit (s : CutoverState) (h : s.committed = true) :
    (cutoverStep s .recover).claimsPreviousServing = false := by simp [cutoverStep, h]

-- Hashes are modeled as collision-free content identities. Installation is
-- serial on the worker; acknowledgements happen only after successful loading.
structure RoutingState where
  desiredContent : Nat := 0
  installedContent : Nat := 0
  acknowledged : Option Nat := none
  inFlight : Option Nat := none
  deriving DecidableEq, Repr

inductive RoutingEvent where | fetch | mutate (content : Nat) | installAndAcknowledge (content : Nat)
  deriving DecidableEq, Repr

def routingStep (s : RoutingState) : RoutingEvent → RoutingState
  | .fetch => if s.inFlight = none then { s with inFlight := some s.desiredContent } else s
  | .mutate content => { s with desiredContent := content, acknowledged := none }
  | .installAndAcknowledge content =>
      if s.inFlight = some content then { s with
        installedContent := content
        inFlight := none
        acknowledged := if content = s.desiredContent then some content else s.acknowledged }
      else s

def validAcknowledgement (s : RoutingState) : Prop :=
  s.acknowledged = some s.desiredContent → s.installedContent = s.desiredContent ∧
    (∀ content, s.inFlight = some content → content = s.desiredContent)

theorem routing_step_preserves_acknowledgement (s : RoutingState) (e : RoutingEvent)
    (h : validAcknowledgement s) : validAcknowledgement (routingStep s e) := by
  cases e with
  | fetch =>
      by_cases hf : s.inFlight = none
      · simp_all [routingStep, validAcknowledgement]
      · simpa [routingStep, hf] using h
  | mutate content => simp [routingStep, validAcknowledgement]
  | installAndAcknowledge content =>
      by_cases hf : s.inFlight = some content
      · by_cases hc : content = s.desiredContent
        · simp [routingStep, hf, hc, validAcknowledgement]
        · simp only [routingStep, hf, ↓reduceIte, hc, validAcknowledgement]
          intro ha
          exact False.elim (hc ((h ha).2 content hf))
      · simpa [routingStep, hf] using h

theorem arbitrary_routing_trace_acknowledges_installed_content (s : RoutingState) (events : List RoutingEvent)
    (h : validAcknowledgement s) : validAcknowledgement (events.foldl routingStep s) := by
  induction events generalizing s with
  | nil => exact h
  | cons e events ih => exact ih (routingStep s e) (routing_step_preserves_acknowledgement s e h)

theorem response_fetch_is_not_install_ack (s : RoutingState) :
    (routingStep s .fetch).acknowledged = s.acknowledged := by
  simp [routingStep]
  split <;> rfl

-- A routing exclusion ACK is required even for a candidate whose promotion was
-- reverted: lack of ACK never proves the candidate was not installed.
def discardCandidate (present excluded : Bool) : Bool := if excluded then false else present

theorem failed_ack_preserves_candidate (present : Bool) :
    discardCandidate present false = present := rfl

-- A version increments whenever state can mutate. An unchanged version across
-- any finite trace guarantees the state is unchanged (used for reconciliation).
structure Versioned (α : Type) where
  epoch : Nat
  value : α

def versionStep {α : Type} (s : Versioned α) (update : Option α) : Versioned α :=
  match update with
  | none => s
  | some value => { epoch := s.epoch + 1, value }

theorem version_trace_epoch_monotone {α : Type} (s : Versioned α) (events : List (Option α)) :
    s.epoch ≤ (events.foldl versionStep s).epoch := by
  induction events generalizing s with
  | nil => exact Nat.le_refl _
  | cons e events ih =>
      have tail := ih (versionStep s e)
      cases e <;> simp [versionStep] at tail ⊢ <;> omega

theorem unchanged_epoch_preserves_snapshot {α : Type} (s : Versioned α) (events : List (Option α))
    (h : (events.foldl versionStep s).epoch = s.epoch) : (events.foldl versionStep s).value = s.value := by
  induction events generalizing s with
  | nil => rfl
  | cons e events ih =>
      cases e with
      | none => exact ih s h
      | some value =>
          have monotone := version_trace_epoch_monotone (versionStep s (some value)) events
          simp [versionStep] at monotone h
          omega

def publishReport (currentEpoch snapshotEpoch : Nat) (busy : Bool) (report : List Finding) : Option (List Finding) :=
  if !busy && currentEpoch == snapshotEpoch then some report else none

theorem stale_reconciliation_publishes_nothing (currentEpoch snapshotEpoch : Nat) (busy : Bool)
    (report : List Finding) (h : currentEpoch ≠ snapshotEpoch) :
    publishReport currentEpoch snapshotEpoch busy report = none := by simp [publishReport, h]

-- A durable worker marker is independent of the immutable Podman crash policy.
-- Updated boot script permits managed boot replay only with marker=running.
def durableMarker (app : Intent) (row : Row) : Intent :=
  if row.generation = .active then effective app row else .stopped

def bootWithMarker (row : Row) (marker : Intent) (hasBootPolicy : Bool) : Row :=
  if hasBootPolicy && marker == .running then { row with runtime := .running } else row

theorem stopped_marker_prevents_boot_replay (row : Row) (hasBootPolicy : Bool) :
    bootWithMarker row .stopped hasBootPolicy = row := by simp [bootWithMarker]

theorem manual_stop_prevents_boot_replay (app : Intent) (row : Row) (hasBootPolicy : Bool)
    (h : effective app row = .stopped) : bootWithMarker row (durableMarker app row) hasBootPolicy = row := by
  by_cases ha : row.generation = .active <;> simp [durableMarker, ha, h, bootWithMarker]

theorem retained_or_pending_prevents_boot_replay (app : Intent) (row : Row) (hasBootPolicy : Bool)
    (h : row.generation ≠ .active) : bootWithMarker row (durableMarker app row) hasBootPolicy = row := by
  simp [durableMarker, h, bootWithMarker]

#print axioms lock_step_safe
#print axioms arbitrary_lock_trace_safe
#print axioms callback_exclusion_including_timeouts
#print axioms reap_preserves_active
#print axioms reap_cannot_cross_rollback
#print axioms reap_requires_routing_exclusion
#print axioms delete_cannot_cross_live_deploy
#print axioms failed_insert_retains_external_identity
#print axioms changed_identity_rejects_observation
#print axioms changed_epoch_rejects_observation
#print axioms active_mutation_rejects_observation
#print axioms same_identity_mutation_rejects_old_status
#print axioms atomic_cutover_step_preserves_exclusive_roles
#print axioms arbitrary_cutover_trace_exclusive
#print axioms recovery_does_not_claim_previous_after_commit
#print axioms routing_step_preserves_acknowledgement
#print axioms arbitrary_routing_trace_acknowledges_installed_content
#print axioms response_fetch_is_not_install_ack
#print axioms failed_ack_preserves_candidate
#print axioms version_trace_epoch_monotone
#print axioms unchanged_epoch_preserves_snapshot
#print axioms stale_reconciliation_publishes_nothing
#print axioms stopped_marker_prevents_boot_replay
#print axioms manual_stop_prevents_boot_replay
#print axioms retained_or_pending_prevents_boot_replay
end Repaired
end Rudder
