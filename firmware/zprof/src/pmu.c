/*
 * The Armv8.1-M Performance Monitoring Unit: four 32-bit counts from its eight
 * 16-bit event counters, each even counter counting an event and the odd one
 * after it that counter's overflows (the CHAIN event). PMU records go out at
 * every heartbeat and, with ZPROF_PMU_F_SWITCH, right after every SWITCH_OUT,
 * so the host can give each thread its own counts. Zephyr (v4.4.0) does not use
 * the PMU itself; this module owns it.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <zephyr/kernel.h>
#include <zephyr/init.h>
#include <cmsis_core.h>

#include <zprof/proto.h>

#include "zprof_internal.h"

#if !defined(__PMU_PRESENT) || (__PMU_PRESENT == 0U)
#error "CONFIG_ZPROF_PMU: the CPU header says there is no PMU (__PMU_PRESENT)"
#endif
BUILD_ASSERT(__PMU_NUM_EVENTCNT >= 2 * ZPROF_PMU_N, "four chained counts need eight event counters");

#ifdef CONFIG_ZPROF_HOOKS_IN_RAM
#define ZPROF_HOT __ramfunc
#else
#define ZPROF_HOT
#endif

/* What a session starts with: instructions, instruction-cache refills (on an XIP
 * target, code from the flash), data-cache refills and cycles the back end could
 * not issue (memory waits among them). */
static const uint16_t defaults[ZPROF_PMU_N] = {
	ARM_PMU_INST_RETIRED, ARM_PMU_L1I_CACHE_REFILL, ARM_PMU_L1D_CACHE_REFILL,
	ARM_PMU_STALL_BACKEND,
};

struct zprof_pmu zprof_pmu;

#define ALL_COUNTERS (BIT(2 * ZPROF_PMU_N) - 1u)

/* A chained pair read so that the low half's wrap between the two reads cannot
 * tear it. */
static ALWAYS_INLINE uint32_t count(uint32_t n)
{
	volatile uint32_t *c = &PMU->EVCNTR[2u * n];
	uint32_t hi, lo;

	do {
		hi = c[1];
		lo = c[0];
	} while (hi != c[1]);
	return (hi << 16) | (lo & 0xFFFFu);
}

ZPROF_HOT void zprof_pmu_put(uint16_t kind)
{
	if (!zprof_ring.on) {
		return;
	}
	uint32_t a = count(0), b = count(1), c = count(2), d = count(3);

	zprof_put(ZPROF_EV_PMU, kind, 4, a, b, c, d);
}

void zprof_pmu_set(const uint16_t ev[ZPROF_PMU_N], uint32_t flags)
{
	/* under the lock: a switch's PMU record must not fall between the restart
	 * and the new baseline */
	unsigned int key = arch_irq_lock();

	ARM_PMU_CNTR_Disable(ALL_COUNTERS);
	for (uint32_t n = 0; n < ZPROF_PMU_N; n++) {
		if (ev[n] != 0xFFFFu) {
			zprof_pmu.ev[n] = ev[n];
		}
		ARM_PMU_Set_EVTYPER(2u * n, zprof_pmu.ev[n]);
		ARM_PMU_Set_EVTYPER(2u * n + 1u, ARM_PMU_CHAIN);
	}
	ARM_PMU_EVCNTR_ALL_Reset();
	zprof_pmu.flags = flags & ZPROF_PMU_F_SWITCH;
	ARM_PMU_CNTR_Enable(ALL_COUNTERS);
	zprof_pmu_put(ZPROF_PMU_BASE);
	arch_irq_unlock(key);
}

void zprof_pmu_defaults(void)
{
	zprof_pmu_set(defaults, IS_ENABLED(CONFIG_ZPROF_PMU_SWITCH) ? ZPROF_PMU_F_SWITCH : 0u);
}

uint32_t zprof_pmu_auth(void)
{
	return PMU->AUTHSTATUS;
}

static int pmu_init(void)
{
	/* the PMU needs DEMCR.TRCENA, as the DWT does (zprof_init sets it with the DWT
	 * timestamp; set here too for the kernel-cycle one) */
	DCB->DEMCR |= DCB_DEMCR_TRCENA_Msk;
	ARM_PMU_Enable();
	zprof_pmu_defaults();
	return 0;
}
SYS_INIT(pmu_init, PRE_KERNEL_1, 1);
