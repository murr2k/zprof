# zprof wire protocol

Status: protocol version 1, implemented in P1 (2026-11-21). The firmware's `include/zprof/proto.h` is
the source of the numbers below; the bridge's ids are generated from it and a
test keeps the two equal. Everything is little-endian.

## 1. Transport

The target listens on TCP (`CONFIG_ZPROF_TCP_PORT`, default 5560), one client
at a time. On the STM32N6570-DK demo the board advertises the port as
`prof=5560` in its discovery answer (`N6HQ` to udp/5557, answered with an
`N6HA` line of `key=value` services).

- Target to host, first: an 8-byte preamble `"ZPRF" u16 proto_version u16 flags`.
- Then frames in both directions:

```text
u8 channel | u8 flags | u16 seq | u32 len | payload[len]
```

| Channel | Direction | Content |
|---|---|---|
| 0 | both | hello and statuses (target), control (host): CT_CLASSES, CT_CAPTURE, CT_CAPTURE_STOP, CT_RECORDER (sections 4a, 4c); later PARAM_SET (only behind the dashboard's arm switch) |
| 1 | target | reserved (the heartbeat's METRIC records travel with the trace, on its clock: section 4b) |
| 2 | target | trace (records, section 2), and a capture's upload |
| 5 | target | heap calls (later) |

`seq` counts frames per channel, so the host sees a lost frame. TCP needs no
COBS or CRC; those return only for a byte-stream transport such as a UART.

Every connection is a session: the target starts it with the preamble and the
hello, and ends it when the client closes or a send fails or stalls for 5 s
(a cable pulled). The host makes a broken connection again by itself (3 s
without data is a broken link: the target sends a SYNC every 250 ms), and a
preamble where a frame should start is a new session in the same stream.

## 2. Records

Every trace and metric record is a whole number of 32-bit words:

```text
word 0: u32 ts                 timestamp (section 3)
word 1: u8 id | u8 nw | u16 arg
words 2..: nw x u32 payload    nw = bits 0-3 of the second byte; bits 4-7 are flags
```

A decoder skips an id it does not know by its `nw`. Pointers are 32-bit
target addresses; the host names them from the ELF.

| Id | Record | arg | Payload |
|---|---|---|---|
| 0x01 | SWITCH_IN | priority | thread |
| 0x02 | SWITCH_OUT | thread state: Zephyr's bits (`ZPROF_THS_*`: pending 0x02, sleeping 0x04, suspended 0x10, queued 0x80 = still ready, preempted) | thread, the wait queue it pends on (0 if none): the switch reason; when it blocks, a third word: the call site of the blocking call (a return address in the application's code: every `*_blocking` hook and the sleep hooks record it, whatever the preset; absent when another thread blocked in between, or when the switch-out came more than 200 us after the hook: a hook whose call did not block must not name the thread's next wait) |
| 0x03 | ISR_ENTER | IRQ number (IPSR - 16), or 0x8000 + exception number for system exceptions | |
| 0x04 | ISR_EXIT | as ISR_ENTER | |
| 0x05 | IDLE | | [64-bit kernel cycles, if the timestamp stops in sleep] |
| 0x06 | IDLE_EXIT | | as IDLE |
| 0x07 | READY | | thread |
| 0x08 | PEND | | thread, wait queue |
| 0x09 | PRIO | new priority | thread |
| 0x0A | CREATE | priority | thread, entry |
| 0x0B | ABORT | | thread |
| 0x0C | NAME | | thread (the name follows on channel 0, from the sender thread) |
| 0x10-0x17 | kernel objects: SEM, MUTEX, MSGQ, QUEUE (k_queue, k_fifo, k_lifo), SLEEP, POLL, TIMER, WORK | call << 4 \| phase (ENTER 1, BLOCK 2, EXIT 3) | object, value. Calls that may block (sem take, mutex lock, msgq put and get, queue get) have no ENTER: one EXIT (the return code) when they do not block, BLOCK (the timeout in ticks, 0xFFFFFFFF forever; for a mutex its owner) then EXIT when they do (the wait is BLOCK to EXIT). A sem give (value: the count after) and a mutex unlock: EXIT only. Other calls: ENTER with their input (a queue put's "allocated", a sleep's time), EXIT where it means something (sleep, poll, timer expiry); work items carry their handler; SLEEP has object 0 (the thread). Calls are numbered per class (`ZPROF_CALL_*`). Not recorded from the zprof sender itself (its sends would trace themselves); a run-time mask of classes (hello tag 10) |
| 0x60 | MARK_START | | the marker's name (a string literal in rodata: the host reads it from the ELF), value; the running thread's (`zprof.h`: `ZPROF_MARK_START("frame")`) |
| 0x61 | MARK_STOP | | name, value: 0 means nothing was done this time (no job), anything else completes the job (`ZPROF_MARK_STOP("frame", 1)`) |
| 0x62 | PLOT | | name (a string literal in rodata), signed 32-bit value (`ZPROF_PLOT("frame.margin_us", left)`) |
| 0x63 | PRINT | | format (a string literal in rodata), three 32-bit arguments: integers and characters only, no `%s` or floats (`ZPROF_PRINT("seek to %u ms", ms)`); the host formats it |
| 0x64 | TRIGGER | | why (the application's own code): something worth keeping happened (`ZPROF_TRIGGER(1)`); with the flight recorder armed it also freezes the ring (section 4c) |
| 0x65 | FAULT | reason (`K_ERR_*`) | pc, thread, flags (1 ISR, 2 essential thread, 4 halted, 8 no call trace); the whole record is hello tag 15 (section 4e) |
| 0x66 | SPAN | nesting level in its thread (0: outermost) | name (rodata), duration (timestamp ticks, wall time); written at the span's end, so its time is the end (section 4g) |
| 0x67 | SAMPLE | the exception interrupted: 0 a thread, 16 + IRQ, or a system exception's number | pc, lr as stacked (the caller only in a leaf function), the running thread (section 4g) |
| 0x70 | METRIC | the metric's index in the hello's dictionary | value: a gauge's (signed), a counter's change since the last heartbeat, a timer's timestamp ticks since the last heartbeat (section 4b) |
| 0x71 | THREAD_STATS | | thread, the kernel's execution cycles low, high: written by the sender once a second, so the host can check its per-thread CPU against the kernel's own count |
| 0x72 | STACK | | thread, stack bytes never used, stack size: every 10th heartbeat (`CONFIG_ZPROF_STACK_DIVIDER`), with `CONFIG_INIT_STACKS` |
| 0x73 | PMU | kind: 0 heartbeat, 1 after a SWITCH_OUT, 2 the counters restarted | the four PMU counts (32-bit, wrapping) of the events in hello tag 14 (section 4d) |
| 0x7E | SYNC | | 64-bit kernel cycles, 32-bit timestamp, uptime ms |
| 0x80 | ETH_RX | frame length | 14 words: the frame's first 56 bytes as the driver hands it up (section 4f) |
| 0x81 | ETH_TX | frame length | time to transmit complete (bit 31: an error), then the frame's first 56 bytes |
| 0x82 | I2C | address | device, flags << 16 \| length, duration, return code; with `CONFIG_ZPROF_BUS_I2C_DATA` also the first 8 data bytes |
| 0x83 | DISK | 0 read, 1 write | the disk's name (rodata), first sector, sectors, duration, return code |
| 0x7F | OVERFLOW | IPSR | records dropped, 64-bit kernel cycles, current thread |

Thread pointers are reused after a thread ends: the host starts a new
identity at each CREATE.

## 3. Time

`ts` is the Cortex-M DWT cycle counter (`CONFIG_ZPROF_TS_DWT`, 800 MHz on the
N6, wraps every 5.37 s) or the kernel's 32-bit cycle count
(`CONFIG_ZPROF_TS_KCYCLE`). The host unwraps it; SYNC records every 250 ms tie
it to the 64-bit kernel cycle count and uptime, and OVERFLOW re-anchors after
a gap. The host places every session on the target's own clock (time since
boot) at the session's first SYNC and holds the few records before it until
then, so a reconnect continues the same timeline; a session whose clock is
behind the last one's is a reboot (a new timeline). Measured on the N6: the
DWT counter runs through WFI, 40 to 70 ppm faster than the kernel's
SysTick-based count, with no probe attached. On a chip where it stops in
sleep, IDLE_EXIT carries the 64-bit count.

## 4. Hello (channel 0, target to host, at connect)

TLV entries (`u16 tag | u16 len | value`): protocol and Zephyr versions; the
build UUID (a `const` symbol the bridge also reads from the ELF, since Zephyr
links with `--build-id=none`); timestamp source and Hz; kernel cycle Hz; ring
size; enabled event classes; the sender thread; the thread table (pointer,
name, priority, state, entry, stack base and size); the IRQ table (number,
handler, argument, NVIC priority); the metric dictionary (tag 11, one entry
per metric: `u16 index | u8 kind | u8 0 | name NUL unit`, kind 1 counter, 2
gauge, 3 timer); the capture status (tag 12, section 4a); the flight
recorder's status (tag 13, section 4c); the PMU's events (tag 14, section
4d); a fault no client has had yet (tag 15, section 4e); the buses recorded and
recordable (tag 16, section 4f); spans and PC sampling (tags 18 and 19, section
4g). A table ends with
an END entry (0xFFFF); the thread table is sent again whenever it changes.

Right after the hello, in its own control frame: the hook cost (tag 9, u32
timestamp ticks), measured by the target at connect as the fastest of 8 runs
of 32 calls of a real hook. The host multiplies it by the event rate for the
agent's own cost (159 ns a hook on the N6 at 800 MHz).

The ids and tags are those of `firmware/zprof/include/zprof/proto.h`; the
bridge reads them from that file.

## 4a. Control (channel 0, host to target)

Frames on channel 0 holding TLV commands. The target reads them between sends,
without waiting; a frame longer than its 64-byte buffer is skipped.

| Tag | Value | Answer |
|---|---|---|
| 64 CT_CLASSES | u32 mask of the kernel-object classes to record (bit = id - 0x10) | HT_CLASSES with the mask now in effect, in a control frame |
| 65 CT_CAPTURE | u32 ms to capture (0: until stopped or the buffer is full) | HT_CAPTURE (tag 12): `u32 state, u32 bytes held, u32 capacity, u32 ms recorded`; state 0 off, 1 recording, 2 uploading, 3 done, 4 no buffer |
| 66 CT_CAPTURE_STOP | none | the capture ends and uploads |
| 67 CT_RECORDER | u32 ms kept after a trigger (0: off) | HT_RECORDER (tag 13): `u32 state, u32 ms kept after a trigger, u32 triggers since boot, u32 bytes held`; state 0 off, 1 armed, 2 triggered, 3 holding a recording (section 4c) |
| 68 CT_PMU | `u16 x4` Arm PMU event numbers (0xFFFF: keep), `u32` flags (bit 0: a PMU record at every switch) | HT_PMU (tag 14): `u16 x4` the events, `u32` flags, `u32` the PMU's AUTHSTATUS (section 4d) |
| 69 CT_PROTO | `u32` the buses to record (1 Ethernet, 2 I2C, 4 disk) | HT_BUSES (tag 16): `u32` recorded now, `u32` this build can record (section 4f) |
| 70 CT_SPANS | `u32` on, `u32` the shortest span kept (ns), `u32` the deepest level kept | HT_SPANS (tag 18): `u32` on, `u32` shortest (ns), `u32` deepest, `u32` timestamp ticks a begin and an end cost, measured at the switch-on (section 4g) |
| 71 CT_SAMPLE | `u32` PC samples a second (0: off) | HT_SAMPLE (tag 19): `u32` the rate set (0: off, or the port has no timer), `u32` the handler's mean run (timestamp ticks), `u32` 1 (built in); sent again every second while sampling (section 4g) |

In zprof 0.6.0 the firmware's header gave tag 1 (HT_PROTO, the protocol version)
and tag 16 (HT_BUSES) the same name, so 0.6.0 sends its version under tag 16 too
(2 bytes); the bridge skips a tag 16 shorter than 8 bytes.

Every session starts recording all classes; the bridge sends the page's choice
again at every connection (`presets.py`: Scheduling 0x00, Timing 0x02, Kernel
objects 0xFF).

Capture-then-upload. The target takes `CONFIG_ZPROF_CAPTURE_KB` from the
port's `zprof_port_alloc()` at the first capture and keeps it. While it
records, the hooks write into that buffer instead of the ring, from its
start, and nothing drains it: no sender has to keep up and nothing but a
status every 500 ms goes on the network. At the end (the time asked for,
CT_CAPTURE_STOP, or the buffer full: a record refused, or less than 64 words
left) the hooks go back to the ring, and the target sends a status (2), the
buffer as ordinary trace frames of whole records, and a status (3), then
streams as before. So a capture decodes as the stream it would have been,
the ring's older records sent before it. The ring is not drained during the
upload: what it cannot hold is an OVERFLOW after the capture, never a gap
inside it. Measured on the N6 during the attract lap with two 1.5 MB
screenshots sent meanwhile (each about 2 MB/s of events while it runs): a
4 MB capture of 8 s with no record lost; moving the ring into the buffer
from the sender, as the first version did, lost about 7,900 records at the
screenshots, while the network stack held the sender off.

## 4c. Flight recorder

For an event nobody is watching for: a missed frame once an hour. Armed
(CT_RECORDER, or `CONFIG_ZPROF_RECORDER_POST_MS` at boot), the recorder
records whenever no client is connected: the hooks write the ring as in a
session, and when it is full the oldest whole records go instead of the new
one (no OVERFLOW), so it always holds the latest stretch, the ring's size at
the event rate (64 KB at about 250 KB/s: a quarter of a second). A timer
writes a SYNC every 100 ms meanwhile. The application's `ZPROF_TRIGGER()`
writes a TRIGGER record; the first one while armed starts the post time,
after which a last SYNC goes in and the hooks stop: the ring now holds the
moments before the trigger and the post time after it (state 3), and keeps
them across any number of later triggers (they are counted).

The next client to connect gets it first: after the hello (whose HT_RECORDER
says 3 and the bytes held), the ring as ordinary trace frames of whole
records, then an HT_RECORDER with the recorder armed again, then the
session as usual, beginning with a SYNC. The host places the recording at
its first SYNC, as any session, and anchors the live part afresh after the
second HT_RECORDER, behind a session marker, so a run in flight at the freeze
does not span the gap. A client connected while a trigger comes sees the
TRIGGER live and the recorder stays armed; it records again once the client
has gone. A reset loses it (the ring is in RAM).

## 4d. PMU counts

On an Armv8.1-M core with a PMU (`CONFIG_ZPROF_PMU`, opt-in on the Cortex-M55 and
M85), the target counts four events at a time, each in a chained pair of the
PMU's 16-bit event counters (the odd counter counts the even one's overflows),
so a count is 32 bits and wraps. Every session starts with the default set:
instructions (0x0008), instruction-cache refills (0x0001), data-cache
refills (0x0003) and back-end stall cycles (0x0024); CT_PMU picks others and
turns per-thread records on (the bridge's `--pmu` and `--pmu-threads`).

A PMU record carries the four counts as they are now. The host takes the
difference to the previous PMU record: at a heartbeat it is the window's
total; a record of kind 1 comes right after a SWITCH_OUT, so its difference
is the thread's that switched out (interrupts that ran on it included); kind
2 follows a restart (new events) and is a new baseline, with no difference
taken. A gap (an OVERFLOW, a new session) also starts a new baseline. Figures:
instructions per cycle over the thread's run time (the timestamp counts core
cycles), cycle events as a share of the run time, other events per 1000
instructions, MVE instructions as a share of all.

HT_PMU also carries the PMU's AUTHSTATUS: with secure non-invasive debug
disabled (bits 7:6 = 2) the counters may not count secure code.

## 4e. Faults

`zprof_fault_capture()` (`CONFIG_ZPROF_FAULT`, off unless a build chooses it),
called from a fatal error handler, keeps a record of 48 words (`struct
zprof_fault`, `src/zprof_internal.h`):
magic "FALT", length, the build id, uptime, the reason (`K_ERR_*`), flags, the
thread and its name, r0-r3, r12, LR, PC and xPSR as stacked, r4-r11 and the PSP,
the MSP and EXC_RETURN, HFSR and the fault address registers (Zephyr's handler
has cleared the status bits by then: the reason says what kind it was), up to 8
return addresses from Zephyr's unwinder (the MSP's frames for an interrupt; none
on a stack overflow or a stack pointer outside its stack), the trace's timestamp
and a CRC-32 (IEEE) of the rest. It puts a FAULT record in the trace and
freezes an armed flight recorder at once.

An application with its own `k_sys_fatal_error_handler` calls it there and
keeps its own failure policy (flags: neither halted nor ran on). Only with
`CONFIG_ZPROF_FAULT_HANDLER` does zprof supply the handler (Zephyr's is weak):
it halts as Zephyr's own does (flag 4), or with `CONFIG_ZPROF_FAULT_CONTINUE`
returns for a fault in a thread that is not essential (and not a panic), so the
kernel ends only that thread and the target stays up to report it (flag 0x10).
Both are off by default: adding zprof never changes how a device fails, and
neither policy is safe for every system. The sender sends the record (HT_FAULT)
and the brief log of the last four (HT_FAULT_LOG: count since boot, then uptime,
reason and thread name each) to the connected client at once, and in every
client's hello for as long as the board holds them (until a reset), so no
client uses them up. A flight recording frozen by the fault goes to the first
client only, as any held recording does (section 4c). A fault in an interrupt, in main or idle, or a panic halts as
Zephyr's handler does: spinning with interrupts locked, so a probe can read
`zprof_fault`. The record is in the DTCM's zeroed section: it outlives the
fault, not a reset.

## 4f. Buses (the protocol analyzer)

Records of bus traffic (`CONFIG_ZPROF_BUS`, a build-time opt-in), each kind
only while the host asks (CT_PROTO; every session starts with none, the bridge
sends its choice again), and only what the build has (HT_BUSES's second word):
received Ethernet frames from Zephyr's
`net_recv_data` tracing hook; sent frames, I2C messages and disk transfers from
link-time wraps of `eth_stm32_tx`, `i2c_stm32_transaction` and
`disk_access_read`/`_write`. Ethernet is a build-time opt-in: frame headers
name every host the target talks to, and the port has no login (README,
"Security and privacy"). A record's time is the end of its transfer; the
duration goes back to the start. Frames keep their first 56 bytes (Ethernet,
IPv4 and TCP headers); zprof's own TCP stream is left out. The bridge exports the
frames as pcapng (`export --pcapng`), each at its target time placed on the
host's clock, with its direction.

## 4g. Spans and PC samples

Where the time goes inside a thread's job, each a build-time opt-in and each
recorded only while the host asks (every session starts with neither).

Spans (`CONFIG_ZPROF_SPANS`): `ZPROF_SPAN_BEGIN("name")` / `ZPROF_SPAN_END("name")`
in the application, and with `CONFIG_ZPROF_LVGL` LVGL's own profiler points
(layout, refresh, draw tasks and units, events; its tags are `__func__`, literals
and names in rodata). A begin pushes its name and time on the thread's own stack
(24 levels; `CONFIG_ZPROF_SPAN_THREADS` threads at once, none in interrupts); the
end pops it and writes one SPAN record if the span lasted at least the shortest
the host asked for (CT_SPANS, in ns) and is no deeper than asked. The others are
counted in the heartbeat's metrics (`zprof.spans`, `zprof.spans_left_out`).
Begin and end match by the name's address; an end whose begin came before the
spans were on is dropped, and one that finds its begin a few levels down closes
the levels above it (an end the code skipped). The duration is wall time: the
host takes the thread's own share from the scheduler trace. Not recording, a
span costs a load and a branch; recording, a begin and an end take no lock once
the thread has its slot, and at every switch-on the target times them (the
fastest of 8 runs of 16 pairs, HT_SPANS) so the host can print what the spans
cost: every span the metrics count, kept or not, times that.

PC samples (`CONFIG_ZPROF_SAMPLE`): the port's timer interrupts at the rate
asked (CT_SAMPLE). Its handler, `zprof_sample_irq`, is connected straight to
the vector table so EXC_RETURN tells it which stack holds the exception frame:
the PC, the stacked LR and the exception number from the stacked xPSR (0: a
thread) go into a SAMPLE record with the running thread. It runs at a priority
`irq_lock()` masks, as every writer of the ring must, so a sample due in a
locked region is taken where the lock ends. It is not in the ISR records; its
mean run is in HT_SAMPLE, and the host prints rate x cost. A port should
vary each period a little, so samples cannot lock to the application's own
periods (the demo's TIM7 varies it by up to an eighth).

## 4b. Heartbeat

Every `CONFIG_ZPROF_HEARTBEAT_MS` (100) the sender calls the port's
`zprof_port_heartbeat()`, where the application sets its gauges, then writes
one METRIC record per metric in dictionary order, index 0 first: a heartbeat
ends where the index starts again (an interrupt's records may come between).
Counters and timers are reset as they are read. Metrics are the
application's `ZPROF_METRIC_DEFINE(var, "name", COUNTER|GAUGE|TIMER, "unit")`
(`ZPROF_ADD`, `ZPROF_SET`, `ZPROF_TIMER_START/STOP`) and the built-ins:
`cpu.load` (permille, with `CONFIG_SCHED_THREAD_USAGE_ALL`), `zprof.dropped`
(records lost), `zprof.ring_peak` (the ring's fullest, percent). Because the
values are read on the target at a point of the trace's own clock, the host
can hold the trace's events against them exactly
(`integrations/stm32n6-demo/p3check.py`).

## 5. Recording file (`.zpr`)

A JSON header line (magic, versions, the hello, ELF path and sha256, host
start time), then chunks `u64 host_ns | u32 len | bytes as received`. Replay
feeds the bytes through the same decoder as a live session. A chunk of length
0 marks a reconnect: the decoder drops any half frame before it and expects
the next session's preamble. A summary of a recording that spans a reboot
covers the last boot.
