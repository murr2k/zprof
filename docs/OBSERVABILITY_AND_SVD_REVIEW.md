# Review: Zephyr observability services and the STM32N6 SVD

Date 2026-10-20. Scope: what the Zephyr observability documentation and ST's
STM32N6 SVD files add to zprof's fidelity, features and testing, measured
against [PLANS.md](PLANS.md) and [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md) as of
v0.2.0.

Sources:

- [Zephyr observability services](https://docs.zephyrproject.org/latest/services/observability.html)
  ("latest", that is `main`) and its sub-pages: logging, tracing, debugging
  (thread analyzer, core dump, GDB stub, Cortex-M debug monitor, MIPI STP
  decoder, symtab, CoreSight trace deformatter, zyclictest), profiling (perf),
  instrumentation, CPU load, shell, task watchdog.
- `stm32n6-svd.zip`: ST's STM32N6 SVD V1.0 (first release, files dated
  2024-10-10), four devices, Apache-2.0. Parsed in full; the DK's part is
  `STM32N657.svd`.
- RM0486 Rev 4 (STM32N6 reference manual), for the trace subsystem the SVD
  does not describe.

Verification legend: **[pin]** checked in Zephyr source at a915b2f1 (our
pin); **[docs]** stated by the Zephyr docs, not checked in source; **[SVD]**
read from `STM32N657.svd`; **[RM]** read from RM0486; **[unverified]** needs
hardware or a build.

## 1. Summary

1. **The N6 has an on-chip CoreSight trace subsystem that changes the
   transport plan [RM].** It has an STM (software writes to memory-mapped
   stimulus ports; hardware timestamps them) and an ETR that writes the merged
   ETM, ITM and STM trace into system RAM over AXI. zprof events could cost a
   single store each, and instruction trace becomes possible without a trace
   port or a J-Trace. Zephyr already has the decoders (MIPI STP, CoreSight
   deformatter) and a generic `arm,stmesp` binding with an STM log frontend
   [pin]; the N6 lacks the devicetree node and an ETR setup driver.
2. **Choose the trace format deliberately [pin].** CTF, `TRACING_USER` and an
   out-of-tree `TRACING_FORMAT_HEADER` are alternatives in one Kconfig choice.
   User hooks receive the kernel object pointers (for example
   `sys_trace_k_mutex_lock_enter_user(struct k_mutex *, k_timeout_t)`). So a
   zprof format can record object state and the IRQ number at the event,
   which CTF does not, and can cut the link cost that put full object tracing
   at a 94% p95 of RTT in the mockup.
3. **The SVD closes several gaps the spec lists as "no driver" [SVD]:**
   - die temperature: the DTS has two sensors with alarm thresholds;
   - rail health: core-voltage low/high, PVD, VBAT and backup-domain
     temperature monitors, and per-rail ready flags;
   - power states: Stop and Standby entry flags;
   - bus errors: SPI, I2C, DMA and FDCAN error fields;
   - a lockup reset flag that `hwinfo` does not map on the N6 [pin].
4. **It adds new reliability signals [SVD]:**
   - ECC interrupts for the CPU cache, the TCM and backup RAM, and a
     backup-SRAM double-error flag;
   - an illegal-access controller that latches the faulting address;
   - an IWDG early-wakeup interrupt, a last-gasp hook before a hardware
     watchdog reset (the Zephyr driver supports it [pin]);
   - lockup to NMI instead of reset;
   - the address of a failed posted write on the core's peripheral bus.
5. **Debugger coexistence is mostly a DBGMCU matter [SVD].** Freeze bits for
   IWDG, WWDG, timers, DMA channels and the NPU keep a halted core from
   resetting the board. A status register reports whether the M55 access port
   (AP1) is enabled, which the hello record should carry.
6. **New test oracles [pin, docs].** Zyclictest measures IRQ and thread
   latency against the programmed timer time. It needs a 64-bit cycle
   counter: the N6 has one (SysTick's defaults on above 60 MHz) and so does the
   Zynq-7000 A9 (the Arm architected timer driver on the global timer); the
   ZynqMP R5 on the PS TTC does not. The thread analyzer, the CPU-load idle-hook backend,
   perf, coredump and the CTF sample on `native_sim` give independent paths
   to check zprof against.
7. **A zero-instrumentation profile on the N6 [pin].** perf has a Cortex-M
   backend: SysTick-driven stack sampling, needing `THREAD_STACK_INFO` and
   `ARCH_STACKWALK` (which on Cortex-M needs `EXTRA_EXCEPTION_INFO`), a
   Secure or non-TrustZone image, and no SMP. The DK meets the image and
   timer conditions by default.
8. **Limits of the SVD [SVD].**
   - No core or CoreSight blocks: SCB with the fault status registers, NVIC,
     DWT, ITM, ETM, MPU. Those need Arm's CMSIS-Core definitions and RM0486.
   - Read side effects are annotated only for Ethernet.
   - `mpuPresent` is wrong (false).
   - The RIF registers carry no field definitions.

## 2. Recommendations at a glance

Effort: S about a week or less, M one to three weeks, L more.

| # | Recommendation | Improves | Target | Effort | Lands in |
|---|---|---|---|---|---|
| 1 | Prototype N6 event tracing through the STM into an ETR RAM ring, decoded with Zephyr's STP decoder and CoreSight deformatter; compare cost and fidelity with CTF over RTT | fidelity, link budget, CPU overhead | N6 | M to L | PLANS sections 4 and 8; new Phase A option |
| 2 | Define the zprof trace format via `TRACING_FORMAT_HEADER` (user-hook style: object pointers, IRQ number from IPSR, object state at the event), with CTF and Perfetto export in the bridge | fidelity, link budget | both | M | PLANS sections 4, 5 and 8 |
| 3 | Name ISR lanes from the SVD interrupt table (186 IRQs on the N657), with the IRQ number recorded at `isr_enter` | fidelity | N6 | S | spec 3.4; bridge |
| 4 | Fault record from SVD sources: `RCC_RSR` with `LCKRSTF`, lockup to NMI (`SYSCFG_CM55RSTCR.LOCKUP_NMI_EN`), `SYSCFG_AHBWP_ERROR_SR.PAHB_ERROR_ADDR`, IAC and RISAF illegal-access status and address, IWDG early wakeup as last gasp | fidelity | N6 | S to M | spec 3.7, 5.9; PLANS 4 |
| 5 | DBGMCU debug-safe profile (freeze IWDG, WWDG, timers, DMA, NPU on halt; keep debug in Sleep/Stop) and AP1 state in the hello record | features (debugger coexistence) | N6 | S | spec 14; PLANS 2.7 |
| 6 | Zyclictest as a latency oracle in the Phase A exit criteria and as a QA latency test across temperature | testing | N6 | S | PLANS 6; spec 5.6 |
| 7 | Agent-side readers for DTS die temperature, PWR rail and backup-domain monitors, Stop/Standby flags, ECC events, bus error fields | features (fills spec gaps) | N6 | M | spec 3.5, 3.7, 3.8, 3.9, 11 |
| 8 | Dictionary logging over RTT decoded in the bridge (Zephyr's live parser has a J-Link RTT reader) | link budget, time alignment | both | S | PLANS 4, 5 |
| 9 | perf sampling as a Profile source on the N6; compare with instrumentation and ETM | features, testing | N6 | S | PLANS Phase D |
| 10 | CPU load: label which backend the KPI uses; use `cpu_load_cb_reg()` threshold events on the target | fidelity | both | S | spec 3.3, 12 |
| 11 | Coredump with all threads, opened in GDB from Fault detail through `coredump_gdbserver.py`; UDP backend for networked rigs where coredump is supported | features | N6, ZynqMP A53 | M | spec 5.9 |
| 12 | Register inspector view driven by the SVD: probe reads of device registers, allow-listed, trended against thresholds | features | N6 | M | spec 13 (new concept) |
| 13 | NPU activity lane (epoch and NPU interrupts) and AXI-cache hit / miss counters | features | N6 | S to M | spec 13 |
| 14 | TCM rows in the floor plan from `SYSCFG_CM55TCMCR` | fidelity | N6 | S | Memory view |
| 15 | Object inventory at connect (`TRACING_OBJECT_TRACKING` walk) named from ELF symbols | fidelity | both | S | bridge |
| 16 | Generated register subset and unit tests from the SVD (field positions the agent relies on); the workbook generator already checks the signal list | testing | N6 | S | `host/`, CI |

## 3. Zephyr observability services

### 3.1 Tracing

- **One format per build [pin].** `TRACING_FORMAT_CHOICE` holds CTF and
  `TRACING_USER`; `TRACING_FORMAT_HEADER` brings an out-of-tree format in when
  no in-tree one is selected [docs]. PLANS.md currently assumes CTF bytes pass
  through. That keeps `trace_viewer.py`, Perfetto and babeltrace2 working, but
  it fixes the event content.
- **User hooks carry the objects [pin].** `subsys/tracing/user/tracing_user.h`
  declares hooks such as `sys_trace_k_mutex_lock_enter_user(struct k_mutex
  *mutex, k_timeout_t timeout)` and `sys_trace_thread_priority_set_user(struct
  k_thread *thread, int prio)`. A zprof format built the same way can read
  the semaphore count, message-queue fill or mutex owner at the event. The
  bridge then needs no inference (spec section 3.6 currently infers lock
  holders), and the Cortex-M agent can read IPSR in `isr_enter` for the IRQ
  number, which CTF's `isr_enter` lacks.
- **Named events [pin].** `sys_trace_named_event(name, arg0, arg1)` exists
  and CTF encodes it. It is the cheap route for spans, marks and parameter
  changes while zprof still rides on CTF.
- **RAM backend [docs].** `CONFIG_TRACING_BACKEND_RAM` with
  `CONFIG_RAM_TRACING_BUFFER_SIZE`, read with GDB. As an on-target flight
  recorder it survives link loss; it complements the bridge-side recorder
  (spec 8.4) for hangs where RTT stops draining.
- **Object tracking [docs].** `CONFIG_TRACING_OBJECT_TRACKING` with
  `k_obj_type_walk_locked()` enumerates mutexes, semaphores and the rest at
  connect time. Naming them from ELF symbols (`bus_lock`, `sample_q`) gives the
  Objects view and the trace their labels without application calls.
- **Percepio and SystemView [docs]** stay cross-checks, as PLANS.md says.
  SystemView post-mortem mode (`CONFIG_SEGGER_SYSVIEW_POST_MORTEM_MODE`) is a
  useful reference for the flight-recorder behavior.

### 3.2 Logging

- **Dictionary logging over RTT [docs, pin].** `CONFIG_LOG_BACKEND_RTT_OUTPUT_DICTIONARY`
  sends compact records decoded on the host with the build's
  `log_dictionary.json`. `scripts/logging/dictionary/live_log_parser.py` has a
  `JLinkRTTReader` built on `pylink`, the library the bridge already plans to
  use. Logs then cost a fraction of the bytes and carry the same cycle-counter
  timestamps as the trace (the timestamp function is replaceable [docs]).
- **Runtime filtering [docs]** (`log_filter_set()`, `CONFIG_LOG_RUNTIME_FILTERING`)
  is exactly what the mockup's `log.level` parameter models; the agent applies
  it through the registry.
- **Drops and rate limits [docs, pin].** Drops reach backends through
  `log_backend_dropped()` (already in the spec). `CONFIG_LOG_RATELIMIT` exists
  at the pin; rate-limited messages should count separately from drops so a
  soak report does not read them as data loss.
- **STM frontend [pin].** `CONFIG_LOG_FRONTEND_STMESP` (dictionary mode, and
  a turbo mode) depends only on an `arm,stmesp` devicetree node. It is the
  logging half of recommendation 1.

### 3.3 Debugging

- **Thread analyzer [docs].** Already the Phase B cross-check.
  `CONFIG_THREAD_ANALYZER_LONG_FRAME_PER_INTERVAL` aligns its longest-frame
  figure with zprof's per-heartbeat peaks, so the two can be compared interval
  by interval.
- **Core dump [docs, pin].**
  - Backends: logging, logging over UDP (`DEBUG_COREDUMP_BACKEND_LOGGING_UDP`
    [pin]), flash partition.
  - Contents: `DEBUG_COREDUMP_MEMORY_DUMP_THREADS` adds every thread's struct
    and stack.
  - Host tools: `coredump_gdbserver.py` serves a dump to GDB, so Fault detail
    can offer "open in GDB" with the ELF matched by build ID.
  - The UDP backend suits networked QA rigs, on architectures where coredump
    is supported. Spec section 11 already records AArch32 Cortex-A/R as not
    supported.
- **GDB stub and debug monitor [docs, pin]** are covered in spec section 14.
- **Symtab [pin].** `CONFIG_SYMTAB` resolves PCs on the target. It is useful
  where no ELF travels with the unit (field returns, soak racks with mixed
  builds) and for the caller PC in heap-wrap records.
- **Zyclictest [docs, pin].**
  - What it measures: IRQ latency and thread latency against the programmed
    timer time, as histograms with counts, maximum, errors and overflows.
  - How it runs: shell command `zyclictest start -i <us> -l <loops> -p <prio>`.
  - Requirements: `CONFIG_ZYCLICTEST_SHELL` depends on
    `TIMER_HAS_64BIT_CYCLE_COUNTER` [pin], and the docs ask for a tickless
    kernel at 1 MHz or more.
  - On the N6: SysTick is the system timer (the Armv8.1-M dtsi node, no
    LPTIM override [pin]), and `CORTEX_M_SYSTICK_64BIT_CYCLE_COUNTER`
    defaults on above 60 MHz [pin]. So it is available.
  - On the Zynq-7000 A9: the devicetree drives the global timer through the
    Arm architected timer driver, which selects the 64-bit counter [pin], so
    it is available there too.
  - On the ZynqMP R5: the PS TTC driver does not select the 64-bit counter
    [pin], so it is not available.
  - Section 6 makes it a test oracle.
- **MIPI STP decoder and CoreSight deformatter [docs, pin].**
  - Both are on-chip decoders: the STP decoder handles STM data, and the
    deformatter splits ETR frames into streams by a 7-bit ID.
  - At first sight they look unrelated to our targets. RM0486 shows the N6
    has both an STM and an ETR (section 5), which makes them central to
    recommendation 1.

### 3.4 Profiling (perf)

- The Cortex-M backend `PROFILING_PERF_BACKEND_ARM_CORTEX_M` [pin] depends on
  `CPU_CORTEX_M`, `CORTEX_M_SYSTICK`, `THREAD_STACK_INFO`, `ARCH_STACKWALK`,
  `!TRUSTED_EXECUTION_NONSECURE` and `!SMP`.
- `PROFILING_PERF` needs `SHELL`. Host side, `stackcollapse.py` produces
  FlameGraph input [docs].
- The DK's app is Secure (`TRUSTED_EXECUTION_SECURE` in the defconfig [pin])
  and uses SysTick, so perf is a Profile-view source with no instrumentation
  and no trace port. It samples the interrupted thread's frame from the
  SysTick handler, so it is statistical and blind to code with interrupts
  masked.
- `EXTRA_EXCEPTION_INFO` enters through the stack walker:
  `ARCH_STACKWALK` depends on `ARCH_HAS_STACKWALK`, which defaults on only
  with `EXTRA_EXCEPTION_INFO && CPU_CORTEX_M` [pin].
- **Correction:** spec section 11 listed only "SysTick; needs SHELL,
  EXTRA_EXCEPTION_INFO"; the full set is above (section 7).

### 3.5 Instrumentation

Matches PLANS Phase D. The docs add three practical constraints:

- data reach the host over the UART console (the `zephyr_console` chosen
  node), which competes with a zprof UART transport;
- instrumentation grows thread stacks, so stack margins measured on an
  instrumented build are not the release build's;
- the dynamic trigger needs a retained-memory devicetree node.

The second matters for Build compare: footprint, stack and timing must never
be compared across an instrumented and a release build. The Compare view
should refuse such a pair.

### 3.6 CPU load

- Two backends [docs]:
  - **runtime statistics:** portable and SMP-capable;
  - **idle hooks:** lower overhead, **includes interrupt time**, and can use
    a counter device (`CONFIG_CPU_LOAD_USE_COUNTER`, chosen
    `zephyr,cpu-load-counter`) for precision.
- The API at the pin [pin]: `cpu_load_get(bool reset)`,
  `cpu_load_get_cpu(cpu_id, reset)`, and `cpu_load_cb_reg(cb,
  threshold_percent)`, which calls back when load crosses a threshold.
- This answers half of spec section 12's open question: label the KPI with
  the backend, and prefer the idle-hook backend where ISR time must count.
- The callback lets the agent raise an overload Event on the target instead
  of leaving detection to the host.

### 3.7 Task watchdog and shell

- **Task watchdog [docs]:** an optional hardware fallback
  (`CONFIG_TASK_WDT_HW_FALLBACK`, `_DELAY`). With the IWDG's early wakeup
  (section 4.2), a scheduler failure still leaves a record.
- **Shell:** covered in spec section 14.

## 4. The STM32N6 SVD

### 4.1 What the archive is

- **Contents:** SVD V1.0 for STM32N645, N647, N655 and N657.
- **License:** Apache-2.0, so the bridge can vendor it or a generated subset.
- **Scale of `STM32N657.svd`** (about 23 MB):
  - 248 peripherals: 124 unique blocks, each with a secure alias;
  - 16,876 registers and 79,084 fields;
  - 186 interrupts, the highest IRQn 194.
- **Variants:** the N645 and N647 lack CRYP, PKA, SAES and the four MCE
  blocks; otherwise the parts match.
- **CPU block:** CM55 r0p1, FPU present, 8 NVIC priority bits.
- **Workbook:** `host/svd/svd_workbook.py` turns the SVD into an annotated
  spreadsheet: each block with both aliases, clock enable, reset, debug
  freeze and its Zephyr node at the pin; every register and field with
  addresses, read side effects and write semantics; the interrupt table; and
  the zprof signals of section 4.2, each checked against the SVD.

### 4.2 What it adds to zprof

**Fault and reset fidelity [SVD unless noted]**

| Source | Fields | Use in zprof |
|---|---|---|
| `RCC_RSR` (+0x34), `RCC_HWRSR` | `LCKRSTF` 17, `BORRSTF` 21, `PINRSTF` 22, `PORRSTF` 23, `SFTRSTF` 24, `IWDGRSTF` 26, `WWDGRSTF` 28, `LPWRRSTF` 30, `RMVF` 16 | Reset cause in the hello record. `hwinfo_stm32` maps the lockup flag only for STM32WB0 [pin], so the agent reads `LCKRSTF` itself |
| `SYSCFG_CM55RSTCR` | `LOCKUP_RST_EN`, `LOCKUP_NMI_EN` | Route a core lockup to NMI, write the fault record, then reset |
| `SYSCFG_AHBWP_ERROR_SR`, `SYSCFG_CM55PAHBWPR` | `PAHB_ERROR_ADDR`, `PAHB_ERROR_ACK` | Address of a failed posted write on the M55 peripheral bus, which an imprecise BusFault otherwise loses |
| `IAC_ISR0..5`, IRQ 13 | per-peripheral illegal access flags | Firewall violations (RIF) as Event records |
| `RISAF_IASR`, `RISAF_IADDR` | illegal access status and address | The address that tripped a RAM protection region |
| `IWDG_EWCR`, `IWDG_SR` | `EWIT`, `EWIE`, `EWIF`, `ONF` | Early-wakeup interrupt before the hardware watchdog bites (Zephyr: `CONFIG_IWDG_STM32_EARLY_WAKEUP` with a callback [pin]); `ONF` reports whether the IWDG is running |
| `TAMP_BKP0R..BKP31R` | 32 backup registers | Boot count, last heartbeat sequence and reset snapshot without enabling backup SRAM |

**Reliability telemetry [SVD]**

| Source | Signal | New catalog entry |
|---|---|---|
| IRQ 5 `CACHE_ECC`, IRQ 6 `TCM_ECC`, IRQ 7 `BCK_ECC` (EXTI) | ECC events on the CPU cache, the TCM and backup RAM | `mem.ecc.<array>` counts, a soak criterion candidate (correctable errors trending with temperature) |
| `RAMCFG_BKPSRAMCR.ECCE`, `RAMCFG_BKPSRAMISR.DED` | backup SRAM ECC enable and double-error detect | the same family; the retained fault record must not live in RAM with uncorrected errors |
| `PWR_CR3` | `VCOREMONEN`, `VCOREL`, `VCOREH` | `env.rail.vcore` low / high flags |
| `PWR_CR2` | `PVDEN`, `PVDO` | brown-out early warning |
| `PWR_BDCR1` | `VBATL`, `VBATH`, `TEMPL`, `TEMPH` | VBAT and backup-domain temperature out of range |
| `PWR_SVMCR1..3` | `VDDIO2..5`, `USB33`, analog `RDY` flags | per-rail power-good |
| `PWR_CPUCR` | `STOPF`, `SBF`, `CSSF` | power-state entry, where the spec records "no PM statistics on N6" |
| DTS: `DTS_TS0SDIFDATAR` / `TS1`, alarms A / B, IRQ 2 | two temperature sensors with thresholds and hysteresis | `env.die` without a Zephyr driver; alarm interrupts become Events. The conversion from `SAMPLE_DATA` to degrees is in RM0486 section 33 and not extracted here [unverified] |
| `SYSCFG_VDDIOxCCSR` | compensation cell `READY` | I/O cell health at temperature corners (DVT) |

**Debugger coexistence and identity [SVD]**

| Source | Fields | Use |
|---|---|---|
| `DBGMCU_APB4FZ1` | `DBG_IWDG_STOP` 18, `DBG_RTC_STOP`, LPTIM | Halting the core in Ozone or GDB does not let the IWDG reset the board |
| `DBGMCU_APB1LFZ1`, `APB2FZ1`, `AHB1FZ1`, `AHB5FZ1` | timers, `DBG_WWDG1_STOP`, I2C, FDCAN, GPDMA and HPDMA channels, `NPU_DBG_FREEZE` | A "debug-safe" profile the agent sets when the probe attaches, reported in the hello record |
| `DBGMCU_CR` | `DBG_SLEEP`, `DBG_STOP`, `DBG_STANDBY`, `TRACECLKEN` | Keep RTT and trace alive across low-power states; enable the trace clock for ETM / STM |
| `DBGMCU_SR` | `AP0_PRESENT`, `AP1_PRESENT`, `AP0_ENABLE`, `AP1_ENABLE` | Whether debug is open (the BSEC question of PLANS 2.7), as a hello field |
| `BSEC_DBGCR` (+0xE8C), `BSEC_AP_UNLOCK` (+0xE90) | `UNLOCK` [8], `AUTH_HDPL`, `AUTH_SEC`; `UNLOCK` [0] | Confirms the registers `CONFIG_ZPROF_N6_DEBUG_OPEN` writes (BSEC at 0x46009000, secure alias 0x56009000) |
| `DBGMCU_IDCODE` | `DEV_ID` 0x486, `REV_ID` | Device identity and silicon revision in the hello record |

**Peripheral health, the `bus.<dev>.err` gap [SVD]**

- `SPI_SR`: `OVR`, `UDR`, `CRCE`, `MODF`, `TIFRE`.
- `I2C_ISR`: `NACKF`, `BERR`, `ARLO`, `OVR`, `PECERR`, `TIMEOUT`.
- `HPDMA_CxSR` / `GPDMA_CxSR`: `DTEF` transfer error, `ULEF` update link
  error, `USEF` user setting error, `TOF` timeout.
- `FDCAN_ECR` / `PSR`: TX and RX error counters, error passive, bus-off,
  last error code.

The spec says these have "no generic API". With the SVD they become per-block
counters the agent samples (cheapest on the error path in the driver's ISR;
sampling status registers misses flags the driver already cleared).

**Accelerators [SVD]**

- **NPU:** interrupts `NPU_end_of_epoch` (53), `NPU1..3`, `NPUCACHE`, and
  `NPU_DBG_FREEZE`. The NPU's own registers are not in the SVD.
- **Caches:** `CACHEAXI` (NPU AXI cache) and `ICACHE` (GPU texture cache)
  carry read-hit and read-miss monitor counters.

The N6 exists to run neural networks, so an NPU lane on the timeline
(inference epochs against the threads that feed them) and a cache hit-rate
trend are features no generic RTOS tool offers.

**Memory map [SVD]**

`SYSCFG_CM55TCMCR` (`CFGITCMSZ`, `CFGDTCMSZ`) holds the TCM sizes the boot
code chose. The pinned devicetree has no TCM nodes, so the floor plan misses
them today. The `RAMCFG_AXISRAMxCR` `SRAMSD` bits say which AXISRAMs are shut
down.

### 4.3 A register inspector

A view like a debugger's peripheral window, but trended and judged:

- pick registers or fields from the SVD;
- the bridge reads them through the probe while the core runs;
- the values are plotted against thresholds from the thresholds file.

Device registers are Device memory, so the D-cache question of spec section 14
does not arise. Two hazards remain:

- **Reads with side effects.** The SVD marks read-to-clear on only 54
  Ethernet fields. FIFO data registers (`SPI_RXDR`, `USART_RDR`) and
  clear-on-read flags elsewhere are unmarked, so the inspector needs an
  allow-list, never "read anything".
- **RIF.** Isolation may make some blocks unreadable from the debug master
  [unverified].

### 4.4 Gaps in the SVD

- **No Arm core or CoreSight components:**
  - no SCB, so no CFSR, HFSR, MMFAR or BFAR;
  - no NVIC, SysTick, DWT, ITM, ETM, MPU, PMU, or the M55 RAS error records.

  Fault decoding and DWT use need Arm's CMSIS-Core definitions (and the M55
  RAS records for TCM and cache ECC detail, per the M55 TRM [unverified]).
  The trace subsystem is in RM0486 section 78 only.
- `mpuPresent` is `false`; the M55 has an MPU (the DK enables it).
- RIFSC and RISAF registers have no fields.
- `RCC_RSR` carries no `readAction` although its flags are cleared through
  `RMVF`; treat SVD access metadata as incomplete.
- Two defects found while building the workbook: `IAC_IISR5` repeats the
  field names of `IAC_IISR4` and sits at +0x384, leaving +0x380 empty; and
  `DBGMCU_APB4FZ1.DBG_IWDG_STOP` is described as "WWDG stop in debug" while
  its values say IWDG.
- V1.0 from 2024; check for a newer release before generating code from it.

## 5. The N6 on-chip trace subsystem

The STP and CoreSight pages prompted a look at RM0486 section 78 [RM]:

- **Components:** funnel (CSTF), ETF trace FIFO, ETR embedded trace router,
  two replicators, STM, TPIU and SWO, plus CTIs. They are reachable "by the
  debugger and the Cortex-M55 processor via the system AHB-AP and its
  associated EPPB debug bus"; the trace ROM table is at 0xE0080000.
- **ETR:** writes trace "to external memory, using a DMA scatter/gather
  interface over an AXI bus", read back by any bus master or as an ETB. Trace
  capture then needs no trace port; the cost is memory bandwidth and RAM.
- **STM:** software writes to stimulus ports in a 1 MB AXI window
  (0x37F00000 secure, 0x27F00000 non-secure).
  - There are 4,096 ports of 256 B each.
  - The register offset selects the packet type (data, marked, timestamped,
    flag).
  - Packets carry the 8-bit ID of the writing master, and the STM can also
    trace hardware events.
- **Replicator:** the ETR replicator takes the funnel's combined trace (ETM
  and ITM; the STM merges into the same trace bus) to both the ETR and the
  TPIU, filtered by source ID.

What this means for zprof on the N6:

- **Event tracing at one store per event.** The agent writes an event word to
  a stimulus port chosen by event type; hardware timestamps and serializes it.
  No `memcpy` into an RTT buffer, no CTF framing on the CPU.
- **Two drains for one stream.**
  - The ETR fills a RAM ring that the probe reads (RTT-like, but filled by
    hardware), or the agent forwards over USB or Ethernet.
  - Alternatively the TPIU feeds a J-Trace.
- **Instruction trace without a J-Trace.** ETM into the ETR ring makes D-alt
  possible with a probe or even none, bounded by the ring size.
- **Zephyr pieces exist [pin]:**
  - the `arm,stmesp` binding (`dts/bindings/debug/`);
  - the STM log frontend;
  - the STP decoder and the CoreSight deformatter;
  - a Nordic ETR driver (`drivers/debug/debug_nrf_etr.c`) with shared
    `coresight_arm.h` helpers.

  Missing for the N6: an STM devicetree node and a funnel / ETF / ETR setup
  driver.
- **Unknowns [unverified]:**
  - whether secure firmware on the DK can program these components with debug
    closed (BSEC);
  - the ETR's real bandwidth into AXISRAM;
  - the timestamp clock and how it relates to the cycle counter;
  - whether J-Link can read the ETR ring while tracing.

Recommendation 1 is a spike to answer these on the DK before Phase A commits
to CTF over RTT.

## 6. Testing improvements

| Test | Oracle | What it validates |
|---|---|---|
| Thread latency | zyclictest's thread histogram, run on the DK under a known load | zprof's wake-latency and start-latency figures (spec 3.3) agree with an independent measurement, for example within 2 us at p99 |
| ISR latency | zyclictest's IRQ histogram | the ISR lane timing and the ISR-entry timestamp path |
| CPU and stack | thread analyzer report; `cpu_load` idle-hook backend | per-thread CPU, ISR share, stack watermarks (extends the Phase B exit criteria) |
| Profile | perf samples vs instrumentation (`zaru.py profile`) vs ETM | three independent profiles of `loadgen` agree on the top functions |
| Bridge decode | CTF captured on `native_sim` with the file backend (`samples/subsys/tracing`, `prj_native_ctf.conf`); `ctf2perfetto.py` and `trace_viewer.py` on the same file | deterministic golden traces for CI, and decoder agreement with Zephyr's tools |
| zprof trace format | twister tests modeled on `tests/subsys/tracing/tracing_format_module` and `tracing_user_callbacks` | the out-of-tree format builds, every hook it claims fires |
| Fault detail | coredumps from QEMU Cortex-M runs; `coredump_gdbserver.py` | decoding and GDB launch without hardware |
| N6 fault injection | SVD-documented sources: forced lockup (NMI path), a posted write to an unmapped P-AHB address, a RISAF-protected access, IWDG expiry with early wakeup, a DTS alarm threshold set below room temperature | each produces the expected Event with the right cause and address |
| Register constants | a generated subset of `STM32N657.svd` in CI | every field position the agent hard-codes (for example `LCKRSTF` at bit 17) matches the vendor description, and an SVD update shows the diff |

## 7. Corrections and confirmations to the existing docs

Applied to DASHBOARD_SPEC.md and PLANS.md on 2026-10-20.

- **Confirmed:** `hwinfo_stm32` maps the lockup reset only for STM32WB0
  [pin]. Spec section 11 ("lockup flag exists but is not mapped") stands; the
  SVD gives the agent the bit.
- **Confirmed:** `BSEC_DBGCR` and `BSEC_AP_UNLOCK` at BSEC +0xE8C and +0xE90
  [SVD], as PLANS 2.7 assumes.
- **Update spec 11, sampling profiler row:** the Cortex-M perf backend needs
  `CORTEX_M_SYSTICK`, `THREAD_STACK_INFO`, `ARCH_STACKWALK` (and through it
  `EXTRA_EXCEPTION_INFO`), no Non-secure image and no SMP [pin]; the row
  named only `SHELL` and `EXTRA_EXCEPTION_INFO`.
- **Update spec 11, die temperature and power-state rows:** still no Zephyr
  driver, but the agent can read the DTS and the PWR flags directly [SVD].
- **Update spec 3.8:** `bus.<dev>.err` sources per block from the SVD.
- **Update spec 3.3 and 12:** `cpu_load_cb_reg()` exists [pin], and the
  idle-hook backend includes ISR time [docs].
- **Add to spec 11:** zyclictest available on the N6 and the Zynq-7000 A9,
  not on the ZynqMP R5 with the TTC timer [pin]; on-chip STM and ETR on the
  N6 [RM].
- **PLANS 4 and 8:** the trace-format choice (CTF, user hooks, out-of-tree
  header) is exclusive [pin]; record it as a Phase A decision with the STM
  alternative.

## 8. Open questions to settle on hardware

1. Can secure firmware program the N6 funnel, ETR and STM with debug closed,
   and what bandwidth does the ETR sustain into AXISRAM?
2. Which clock drives STM timestamps, and how does it map to DWT `CYCCNT` and
   the kernel cycle counter?
3. The DTS conversion formula and calibration (RM0486 section 33).
4. Which ECC events reach software as status (M55 RAS records) versus only an
   EXTI interrupt, and whether TCM and cache ECC is enabled on the DK.
5. Whether RIF configuration blocks probe reads of any register the inspector
   would use.
6. Whether the FSBL leaves nonzero TCM sizes in `SYSCFG_CM55TCMCR` on the DK.
7. On the ZynqMP R5: a 64-bit cycle counter source for zyclictest, or a port
   of its measurement to the TTC.
