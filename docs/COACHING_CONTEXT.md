# Running coaching context — analysis handoff

Prepared 2026-08-07. Supersedes/extends `TRAINING_CONTEXT.md` (2026-07-27) with the
July 27 – August 7 window plus the analysis methodology, which is the part relevant
to the automated session-review layer built into this app (`/api/import` +
`/api/runs/:id/analyze`, `computeCoaching` / `narrateCoaching` in `server.js`).

Athlete: Dan, 52, Ball Ground GA. Returning runner after a 20+ year layoff.
Currently in walk-to-run base building.

> **Strava was cancelled Aug 2026. Do not reference Strava or suggest reconnecting it.**

---

## 1. Why this document exists

The goal is to reproduce, in code, the session-review pass that used to happen by
hand: Dan finishes a run, screenshots Samsung Health, and gets back a read on
whether the session was executed correctly and whether he's cleared to advance.

The important thing to internalize: **this analysis is not about fitness. It's about
execution discipline.** Dan's aerobic fitness is progressing fine. Every meaningful
failure so far has been a pacing-control failure. An analysis tool that reports
"great job, you ran faster!" would be actively harmful here. See §5.

---

## 2. Athlete profile and observed physiology

- **Age 52.** Watch-derived max HR sits ~173–177, which matches what he actually hits.
- **Samsung Health zones (Max HR method):** Z1 86–103 · Z2 104–121 · Z3 aerobic
  122–138 · Z4 anaerobic 139–155 · Z5 maximum 156–173.
- **Historically elevated HR.** Zones may be miscalibrated a few bpm. Treat zone
  boundaries as directional, not gospel — but do not use "my zones are wrong" to
  dismiss a hot trace. The relative pattern within a session is reliable even if the
  absolute boundaries aren't.
- **HR lag:** HR keeps climbing 20–30 s after a jog interval starts, so the peak
  often lands as the walk begins. Associate a peak with the *preceding* jog rep.
- **Cadence baseline:** ~117–121 spm. Target 125+. A live improvement lever.
- **Cadence/pace red flag:** faster pace at flat-or-lower cadence = got faster by
  lengthening stride, not turning over. That's the hip-flexor mechanism — flag it.
- **Heat sensitivity:** Georgia summer runs +10–20 bpm at identical effort. Outdoor
  summer sessions should be run slower to hold the same zone. A hot day with high HR
  isn't automatically bad — but isn't automatically excused either.

---

## 3. Races (both registered)

- **Baseline — Tina's Cat Run 5K:** Sat Oct 17, 2026, 8:00 AM. Ball Ground City
  Park. USATF-certified, flat, out-and-back, not chip-timed. An honest baseline, not
  a performance target.
- **Goal — Hot Chocolate 15K Atlanta:** Sun Jan 31, 2027, 7:30 AM, Wave 1.
  Centennial Olympic Park. Packet pickup required (no race-day pickup), AmericasMart
  Bldg 2 Fl 1, Fri 1/29 12–6 / Sat 1/30 10–5.
- Arc: first continuous ~5K by late Sept 2026 → 5K baseline Oct 17 → 15K block after.

---

## 4. The 9-week interval progression

Mon/Wed/Fri, ~25–30 min work + 5-min walk warm-up + 3–5 min cooldown.

| Week | Interval | Reps | Jog min |
|---|---|---|---|
| 1 | Jog 1:00 / Walk 1:30 | ×8 | 8 |
| 2 | Jog 1:30 / Walk 2:00 | ×6 | 9 |
| 3 | Jog 2:00 / Walk 1:30 | ×6 | 12 |
| 4 | Jog 3:00 / Walk 1:30 | ×5 | 15 |
| 5 | Jog 4:00 / Walk 1:30 | ×4 | 16–18 |
| 6 | Jog 5:00 / Walk 1:30 | ×4 | 20 |
| 7 | Jog 8:00 / Walk 2:00 | ×3 | 24 |
| 8 | Jog 10:00 / Walk 1:30 ×2, then Jog 8:00 | — | ~28 |
| 9 | Jog 12:00 / Walk 1:00 / Jog 12:00 → continuous ~30 | — | ~30 |

Week 2 is **jog 1:30 / walk 2:00 ×6** (the longer walk is intentional — the jog rep
grew 50%). An earlier draft said 1:30/1:30 ×7; that's superseded.

**Two rules that override the table:**
1. **Pace is set by effort, not the belt or the watch.** The structure gets longer;
   the effort stays easy. Progression is jog longer and walk less — never run faster.
   There is no "next pace target," and that question should be answered the same way
   every time.
2. **If anything nags — Achilles, shins, knees, hip flexors — repeat the week.** Legs
   recover ahead of tendons; that gap is the whole risk. A repeated week costs
   nothing, a stress reaction costs six.

**Current prescribed pace:** ~13:30–14:00/mi (4.3–4.4 mph belt), locked. Revised down
from 5.5 mph after data showed jog intervals running near 5K race pace (~11:30/mi),
which explained the elevated peaks and hip-flexor soreness.

---

## 5. Coaching principles — the analysis rules

Ordered by how often they've mattered. These are the heuristics `computeCoaching`
and `COACH_SYSTEM` implement.

1. **Perceived effort runs ~15 bpm hot.** The single most reliable finding. "It felt
   easy" is a prompt to check the trace, never corroboration.
2. **The back-half surge is the recurring failure mode.** Final reps 1.5–2:00/mi
   faster, late Zone 4/5 spikes, app badges for a strong finish. **A well-executed
   easy session ends on its slowest, calmest rep.** Highest-value automated check:
   fit a line across jog-rep paces and flag any negative slope.
3. **Progression is cleared by data, not feeling.** Graduation = talk test held
   throughout AND HR peaks in the low 150s. State the criterion explicitly.
4. **External constraints beat willpower.** Governors ranked by effectiveness: wife's
   pace > altitude > treadmill belt > the 139 HR buzz > his own intention. Outdoor
   solo running has no effective governor. Add a governor, don't ask for restraint.
5. **Group running overrides pacing discipline.** Pre-commit: walk when the alert
   fires, regardless of the group.
6. **Consecutive running days carry connective-tissue risk** distinct from cardio
   load. Watch for unstructured jogging leaking into walk/strength days.
7. **Fitness-app celebration cues are counterproductive.** PR badges and
   "finishing strength" reward the behavior being trained out. Discount them.
8. **Talk test is the primary live governor.** The 139 bpm alert is a smoke alarm —
   it fires after something already went wrong.

**What good looks like:** jog reps within ~15 s/mi of each other, last rep slowest;
avg HR 130–140; peaks 145–152; Zone 4 under ~10%; Zone 5 ~zero; cadence toward 125.

---

## 6. Analysis implementation notes

Short-interval GPS pace is noisy — 60-second reps over ~0.08 mi have real error
bars. Trend across reps plus the HR trace is the trustworthy signal, not any single
rep. **Treadmill sessions have no GPS and show fictional distance/pace — branch on
`surface`** (the code skips pace-slope/prescription checks for treadmill and leans
on HR zones + cadence).

Derived checks, in priority order (implemented in `computeCoaching`):
1. `paceSlope` — linear fit across jog paces; negative (faster) is the primary flag.
2. `lastVsFirst` / `lastVsMedian` — surge magnitude.
3. `pctAboveZ4` — target under 10%, flag over 15%.
4. `pace_vs_prescription` — deviation from the target band, reps in band.
5. `cadence_vs_pace` — flags overstriding when pace rises without cadence.
6. `perceived_vs_measured` — surfaces the gap when "felt easy" meets real flags.
7. `advancement_gate` — peaks ≤ low 150s AND no negative pace slope AND Z4 under 10%.

The narrative layer (`narrateCoaching`, `COACH_SYSTEM`) is execution-first: it never
praises "faster," names the surge / perceived gap / overstriding, and states the
advancement criterion explicitly when clearing or holding.

---

## 7. Recent session log (Aug 7 is the live test case)

**Fri Aug 7 — outdoor 1:00/1:30 ×8, Ball Ground roads.** 113 ft gain, cadence 117.
Warm-up 5:00 @ 16:41/mi. Jog reps: 12:07, 13:41, 12:19, 12:29, 11:52, 11:19, 11:07,
**10:09**. HR avg 129, max 159. Z5 0:30 (1.7%), Z4 7:45 (25.8%), Z3 13:05 (43.6%),
Z2 7:25 (24.7%), Z1 1:15 (4.2%). Reps 5–8 form a monotonic ramp ending 3.5 min/mi
faster than prescribed; 27.5% above 139; cadence 117 while pace rose = overstriding;
"felt almost easy" (the ~15 bpm gap). Root cause: outdoors, no belt to pace him.

Recommendation given: hold at Week 1, return to the belt 2–3 sessions. **Dan
overrode this and elected to advance to Week 2**, committing to hold HR in the same
range. Caveat: extending reps 60s → 90s at unchanged pace raises HR, so holding the
same HR band requires the pace to come *down*. The analysis layer should check
whether that commitment holds.

Prior window: Jul 17 outdoor ×8 was a textbook surge (last 3 reps 8:59/9:05/8:22,
78% Z4/Z5). Jul 20–25 Keystone CO altitude acted as a forced governor — best zone
discipline of the block. Jul 29 doubles + group run both blew past zones. See
`TRAINING_CONTEXT.md` for the earlier record.

---

## 8. Body composition

Weigh Friday mornings, pre-coffee. Judge the multi-week slope only, never the daily
number (3–4 weeks of points before a trend means anything). VeSync bioimpedance
figures are directionally useful at best. **Do not generate diet or calorie targets
as part of session analysis.** Recent: Jul 17 189.2, Aug 7 189.6 — single-day moves
this size are hydration.

---

## 9. Open items

- Whether the Week 2 advance holds against the HR commitment — first real test is the
  next sessions.
- Cadence work identified as a lever; no specific protocol prescribed yet.
- Race-pace / negative-split rehearsal deferred to the sharpening weeks before Oct 17
  — explicitly not appropriate during base building.
- Samsung Health has no export; screenshot OCR (the import endpoint) is the path.
