---------------------------- MODULE StopSteer ----------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Msgs, MaxText, Fixes, Breaks

None == "none"
Fix(f) == f \in Fixes
Break(b) == b \in Breaks

Q(m) == "Q" \o ToString(m)
R(m) == "R" \o ToString(m)
RunIds == {"A"} \cup {Q(m) : m \in Msgs} \cup {R(m) : m \in Msgs}
Input(r) == IF r = "A" THEN 0 ELSE CHOOSE m \in Msgs : r \in {Q(m), R(m)}
Live == {"pending", "running"}
Terminal == {"done", "stopped"}
Gone == {"none", "withdrawn", "moved"}

Keep(s, Test(_)) ==
  LET F[i \in 0..Len(s)] == IF i = 0 THEN <<>> ELSE IF Test(s[i]) THEN Append(F[i-1], s[i]) ELSE F[i-1]
  IN F[Len(s)]
Elems(s) == {s[i] : i \in DOMAIN s}

TurnTag(m) == <<"turn", m>>
SendTag(m) == <<"send", m>>
SteerTag(m) == <<"steer", m>>
AbortTag == <<"abort", 0>>

NoTurn == [st |-> None, steer |-> FALSE]
NoSteer == [st |-> None, r |-> None, fresh |-> FALSE, res |-> None]
NoAbort == [st |-> None, r |-> None, res |-> None, back |-> {}, hit |-> {}]
NoActive == [st |-> None, why |-> None, live |-> None, queued |-> <<>>, chipsAt |-> {}, rows |-> {}]

VARIABLES
  status, order, sig, hq, aborted, text, intakes, delivered, notifyWorking,
  composer, streaming, follow, slotRun, stopReq, chips, steering, pendingSteers,
  rowsLocal, rowsRun, seenIntake, rendered, endChain, frozen, resumeWanted, lastAborted, idleEvent,
  turnReq, sendReq, steerReq, abortReq, activeReq, ctl,
  stopClicked, stopRun, stopAcked, ackRendered, postStop, lateRuns, stopMissed

server == <<status, order, sig, hq, aborted, text, intakes, delivered, notifyWorking>>
client == <<composer, streaming, follow, slotRun, stopReq, chips, steering, pendingSteers,
            rowsLocal, rowsRun, seenIntake, rendered, endChain, frozen, resumeWanted, lastAborted, idleEvent>>
reqs == <<turnReq, sendReq, steerReq, abortReq, activeReq, ctl>>
ghosts == <<stopClicked, stopRun, stopAcked, ackRendered, postStop, lateRuns, stopMissed>>
vars == <<server, client, reqs, ghosts>>

Init ==
  /\ status = [r \in RunIds |-> IF r = "A" THEN "running" ELSE "none"]
  /\ order = <<"A">>
  /\ sig = [r \in RunIds |-> <<>>]
  /\ hq = [r \in RunIds |-> {}]
  /\ aborted = [r \in RunIds |-> FALSE]
  /\ text = [r \in RunIds |-> 0]
  /\ intakes = [r \in RunIds |-> {}]
  /\ delivered = [m \in Msgs |-> 0]
  /\ notifyWorking = FALSE
  /\ composer = Msgs
  /\ streaming = TRUE
  /\ follow = "A"
  /\ slotRun = "A"
  /\ stopReq = FALSE
  /\ chips = {}
  /\ steering = {}
  /\ pendingSteers = {}
  /\ rowsLocal = [m \in Msgs |-> 0]
  /\ rowsRun = {}
  /\ seenIntake = [r \in RunIds |-> {}]
  /\ rendered = [r \in RunIds |-> 0]
  /\ endChain = "idle"
  /\ frozen = {}
  /\ resumeWanted = FALSE
  /\ lastAborted = FALSE
  /\ idleEvent = FALSE
  /\ turnReq = [m \in Msgs |-> NoTurn]
  /\ sendReq = [m \in Msgs |-> None]
  /\ steerReq = [m \in Msgs |-> NoSteer]
  /\ abortReq = NoAbort
  /\ activeReq = NoActive
  /\ ctl = <<>>
  /\ stopClicked = FALSE
  /\ stopRun = None
  /\ stopAcked = FALSE
  /\ ackRendered = 0
  /\ postStop = {}
  /\ lateRuns = {}
  /\ stopMissed = FALSE

Running == {r \in RunIds : status[r] = "running"}
LiveRuns == {r \in RunIds : status[r] \in Live}
LiveOrder == Keep(order, LAMBDA r : status[r] \in Live)
FirstLive == IF LiveOrder = <<>> THEN None ELSE Head(LiveOrder)
QueuedAfter(live) ==
  LET rs == Keep(order, LAMBDA r : status[r] \in Live /\ r # live /\ r # "A")
  IN [i \in 1..Len(rs) |-> Input(rs[i])]
SteerSignals(r) == {sig[r][i].m : i \in {j \in DOMAIN sig[r] : sig[r][j].k = "steer"}}
ServerRows == {r \in RunIds : r # "A" /\ status[r] \in {"running", "done", "stopped"}}
RowCount(m) == rowsLocal[m] + Cardinality({r \in rowsRun : Input(r) = m})
               + Cardinality({r \in RunIds : m \in seenIntake[r]})

Serial(tag) == ~Fix("serial_controls") \/ (ctl # <<>> /\ Head(ctl) = tag)
Drop(tag) == Keep(ctl, LAMBDA t : t # tag)

VisibleChips == {m \in chips \ pendingSteers : Fix("chip_skips_started") => \A r \in rowsRun : Input(r) # m}

CanSteer == streaming /\ ~stopReq /\ slotRun # None

Created(r) == /\ status' = [status EXCEPT ![r] = "pending"]
              /\ order' = Append(order, r)
              /\ notifyWorking' = TRUE

SubmitWhileStreaming(m, pref) ==
  /\ m \in composer /\ streaming
  /\ composer' = composer \ {m}
  /\ turnReq' = [turnReq EXCEPT ![m] = [st |-> "sent", steer |-> pref /\ CanSteer]]
  /\ ctl' = Append(ctl, TurnTag(m))
  /\ postStop' = IF stopClicked THEN postStop \cup {m} ELSE postStop
  /\ UNCHANGED <<server, streaming, follow, slotRun, stopReq, chips, steering, pendingSteers, rowsLocal, rowsRun,
                 seenIntake, rendered, endChain, frozen, resumeWanted, lastAborted, idleEvent, sendReq, steerReq, abortReq, activeReq,
                 stopClicked, stopRun, stopAcked, ackRendered, lateRuns, stopMissed>>

SubmitIdle(m) ==
  /\ m \in composer /\ ~streaming
  /\ composer' = composer \ {m}
  /\ streaming' = TRUE /\ follow' = None /\ slotRun' = None /\ stopReq' = FALSE /\ lastAborted' = FALSE
  /\ rowsLocal' = [rowsLocal EXCEPT ![m] = @ + 1]
  /\ sendReq' = [sendReq EXCEPT ![m] = "sent"]
  /\ ctl' = Append(ctl, SendTag(m))
  /\ postStop' = IF stopClicked THEN postStop \cup {m} ELSE postStop
  /\ UNCHANGED <<server, chips, steering, pendingSteers, rowsRun, seenIntake, rendered, endChain, frozen, resumeWanted, idleEvent,
                 turnReq, steerReq, abortReq, activeReq, stopClicked, stopRun, stopAcked, ackRendered,
                 lateRuns, stopMissed>>

ServerTurn(m) ==
  /\ turnReq[m].st = "sent" /\ Serial(TurnTag(m))
  /\ Created(Q(m))
  /\ turnReq' = [turnReq EXCEPT ![m].st = "done"]
  /\ UNCHANGED <<sig, hq, aborted, text, intakes, delivered, client, sendReq, steerReq,
                 abortReq, activeReq, ctl, ghosts>>

ServerSend(m) ==
  /\ sendReq[m] = "sent" /\ Serial(SendTag(m))
  /\ Created(Q(m))
  /\ sendReq' = [sendReq EXCEPT ![m] = "done"]
  /\ UNCHANGED <<sig, hq, aborted, text, intakes, delivered, client, turnReq, steerReq,
                 abortReq, activeReq, ctl, ghosts>>

ClientSendReply(m) ==
  /\ sendReq[m] = "done"
  /\ sendReq' = [sendReq EXCEPT ![m] = None]
  /\ IF streaming /\ follow = None
     THEN /\ follow' = Q(m) /\ slotRun' = Q(m)
          /\ rowsLocal' = [rowsLocal EXCEPT ![m] = @ - 1]
          /\ rowsRun' = rowsRun \cup {Q(m)}
          /\ abortReq' = IF stopReq THEN [st |-> "sent", r |-> Q(m), res |-> None, back |-> {}, hit |-> {}] ELSE abortReq
          /\ ctl' = IF stopReq THEN Append(Drop(SendTag(m)), AbortTag) ELSE Drop(SendTag(m))
          /\ stopRun' = IF stopReq THEN Q(m) ELSE stopRun
          /\ frozen' = IF stopReq /\ Fix("freeze_on_stop") THEN frozen \cup {Q(m)} ELSE frozen
     ELSE /\ ctl' = Drop(SendTag(m))
          /\ UNCHANGED <<follow, slotRun, rowsLocal, rowsRun, abortReq, stopRun, frozen>>
  /\ UNCHANGED <<server, composer, streaming, stopReq, chips, steering, pendingSteers, seenIntake, rendered,
                 endChain, resumeWanted, lastAborted, idleEvent, turnReq, steerReq, activeReq, stopClicked, stopAcked, ackRendered, postStop,
                 lateRuns, stopMissed>>

SteerStart(m, fresh, ctl0) ==
  IF slotRun = None \/ m \in pendingSteers
  THEN /\ chips' = IF fresh THEN chips \cup {m} ELSE chips
       /\ ctl' = ctl0
       /\ UNCHANGED <<steering, pendingSteers, steerReq>>
  ELSE /\ pendingSteers' = pendingSteers \cup {m}
       /\ steering' = steering \cup {m}
       /\ steerReq' = [steerReq EXCEPT ![m] = [st |-> "sent", r |-> slotRun, fresh |-> fresh, res |-> None]]
       /\ ctl' = Append(ctl0, SteerTag(m))
       /\ UNCHANGED chips

ClientTurnReply(m) ==
  /\ turnReq[m].st = "done"
  /\ turnReq' = [turnReq EXCEPT ![m] = NoTurn]
  /\ IF turnReq[m].steer /\ CanSteer /\ (Fix("no_self_steer") => slotRun # Q(m))
     THEN SteerStart(m, TRUE, Drop(TurnTag(m)))
     ELSE /\ chips' = chips \cup {m}
          /\ steering' = steering \ {m}
          /\ ctl' = Drop(TurnTag(m))
          /\ UNCHANGED <<pendingSteers, steerReq>>
  /\ resumeWanted' = (resumeWanted \/ (Fix("turn_reply_resyncs") /\ ~streaming))
  /\ UNCHANGED <<server, composer, streaming, follow, slotRun, stopReq, rowsLocal, rowsRun, seenIntake,
                 rendered, endChain, frozen, sendReq, abortReq, activeReq, lastAborted, idleEvent, ghosts>>

ClickChipSteer(m) ==
  /\ m \in VisibleChips /\ CanSteer /\ turnReq[m].st = None
  /\ SteerStart(m, FALSE, ctl)
  /\ UNCHANGED <<server, composer, streaming, follow, slotRun, stopReq, rowsLocal, rowsRun, seenIntake,
                 rendered, endChain, frozen, resumeWanted, lastAborted, idleEvent, turnReq, sendReq, abortReq, activeReq, ghosts>>

ServerSteerCheck(m) ==
  LET r == steerReq[m].r IN
  /\ steerReq[m].st = "sent" /\ Serial(SteerTag(m))
  /\ steerReq' = [steerReq EXCEPT ![m] =
        CASE status[r] \in Gone -> [@ EXCEPT !.st = "done", !.res = "not_found"]
          [] status[r] \in Terminal -> [@ EXCEPT !.st = "done", !.res = "terminal"]
          [] status[Q(m)] \in Gone -> [@ EXCEPT !.st = "done", !.res = "not_found"]
          [] r = Q(m) -> [@ EXCEPT !.st = "done", !.res = "queued_started"]
          [] status[Q(m)] # "pending" -> [@ EXCEPT !.st = "done", !.res = "queued_started"]
          [] OTHER -> [@ EXCEPT !.st = "cte"]]
  /\ UNCHANGED <<server, client, turnReq, sendReq, abortReq, activeReq, ctl, ghosts>>

ServerSteerCte(m) ==
  LET r == steerReq[m].r IN
  /\ steerReq[m].st = "cte"
  /\ IF status[r] \in Live /\ status[Q(m)] = "pending"
     THEN /\ status' = [status EXCEPT ![Q(m)] = "moved"]
          /\ sig' = [sig EXCEPT ![r] = Append(@, [k |-> "steer", m |-> m, seen |-> FALSE])]
          /\ steerReq' = [steerReq EXCEPT ![m].st = "after"]
     ELSE /\ steerReq' = [steerReq EXCEPT ![m] = [@ EXCEPT !.st = "done",
                 !.res = IF status[Q(m)] = "pending" THEN "queued_changed" ELSE "queued_started"]]
          /\ UNCHANGED <<status, sig>>
  /\ UNCHANGED <<order, hq, aborted, text, intakes, delivered, notifyWorking, client, turnReq, sendReq,
                 abortReq, activeReq, ctl, ghosts>>

DrainEffect(r) ==
  LET fresh == {m \in SteerSignals(r) : status[R(m)] = "none"}
      added == [i \in 1..Cardinality(fresh) |->
                  R(CHOOSE x \in fresh : Cardinality({y \in fresh : y < x}) = i - 1)]
  IN /\ sig' = [sig EXCEPT ![r] = <<>>]
     /\ status' = [x \in RunIds |-> IF \E m \in fresh : x = R(m) THEN "pending" ELSE status[x]]
     /\ order' = order \o added
     /\ notifyWorking' = (notifyWorking \/ fresh # {})

ServerSteerAfter(m) ==
  LET r == steerReq[m].r IN
  /\ steerReq[m].st = "after"
  /\ IF status[r] \in Terminal
     THEN /\ DrainEffect(r)
          /\ steerReq' = [steerReq EXCEPT ![m] = [@ EXCEPT !.st = "done",
                 !.res = "replayed"]]
     ELSE /\ steerReq' = [steerReq EXCEPT ![m] = [@ EXCEPT !.st = "done", !.res = "ok"]]
          /\ UNCHANGED <<status, order, sig, notifyWorking>>
  /\ UNCHANGED <<hq, aborted, text, intakes, delivered, client, turnReq, sendReq,
                 abortReq, activeReq, ctl, ghosts>>

ClientSteerReply(m) ==
  LET res == steerReq[m].res IN
  /\ steerReq[m].st = "done"
  /\ steerReq' = [steerReq EXCEPT ![m] = NoSteer]
  /\ ctl' = Drop(SteerTag(m))
  /\ pendingSteers' = pendingSteers \ {m}
  /\ chips' = CASE res \in {"ok", "replayed", "queued_started", "not_found"} -> chips \ {m}
               [] steerReq[m].fresh -> chips \cup {m}
               [] OTHER -> chips
  /\ steering' = IF res = "ok" \/ (res \in {"replayed", "queued_started"} /\ Fix("steer_rows_until_landed"))
                  THEN steering ELSE steering \ {m}
  /\ rowsLocal' = IF res = "replayed" /\ ~Fix("drop_replay_push") THEN [rowsLocal EXCEPT ![m] = @ + 1] ELSE rowsLocal
  /\ resumeWanted' = (resumeWanted \/ ~streaming)
  /\ UNCHANGED <<server, composer, streaming, follow, slotRun, stopReq, rowsRun, seenIntake, rendered,
                 endChain, frozen, turnReq, sendReq, abortReq, activeReq, lastAborted, idleEvent, ghosts>>

ClickStop ==
  /\ streaming /\ ~stopReq /\ ~stopClicked
  /\ stopReq' = TRUE /\ stopClicked' = TRUE
  /\ stopRun' = slotRun
  /\ frozen' = IF Fix("freeze_on_stop") /\ slotRun # None THEN frozen \cup {slotRun} ELSE frozen
  /\ abortReq' = IF slotRun # None THEN [st |-> "sent", r |-> slotRun, res |-> None, back |-> {}, hit |-> {}] ELSE abortReq
  /\ ctl' = IF slotRun # None THEN Append(ctl, AbortTag) ELSE ctl
  /\ UNCHANGED <<server, composer, streaming, follow, slotRun, chips, steering, pendingSteers, rowsLocal,
                 rowsRun, seenIntake, rendered, endChain, resumeWanted, lastAborted, idleEvent, turnReq, sendReq, steerReq, activeReq,
                 stopAcked, ackRendered, postStop, lateRuns, stopMissed>>

ServerAbort ==
  LET r == abortReq.r
      hit == IF Break("stop_only_target") THEN {r} ELSE LiveRuns
      back == IF Fix("stop_returns_inputs")
              THEN {Input(x) : x \in {y \in hit : status[y] = "pending" /\ y # "A"}}
                   \cup UNION {SteerSignals(x) : x \in hit}
              ELSE {}
      targetGone == status[r] \in Terminal \/ status[r] \in Gone
  IN
  /\ abortReq.st = "sent" /\ Serial(AbortTag)
  /\ IF targetGone /\ ~Fix("stop_terminal_target")
     THEN /\ abortReq' = [abortReq EXCEPT !.st = "done", !.res = IF status[r] \in Gone THEN "not_found" ELSE "terminal"]
          /\ stopMissed' = (stopMissed \/ LiveRuns # {})
          /\ UNCHANGED <<status, sig>>
     ELSE /\ sig' = [x \in RunIds |->
                IF x \in hit
                THEN Append(IF Fix("stop_returns_inputs") THEN Keep(sig[x], LAMBDA e : e.k # "steer") ELSE sig[x],
                            [k |-> "abort", m |-> 0, seen |-> FALSE])
                ELSE sig[x]]
          /\ status' = [x \in RunIds |-> IF x \in hit /\ status[x] = "pending" THEN "withdrawn" ELSE status[x]]
          /\ abortReq' = [abortReq EXCEPT !.st = "done", !.res = IF hit = {} THEN "terminal" ELSE "ok",
                                          !.back = back, !.hit = hit]
          /\ UNCHANGED stopMissed
  /\ UNCHANGED <<order, hq, aborted, text, intakes, delivered, notifyWorking, client, turnReq, sendReq,
                 steerReq, activeReq, ctl, stopClicked, stopRun, stopAcked, ackRendered, postStop, lateRuns>>

ClientAbortReply ==
  /\ abortReq.st = "done"
  /\ abortReq' = NoAbort
  /\ ctl' = Drop(AbortTag)
  /\ stopAcked' = (stopAcked \/ abortReq.res = "ok")
  /\ ackRendered' = IF ~stopAcked /\ abortReq.res = "ok" THEN rendered[abortReq.r] ELSE ackRendered
  /\ composer' = composer \cup abortReq.back
  /\ chips' = chips \ abortReq.back
  /\ rowsLocal' = [m \in Msgs |-> IF m \in abortReq.back THEN 0 ELSE rowsLocal[m]]
  /\ rowsRun' = {r \in rowsRun : Input(r) \notin abortReq.back}
  /\ steering' = steering \ abortReq.back
  /\ frozen' = IF Fix("freeze_on_stop") THEN frozen \cup abortReq.hit ELSE frozen
  /\ UNCHANGED <<server, streaming, follow, slotRun, stopReq, pendingSteers, seenIntake,
                 rendered, endChain, resumeWanted, lastAborted, idleEvent, turnReq, sendReq, steerReq, activeReq, stopClicked, stopRun,
                 postStop, lateRuns, stopMissed>>

Dispatch ==
  /\ Running = {}
  /\ FirstLive # None
  /\ LET r == FirstLive IN
     /\ status' = [status EXCEPT ![r] = "running"]
     /\ delivered' = IF Input(r) # 0 THEN [delivered EXCEPT ![Input(r)] = @ + 1] ELSE delivered
  /\ UNCHANGED <<order, sig, hq, aborted, text, intakes, notifyWorking, client, reqs, ghosts>>

HEmit(r) ==
  /\ status[r] = "running" /\ ~aborted[r] /\ text[r] < MaxText
  /\ text' = [text EXCEPT ![r] = @ + 1]
  /\ UNCHANGED <<status, order, sig, hq, aborted, intakes, delivered, notifyWorking, client, reqs, ghosts>>

HDrain(r) ==
  /\ status[r] = "running"
  /\ \E i \in DOMAIN sig[r] : ~sig[r][i].seen
  /\ LET i == CHOOSE i \in DOMAIN sig[r] : ~sig[r][i].seen /\ \A j \in DOMAIN sig[r] : j < i => sig[r][j].seen
         s == sig[r][i]
     IN /\ sig' = [sig EXCEPT ![r][i].seen = TRUE]
        /\ IF s.k = "abort"
           THEN /\ aborted' = [aborted EXCEPT ![r] = TRUE]
                /\ hq' = [hq EXCEPT ![r] = {}]
           ELSE /\ hq' = IF aborted[r] THEN hq ELSE [hq EXCEPT ![r] = @ \cup {s.m}]
                /\ UNCHANGED aborted
  /\ UNCHANGED <<status, order, text, intakes, delivered, notifyWorking, client, reqs, ghosts>>

HIntake(r, m) ==
  /\ status[r] = "running" /\ ~aborted[r] /\ m \in hq[r]
  /\ Fix("stop_returns_inputs") => m \in SteerSignals(r)
  /\ hq' = [hq EXCEPT ![r] = @ \ {m}]
  /\ intakes' = [intakes EXCEPT ![r] = @ \cup {m}]
  /\ delivered' = [delivered EXCEPT ![m] = @ + 1]
  /\ sig' = IF Break("skip_ack") THEN sig ELSE [sig EXCEPT ![r] = Keep(@, LAMBDA e : ~(e.k = "steer" /\ e.m = m))]
  /\ UNCHANGED <<status, order, aborted, text, notifyWorking, client, reqs, ghosts>>

HFinish(r) ==
  /\ status[r] = "running" /\ ~aborted[r]
  /\ status' = [status EXCEPT ![r] = "done"]
  /\ hq' = [hq EXCEPT ![r] = {}]
  /\ idleEvent' = (idleEvent \/ Keep(order, LAMBDA x : x # r /\ status[x] \in Live) = <<>>)
  /\ UNCHANGED <<order, sig, aborted, text, intakes, delivered, notifyWorking, composer, streaming, follow, slotRun,
                 stopReq, chips, steering, pendingSteers, rowsLocal, rowsRun, seenIntake, rendered, endChain, frozen,
                 resumeWanted, lastAborted, reqs, ghosts>>

HStopped(r) ==
  /\ status[r] = "running" /\ aborted[r]
  /\ status' = [status EXCEPT ![r] = "stopped"]
  /\ idleEvent' = (idleEvent \/ Keep(order, LAMBDA x : x # r /\ status[x] \in Live) = <<>>)
  /\ UNCHANGED <<order, sig, hq, aborted, text, intakes, delivered, notifyWorking, composer, streaming, follow, slotRun,
                 stopReq, chips, steering, pendingSteers, rowsLocal, rowsRun, seenIntake, rendered, endChain, frozen,
                 resumeWanted, lastAborted, reqs, ghosts>>

OrphanDrain(r) ==
  /\ status[r] \in Terminal
  /\ SteerSignals(r) # {}
  /\ DrainEffect(r)
  /\ UNCHANGED <<hq, aborted, text, intakes, delivered, client, reqs, ghosts>>

Frozen(r) == r \in frozen
ShownText(r) == IF Frozen(r) THEN rendered[r] ELSE text[r]
ObserveEnabled ==
  /\ streaming /\ follow # None
  /\ \/ ShownText(follow) # rendered[follow]
     \/ intakes[follow] # seenIntake[follow]
     \/ status[follow] \in Terminal \cup {"withdrawn", "moved"}
NotLanded(st, r) == {m \in st : m \notin intakes[r] /\ rowsLocal[m] = 0 /\ \A x \in rowsRun : Input(x) # m
                                /\ \A y \in RunIds : y # r => m \notin seenIntake[y]}
LateOutput(r) == stopAcked /\ r # stopRun /\ Input(r) \notin postStop

Observe ==
  LET r == follow
      shown == ShownText(r)
      ended == status[r] \in Terminal \cup {"withdrawn", "moved"}
  IN
  /\ ObserveEnabled
  /\ rendered' = [rendered EXCEPT ![r] = shown]
  /\ lateRuns' = IF shown > rendered[r] /\ LateOutput(r) THEN lateRuns \cup {r} ELSE lateRuns
  /\ seenIntake' = [seenIntake EXCEPT ![r] = intakes[r]]
  /\ IF ended
     THEN /\ streaming' = FALSE /\ follow' = None /\ slotRun' = None /\ stopReq' = FALSE
          /\ steering' = IF Fix("steer_rows_until_landed") THEN NotLanded(steering, r) ELSE {}
          /\ endChain' = IF status[r] = "done" THEN "refresh" ELSE "active"
          /\ lastAborted' = (status[r] # "done")
     ELSE /\ steering' = IF Fix("steer_rows_until_landed") THEN NotLanded(steering, r) ELSE steering \ intakes[r]
          /\ UNCHANGED <<streaming, follow, slotRun, stopReq, endChain, lastAborted>>
  /\ UNCHANGED <<server, composer, chips, pendingSteers, rowsLocal, rowsRun, frozen, resumeWanted, idleEvent, reqs,
                 stopClicked, stopRun, stopAcked, ackRendered, postStop, stopMissed>>

Refresh ==
  /\ endChain = "refresh" /\ ~streaming
  /\ rowsLocal' = [m \in Msgs |-> 0]
  /\ rowsRun' = ServerRows
  /\ seenIntake' = intakes
  /\ endChain' = "active"
  /\ steering' = IF Fix("steer_rows_until_landed")
                  THEN {m \in steering : \A x \in ServerRows : Input(x) # m /\ \A y \in RunIds : m \notin intakes[y]}
                  ELSE steering
  /\ UNCHANGED <<server, composer, streaming, follow, slotRun, stopReq, chips, pendingSteers,
                 rendered, frozen, resumeWanted, lastAborted, idleEvent, reqs, ghosts>>

StartFollowNext ==
  /\ endChain = "active" /\ activeReq.st = None
  /\ endChain' = "idle"
  /\ activeReq' = [NoActive EXCEPT !.st = "sent", !.why = "follow", !.chipsAt = chips]
  /\ UNCHANGED <<server, composer, streaming, follow, slotRun, stopReq, chips, steering, pendingSteers,
                 rowsLocal, rowsRun, seenIntake, rendered, frozen, resumeWanted, lastAborted, idleEvent, turnReq, sendReq, steerReq, abortReq, ctl, ghosts>>

NotifiedWorking ==
  /\ notifyWorking
  /\ notifyWorking' = FALSE
  /\ resumeWanted' = (resumeWanted \/ ~streaming)
  /\ UNCHANGED <<status, order, sig, hq, aborted, text, intakes, delivered, composer, streaming, follow, slotRun,
                 stopReq, chips, steering, pendingSteers, rowsLocal, rowsRun, seenIntake, rendered, endChain,
                 frozen, reqs, lastAborted, idleEvent, ghosts>>

ResumeIfIdle ==
  /\ resumeWanted /\ activeReq.st = None
  /\ resumeWanted' = FALSE
  /\ activeReq' = IF ~streaming THEN [NoActive EXCEPT !.st = "sent", !.why = "resume", !.chipsAt = chips] ELSE activeReq
  /\ UNCHANGED <<server, composer, streaming, follow, slotRun, stopReq, chips, steering, pendingSteers,
                 rowsLocal, rowsRun, seenIntake, rendered, endChain, frozen, turnReq, sendReq, steerReq, abortReq,
                 ctl, lastAborted, idleEvent, ghosts>>

ServerActive ==
  /\ activeReq.st = "sent"
  /\ activeReq' = [activeReq EXCEPT !.st = "done", !.live = FirstLive, !.queued = QueuedAfter(FirstLive),
                                    !.rows = ServerRows]
  /\ UNCHANGED <<server, client, turnReq, sendReq, steerReq, abortReq, ctl, ghosts>>

ClientActiveReply ==
  LET live == activeReq.live
      withInput == IF Input(live) # 0 THEN {live} ELSE {}
      stale == Fix("fresh_queue_sync") /\ (chips # activeReq.chipsAt \/ ctl # <<>>)
      synced == IF stale THEN chips ELSE Elems(activeReq.queued)
      attach == ~streaming /\ live # None /\ live \notin frozen
  IN
  /\ activeReq.st = "done"
  /\ activeReq' = NoActive
  /\ resumeWanted' = (resumeWanted \/ stale)
  /\ chips' = IF streaming /\ activeReq.why = "follow" THEN chips ELSE synced
  /\ IF attach
     THEN /\ streaming' = TRUE /\ follow' = live /\ slotRun' = live /\ stopReq' = FALSE
          /\ lastAborted' = FALSE
          /\ IF activeReq.why = "resume" /\ ~lastAborted
             THEN /\ rowsLocal' = [m \in Msgs |-> 0]
                  /\ seenIntake' = intakes
                  /\ rowsRun' = ServerRows \cup withInput
             ELSE /\ rowsRun' = rowsRun \cup withInput
                  /\ UNCHANGED <<rowsLocal, seenIntake>>
          /\ steering' = IF Fix("steer_rows_until_landed") THEN steering \ {Input(x) : x \in rowsRun'} ELSE steering
     ELSE /\ UNCHANGED lastAborted
          /\ rowsRun' = IF Fix("sync_includes_transcript") /\ ~streaming THEN rowsRun \cup activeReq.rows ELSE rowsRun
          /\ steering' = IF Fix("sync_includes_transcript") /\ Fix("steer_rows_until_landed") /\ ~streaming
                          THEN steering \ {Input(x) : x \in activeReq.rows} ELSE steering
          /\ UNCHANGED <<streaming, follow, slotRun, stopReq, rowsLocal, seenIntake>>
  /\ UNCHANGED <<server, composer, pendingSteers, rendered, endChain, frozen, turnReq, sendReq, steerReq,
                 abortReq, ctl, idleEvent, ghosts>>

IdleRefresh ==
  /\ idleEvent
  /\ idleEvent' = FALSE
  /\ IF ~streaming /\ ~lastAborted
     THEN /\ rowsLocal' = [m \in Msgs |-> 0]
          /\ rowsRun' = ServerRows
          /\ seenIntake' = intakes
          /\ steering' = IF Fix("steer_rows_until_landed")
                          THEN {m \in steering : \A x \in ServerRows : Input(x) # m /\ \A y \in RunIds : m \notin intakes[y]}
                          ELSE steering
     ELSE UNCHANGED <<rowsLocal, rowsRun, seenIntake, steering>>
  /\ UNCHANGED <<server, composer, streaming, follow, slotRun, stopReq, chips, pendingSteers,
                 rendered, endChain, frozen, resumeWanted, lastAborted, reqs, ghosts>>

Next ==
  \/ \E m \in Msgs, pref \in BOOLEAN : SubmitWhileStreaming(m, pref)
  \/ \E m \in Msgs : \/ SubmitIdle(m) \/ ServerTurn(m) \/ ServerSend(m) \/ ClientSendReply(m)
                     \/ ClientTurnReply(m) \/ ClickChipSteer(m) \/ ServerSteerCheck(m) \/ ServerSteerCte(m)
                     \/ ServerSteerAfter(m) \/ ClientSteerReply(m)
  \/ ClickStop \/ ServerAbort \/ ClientAbortReply
  \/ Dispatch
  \/ \E r \in RunIds : \/ HEmit(r) \/ HDrain(r) \/ HFinish(r) \/ HStopped(r) \/ OrphanDrain(r)
                       \/ \E m \in Msgs : HIntake(r, m)
  \/ Observe \/ Refresh \/ IdleRefresh \/ StartFollowNext \/ NotifiedWorking \/ ResumeIfIdle \/ ServerActive \/ ClientActiveReply

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in [RunIds -> {"none", "pending", "running", "done", "stopped", "withdrawn", "moved"}]
  /\ streaming \in BOOLEAN /\ stopReq \in BOOLEAN
  /\ composer \subseteq Msgs /\ chips \subseteq Msgs /\ steering \subseteq Msgs

StopFreezesReply == stopAcked => rendered[stopRun] <= ackRendered

NoTurnAfterStop == lateRuns = {}

StopNotIgnored == ~stopMissed

Traced(m) ==
  \/ m \in composer
  \/ delivered[m] > 0
  \/ turnReq[m].st # None \/ sendReq[m] # None \/ steerReq[m].st # None
  \/ m \in abortReq.back
  \/ \E r \in RunIds : \/ Input(r) = m /\ status[r] \in Live
                       \/ m \in SteerSignals(r)
                       \/ m \in hq[r]

NoSilentLoss == \A m \in Msgs : Traced(m)

DeliveredOnce == \A m \in Msgs : delivered[m] <= 1

DisplayCount(m) == RowCount(m) + (IF m \in VisibleChips THEN 1 ELSE 0) + (IF m \in steering THEN 1 ELSE 0)

ShownOnce == \A m \in Msgs : DisplayCount(m) <= 1

Shown(m) == \/ m \in VisibleChips \/ m \in pendingSteers \/ m \in steering \/ RowCount(m) > 0
            \/ Fix("optimistic_submit") /\ turnReq[m].st # None

SentIsShown == \A m \in Msgs : m \notin composer => Shown(m)

ServerSettled ==
  /\ \A r \in RunIds : status[r] = "running" => (~aborted[r] /\ \A i \in DOMAIN sig[r] : sig[r][i].seen)
  /\ \A r \in RunIds : status[r] \in Terminal => SteerSignals(r) = {}
  /\ ~(Running = {} /\ FirstLive # None)

ClientSettled ==
  /\ \A m \in Msgs : turnReq[m].st = None /\ sendReq[m] = None /\ steerReq[m].st = None
  /\ abortReq.st = None /\ activeReq.st = None /\ endChain = "idle" /\ ~notifyWorking /\ ~resumeWanted /\ ~idleEvent
  /\ ~ObserveEnabled

ControlsMatchServer ==
  ServerSettled /\ ClientSettled =>
    /\ streaming = (LiveRuns # {})
    /\ streaming => follow = FirstLive
    /\ VisibleChips = Elems(QueuedAfter(FirstLive))
=============================================================================
