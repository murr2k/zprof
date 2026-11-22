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
| 0 | both | hello (target), control (host): START, STOP, CAPTURE_ARM, UPLOAD; later PARAM_SET (only behind the dashboard's arm switch) |
| 1 | target | metrics (METRIC records) |
| 2 | target | trace (records, section 2) |
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
| 0x02 | SWITCH_OUT | thread state | pended-on object (0 if none): the switch reason |
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
| 0x10-0x3F | kernel objects | per class | object, then result, count or fill (semaphore give/take, mutex lock/unlock, msgq put/get, sleep, poll, timer, work start with handler) |
| 0x60 | MARK_START | | descriptor (rodata pointer), value |
| 0x61 | MARK_STOP | | descriptor, value |
| 0x62 | PLOT | | descriptor, value |
| 0x63 | PRINT | | format (rodata pointer), arguments |
| 0x70 | METRIC | metric id | value |
| 0x71 | THREAD_STATS | | thread, the kernel's execution cycles low, high: written by the sender once a second, so the host can check its per-thread CPU against the kernel's own count |
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
SysTick-based count. Whether the DWT counter runs through WFI with no probe attached is
measured in P1; if it does not, IDLE_EXIT carries the 64-bit count.

## 4. Hello (channel 0, target to host, at connect)

TLV entries (`u16 tag | u16 len | value`): protocol and Zephyr versions; the
build UUID (a `const` symbol the bridge also reads from the ELF, since Zephyr
links with `--build-id=none`); timestamp source and Hz; kernel cycle Hz; ring
size; enabled event classes; the sender thread; the thread table (pointer,
name, priority, state, entry, stack base and size); the IRQ table (number,
handler, argument, NVIC priority); the metric dictionary. A table ends with
an END entry (0xFFFF); the thread table is sent again whenever it changes.

Right after the hello, in its own control frame: the hook cost (tag 9, u32
timestamp ticks), measured by the target at connect as the fastest of 8 runs
of 32 calls of a real hook. The host multiplies it by the event rate for the
agent's own cost (159 ns a hook on the N6 at 800 MHz).

The ids and tags are those of `firmware/zprof/include/zprof/proto.h`; the
bridge reads them from that file.

## 5. Recording file (`.zpr`)

A JSON header line (magic, versions, the hello, ELF path and sha256, host
start time), then chunks `u64 host_ns | u32 len | bytes as received`. Replay
feeds the bytes through the same decoder as a live session. A chunk of length
0 marks a reconnect: the decoder drops any half frame before it and expects
the next session's preamble. A summary of a recording that spans a reboot
covers the last boot.
