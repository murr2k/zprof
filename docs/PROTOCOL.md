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
| 0x70 | METRIC | the metric's index in the hello's dictionary | value: a gauge's (signed), a counter's change since the last heartbeat, a timer's timestamp ticks since the last heartbeat (section 4b) |
| 0x71 | THREAD_STATS | | thread, the kernel's execution cycles low, high: written by the sender once a second, so the host can check its per-thread CPU against the kernel's own count |
| 0x72 | STACK | | thread, stack bytes never used, stack size: every 10th heartbeat (`CONFIG_ZPROF_STACK_DIVIDER`), with `CONFIG_INIT_STACKS` |
| 0x7E | SYNC | | 64-bit kernel cycles, 32-bit timestamp, uptime ms |
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
recorder's status (tag 13, section 4c). A table ends with
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
