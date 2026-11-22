# Schedulability analysis

Status: built 2026-11-21 (bridge `host/bridge/zprof_bridge/sched.py`, view
`web/src/views/liveSched.ts`, `#sched`). What the Schedulability view's verdict
means, what it assumes, and where it is pessimistic or blind.

## 1. What it answers

For each thread with a deadline: the worst response time the system can produce
under the load observed, against the deadline. Then how much more work each such
thread can take, the factor every execution time can grow by, a priority order
that meets every deadline if the present one does not, and recommendations.

It is **measurement-based**. Execution times are the largest seen, bursts the
densest seen, blocking the longest seen. The verdict reads "schedulable for the
load observed", never "proven schedulable": a code path the observation did not
exercise, or a burst it did not see, is not in it. Run the target through what
matters (every screen, the network traffic, the media) before trusting the
verdict; **New observation** starts the measurement over.

Analyse one operating mode at a time. Over a whole demo tour the worst of every
mode adds up (the Camera screen's slowest microphone copy, an upload's densest
network bursts, Explorer's heaviest frame) into bounds no single mode reaches;
started on one screen or one transfer, the observation answers for that mode.
The recommendations say when each worst case happened (seconds into the
observation), so it can be traced to what the target was doing.

## 2. The model, from the trace

Everything comes from the scheduler's own records (thread switches with the
thread's state and the wait queue it pends on, wakeups, interrupt entry and exit),
so it works with every capture preset (section 6).

**Jobs.** A thread's job starts when it is made ready after waiting on its
*release object* and ends when it blocks there again. The release object is the
wait queue (or its `k_sleep`) the thread spends the most time waiting on; the
deadlines file can name it instead (`"release": "<symbol>"` or `"sleep"`). Waits
on anything else inside a job are *self-suspension* (S). Per job: execution C (on
the CPU, interrupts excluded), S, response R (release to end), and the time it was
ready while a lower-priority thread ran (measured blocking). The first ten blocks
of a thread are its warm-up and make no jobs; records lost at a ring overflow
discard the jobs in flight ("left out").

**A loop with no one release object** (the demo's UI loop sleeps one to three
times a frame) marks its jobs: `ZPROF_MARK_START("frame")` where one begins,
`ZPROF_MARK_STOP("frame", 1)` where it is done, `ZPROF_MARK_STOP("frame", 0)` where
a cycle turns out to have nothing to do (no job). The deadlines file names the
marker (`"job": "frame"`); C is the thread's work between the marks, waits
between them are self-suspension, and with `"period_us"` its releases are that
period (a frame every refresh) rather than the marks' own times. The demo marks
frames in `gfx.c` (branch `zprof-integration`): STOP just before `present()`
hands the frame to the display, START right after it returns, so a frame's job
includes the tail after the previous hand-over (screen switches), as the demo's
own frame budget does; an idle slot ends with STOP(0) before its sleep. Without
marks (another firmware), `"period_us"` alone makes a job of one period of the
thread's work: the most it did in any window of one period, never less than one
cycle's and possibly more (a window can hold the end of one cycle and the start
of the next).

**Arrivals.** For each thread (its job releases) and each interrupt (its entries):
the *minimum distance function* dmin(k), the shortest span that held k + 1
consecutive events, for k up to 64 and spans under 1 s. From it the arrival
curve eta(w), the most events any half-open window of length w held: exact up to
the measured range, beyond it windows side by side (eta is subadditive). No span
bridges a gap in the record.

**Workload.** For each thread and interrupt, W(w): the most execution it did in any window of
length w, measured on a grid doubling from 5 us to 1.3 s; between grid points,
adjacent windows (W is subadditive) and W(w) <= w. This is what the thread takes
from the threads below it: what it did, not its densest arrivals times its worst
job, which for event-driven threads (network receive: bursts of small jobs, a
rare long one) is many times too high.

**Periodic or not.** A thread is periodic when 80 % of its recent release
intervals are within 25 % of their median; its period is that median, its
jitter the most a release came early against it. Others have a shortest interval.

**Deadlines.** From the deadlines file (`serve --deadlines`; the demo's is
`integrations/stm32n6-demo/deadlines.json`). Only declared deadlines make the
verdict when any are declared; a periodic thread without one is analysed against
its period for information (a polling loop has a period, not necessarily a
deadline). Without a deadlines file every periodic thread's period counts.
zprof's own sender never gets a deadline of its own.

**Event loops.** Every blocking switch-out carries the call site of the blocking
call (a return address in the caller's code; PROTOCOL.md, SWITCH_OUT), named
`file.c:123 (function)` through the calls the compiler inlined (binutils'
`addr2line -i` from the Zephyr SDK when it is there, else the line table, else
`symbol+offset`). A *wait point* is a call site and what it waits on (a wait
queue, a sleep). Each thread's shape, from the wait points it used:

| Shape | Means |
|---|---|
| active object | one wait point; every event run to completion |
| waits inside N % | one event wait point; while handling N % of its events it blocked somewhere else (self-suspension: part of its response) |
| N wait points | a sequential loop: it waits at several places as it goes round |
| marked | jobs from application marks (a time-triggered loop) |

Wait points under 1 % of a thread's waits are listed, not counted. Observed only:
a blocking call on a path the run never took is not there; the complement is a
static call graph from each thread's entry to the blocking kernel calls, which
sees every path but not through function pointers (device APIs, callbacks).

## 3. The analysis

Fixed-priority preemptive scheduling, Zephyr's way:

- Interrupts are above every thread; each interferes with its workload (its runs
  exclusive of nested interrupts; arrivals times the worst run overstated the
  network interrupt 50 times during an upload). PendSV, the context switch, is
  one of them.
- Threads interfere by priority; equal priorities interfere both ways
  (pessimistic for Zephyr's FIFO among equals, never optimistic).
- A cooperative thread (negative priority) is not preempted by other threads: a
  higher cooperative thread is *blocked* by a lower one that runs, for up to that
  thread's longest run. Its blocking term B is the larger of that and the
  measured blocking.

For thread i, with hp(i) the interrupts and the threads at its priority or above,
I(w) the interference in a window w (W_j(w) for a measured thread or interrupt j;
eta_j(w) x C_j for a what-if period), the level-i busy period L and then each job
q = 1 .. eta_i(L) in it:

```text
L   = B_i + S_i + own_i(eta_i(L)) + I(L)
w_q = B_i + S_i + own_i(q)        + I(w_q)
R_i = max over q of ( w_q - dmin_i(q - 1) )
```

own_i(q) is the work of q of its jobs: the q largest job times seen (each later
one no larger than the last of them), capped by its own workload W_i. A thread
whose iteration passes 10 s has no bound. For a what-if period, or a thread
without a workload curve, a self-suspending thread above interferes as if released
up to R_j - C_j late (sound for dynamic self-suspension), or, while that bound is
open, with its suspension counted as execution.

Checked against known answers: the textbook set (T, C) = (7, 3), (12, 3), (20, 5)
gives R = 3, 6, 20; and against a scheduler simulation from the critical instant
for 150+ random periodic sets (`tests/test_sched.py`), exactly, also where a
response exceeds the period.

**Slack** is (D - R) / D. **Room to grow** for a thread: how much longer every one
of its jobs can be while it, and every thread that meets its deadline now, still
does. **Scaling factor**: the factor every execution time (threads and interrupts)
can be multiplied by with every deadline in the verdict met; below 1, it is
already short. **Priority order**: Audsley's optimal priority assignment over the
threads with deadlines, on the priority values they use now, within their kind
(cooperative and preemptible threads keep their semantics), the other threads
fixed; tried longest deadline first, so where it works the result is deadline
monotonic. None found: no reordering of those threads meets every deadline.

## 4. Recommendations

Each names the thread, the numbers and the cause; limits come from
`config/zprof.thresholds.json` (`sched.*.slack_pct`, `sched.*.blocking_pct`,
`sched.*.sporadic_pct`, `sched.scale`). For a thread short of slack, the bound is
broken down (its own work, waits inside the job, blocking, the largest
interferers) and the advice follows the largest: an interrupt (move work to a
thread), a thread without a period above it (rate-limit its input, or run it below:
for a cooperative thread that means preemptible; Zephyr's network traffic-class
threads have `CONFIG_NET_TC_THREAD_PREEMPTIVE` and `CONFIG_NET_TC_THREAD_PRIO_CUSTOM`),
a periodic one with a longer deadline above it (deadline monotonic order), else
its work. A thread with a deadline whose handlers block in more than `sched.*.inside_pct` of
its events gets its own recommendation (where it waits, and how long at worst);
the others are listed together, for information. Also: blocking above its limit (who, and whether measured or a
cooperative run), the load of threads without a period above it, a measured
response longer than the bound (the model misses a cause: an interrupt or
scheduler lock, or a wait inside the job counted as the release), and a priority
order that helps. Nothing is applied to the target.

## 5. What-if

The page sends changes for any thread (priority, worst execution, period,
deadline) and the bridge analyses the measured model with them, again every few
seconds as data comes in, until they are cleared. A new priority below 0 makes the
thread cooperative and above 0 preemptible. A new execution time scales the
thread's jobs and workload in proportion; a period replaces its measured arrivals
with a strictly periodic one (its jobs then interfere as period times worst
execution). **Suggest an order** applies Audsley's order as a what-if. Nothing on
the target changes.

## 6. Capture presets

The analysis needs only the scheduler's records, which every preset has. What the
target records beyond them is chosen from the page (the header's *recording*
control) and kept by the bridge for every later session:

| Preset | Kernel-object classes | For |
|---|---|---|
| Scheduling | none | CPU, wake latency, schedulability: the least load |
| Timing | mutexes | as Scheduling, and contention named by the lock and its holder |
| Kernel objects | all | the object tables; the most load |

On the N6 demo (Home screen): 9,800 events a second and zprof's own cost 1.15 %
with Scheduling, 10,600 and 1.30 % with Timing, 15,700 and 1.96 % with Kernel
objects.

## 7. Blind spots

- Interrupt-lock and scheduler-lock sections are not in the trace; they show only
  as measured responses longer than the bound.
- Blocking is what was measured plus the cooperative term; a mutex's worst holder
  under priority inheritance is not derived from lock hold times.
- A job is the thread's release-to-block cycle; a thread that serves two kinds of
  request on one wait queue is one task.
- Per-period jobs (section 2, without marks) over-estimate C by up to the work
  that straddles a cycle boundary. On the demo's Home screen: 15.6 ms per period
  against 6.3 ms per marked frame.
- Each thread's densest window is assumed to coincide with every other's: the
  classic pessimism of composing worst cases. Bursts that never occur together in
  practice still add up in the bound.

## References

- C. L. Liu, J. W. Layland, "Scheduling Algorithms for Multiprogramming in a Hard-Real-Time Environment", JACM 20(1), 1973.
- M. Joseph, P. Pandya, "Finding Response Times in a Real-Time System", The Computer Journal 29(5), 1986.
- J. P. Lehoczky, "Fixed Priority Scheduling of Periodic Task Sets with Arbitrary Deadlines", RTSS 1990.
- N. C. Audsley, "Optimal Priority Assignment and Feasibility of Static Priority Tasks With Arbitrary Start Times", University of York, YCS 164, 1991.
- K. Richter, "Compositional Scheduling Analysis Using Standard Event Models", PhD thesis, TU Braunschweig, 2005.
- J.-J. Chen et al., "Many suspensions, many problems: a review of self-suspending tasks in real-time systems", Real-Time Systems 55, 2019.
