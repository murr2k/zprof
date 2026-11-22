# SPDX-License-Identifier: Apache-2.0
"""Build zprof's annotated STM32N6 register workbook from ST's SVD.

The workbook re-organizes ST's STM32N657.svd (Apache-2.0) for zprof work:

- Peripherals: one row per block with both bus aliases, bus, clock enable,
  reset, debug freeze, interrupts and the Zephyr devicetree node at the pin.
- Registers and Fields: every register and field with absolute addresses,
  reset values, access, read side effects and write semantics.
- Interrupts: IRQn, the exception number IPSR reports, owner, Zephyr nodes.
- zprof signals: the registers zprof reads. Each one is checked against the
  SVD here, so a renamed register or a moved field fails this script instead
  of the agent.
- Not in SVD: the Arm core, debug and trace registers the SVD leaves out.

Usage, from the repository root with the project venv:

    .venv\\Scripts\\python -I host\\svd\\svd_workbook.py stm32n6-svd.zip <zephyr> out.xlsx
    .venv\\Scripts\\python -I host\\svd\\svd_workbook.py --check [stm32n6-svd.zip]

The SVD is not in the repository: download ST's zip (host/svd/README.md has
the source and the baseline) and pass it as is, or pass STM32N657.svd from
it. The zip is read, never extracted. <zephyr> is a Zephyr tree at the SHA
pinned in firmware/west.yml; it supplies the devicetree mapping
(dts/arm/st/n6) and the DK's enabled nodes.

Version check: every run compares the SVD with BASELINE, the one the curated
tables were reviewed against, and unless --offline with the copy in Arm's
STM32N6xx_DFP on GitHub, which repackages ST's SVD. ST's own site does not
answer non-browser clients, so it cannot be polled. --check does only the
comparison and exits 0 when current, 1 when a different SVD exists, 2 when it
could not tell.
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

REPO = Path(__file__).resolve().parents[2]

# --- Provenance (host/svd/README.md) ---

ST_SVD_URL = 'https://www.st.com/resource/en/svd/stm32n6-svd.zip'
SVD_MEMBER = 'STM32N657.svd'
# The SVD the curated tables were reviewed against. blob is git's object id of the
# file with LF line endings, which is what GitHub lists, so a check downloads nothing.
BASELINE = dict(package='STM32N6_svd_v1r0', version='1.0', blob='08fa4929eec6c1c6d3f69fab7f049c6b3e9e3997')
DFP_REPO, DFP_DIR = 'Open-CMSIS-Pack/STM32N6xx_DFP', 'CMSIS/SVD'

# --- Curated content: categories, our block descriptions, zprof relevance ---

CATEGORY = {
    'sys': 'System control', 'crp': 'Clocks, reset and power', 'sec': 'Security and isolation',
    'dbg': 'Debug', 'mem': 'Memory and caches', 'dma': 'DMA', 'tim': 'Timers and watchdogs',
    'ser': 'Serial buses', 'net': 'Ethernet, USB and CAN', 'sto': 'Storage and external memory',
    'ana': 'Analog', 'aud': 'Audio', 'gfx': 'Graphics and display', 'cam': 'Camera and video',
    'cry': 'Cryptography', 'io': 'GPIO and interrupts', 'env': 'Sensors and monitoring',
}

# type (the SVD template block) -> (category, our description, zprof relevance, zprof note)
TYPE_INFO = {
    'ADC1': ('ana', 'Successive-approximation ADC. ADC1 and ADC2 share the ADC12 common block and interrupt; internal channels measure VBAT and VDDCORE.', 'Medium', 'env.rail: VBAT and VDDCORE through the internal channels (spec 3.9).'),
    'ADC12': ('ana', 'Common registers of ADC1 and ADC2: shared clock, dual mode and common status.', '', ''),
    'ADF': ('aud', 'Audio digital filter: one decimation filter for a digital MEMS microphone (PDM in, PCM out) that can run in low-power modes.', '', ''),
    'BSEC': ('sec', 'Boot and security control: OTP fuses, life-cycle state and the debug unlock registers.', 'High', 'dbg.unlock: BSEC_DBGCR and BSEC_AP_UNLOCK are what CONFIG_ZPROF_N6_DEBUG_OPEN writes (PLANS 2.7).'),
    'CACHEAXI': ('mem', 'AXI cache on the NPU memory path, with read and write hit, miss and allocation monitor counters.', 'Medium', 'npu.cache.*: hit-rate trend (report 4.2).'),
    'CRC': ('cry', 'CRC unit with programmable polynomial and size.', '', ''),
    'CRYP': ('cry', 'Symmetric cipher processor with DMA. Not on the N645 or N647.', '', ''),
    'CSI': ('cam', 'MIPI CSI-2 camera receiver feeding the DCMIPP pixel pipeline.', '', ''),
    'DBGMCU': ('dbg', 'Device ID and revision, debug-in-low-power and trace-clock bits, freeze-on-halt bits per peripheral, and debug access port status.', 'High', 'dbg.*: identity and AP state for the hello record; the debug-safe profile sets the freeze bits (spec 14).'),
    'DCMI': ('cam', 'Parallel camera interface; shares its interrupt with PSSI.', '', ''),
    'DCMIPP': ('cam', 'Camera pixel pipeline: crop, decimate, demosaic, color-convert and scale from DCMI or CSI into memory.', '', ''),
    'DLYBSD': ('sto', 'Delay block that tunes the SDMMC sampling clock phase.', '', ''),
    'DMA2D': ('gfx', 'Chrom-ART 2D DMA: fill, copy, pixel-format conversion and blending.', '', ''),
    'DTS': ('env', 'Digital temperature sensor block: two sensors, alarm A and B thresholds with hysteresis, one interrupt. No Zephyr driver at the pin.', 'High', 'env.die.*: die temperature without a Zephyr driver (spec 3.9, 11).'),
    'ETH': ('net', 'Ethernet MAC with DMA, MMC statistics counters and PTP timestamping (RGMII to the DK PHY). The only block whose read side effects the SVD annotates.', 'Medium', 'net.*: MAC counters; a transport without a probe (PLANS 8).'),
    'EXTI': ('io', 'Extended interrupt and event controller: GPIO lines plus internal events. The SVD lists the system interrupts here: PVD, lockup, cache, TCM and backup-RAM ECC, FPU, posted-write error, NPU, wake-up pins and CTI.', 'High', 'fault.*, mem.ecc.*, npu.*: system interrupts owned by EXTI in the SVD.'),
    'FDCAN1': ('net', 'CAN FD controller, three instances sharing message RAM; error counters and protocol status.', 'Medium', 'can.<n>.err (spec 3.8).'),
    'FMC1': ('sto', 'Flexible memory controller for external SDRAM, SRAM and NOR / NAND.', '', ''),
    'GFXMMU': ('gfx', 'Graphics MMU: maps a virtual framebuffer onto packed physical memory.', '', ''),
    'GFXTIM': ('gfx', 'Graphics timer: frame and line clocks, tearing-effect sync and an event watchdog for the display pipeline.', '', ''),
    'GPDMA': ('dma', 'General-purpose DMA, 16 channels with linked lists; per-channel transfer, link-update and user-setting error flags and a timeout.', 'Medium', 'dma.<ch>.err (spec 3.8).'),
    'HASH': ('cry', 'Hash accelerator (SHA-2 and SHA-3 per the SVD) with HMAC.', '', ''),
    'HDP': ('dbg', 'Hardware debug port: routes internal signals to pins for observation.', '', ''),
    'HPDMA': ('dma', 'High-performance DMA on AXI, 16 channels with linked lists; the same error flags as GPDMA.', 'Medium', 'dma.<ch>.err (spec 3.8).'),
    'IAC': ('sec', 'Illegal access controller: one flag per RIF-protected resource that saw an illegal access, and an interrupt.', 'High', 'fault.iac: firewall violations as Events (report 4.2).'),
    'ICACHE': ('mem', 'Texture cache in front of the GPU2D (named ICACHE in the SVD), with hit and miss monitor counters.', 'Low', 'gpu.cache: hit-rate trend.'),
    'IWDG': ('tim', 'Independent watchdog on the LSI clock: key, prescaler, reload, window, and an early-wakeup interrupt before the reset.', 'High', 'wdt.iwdg.*: early wakeup as a last-gasp hook; ONF says whether it runs.'),
    'I2C1': ('ser', 'I2C controller (four instances) with SMBus support; NACK, bus-error, arbitration-loss, overrun, PEC and timeout flags.', 'Medium', 'bus.i2c.err (spec 3.8).'),
    'I3C1': ('ser', 'MIPI I3C controller or target (two instances), I2C compatible.', '', ''),
    'JPEG': ('cam', 'Hardware JPEG codec.', '', ''),
    'LTDC': ('gfx', 'LCD-TFT display controller with two layers. The SVD also lists the GPU2D and GPU-cache interrupts under it.', '', ''),
    'LPUART1': ('ser', 'Low-power UART that can wake the device from Stop.', '', ''),
    'MCE1': ('sec', 'Memory cipher engine: on-the-fly encryption of external memory (four instances). Not on the N645 or N647.', '', ''),
    'MDF1': ('aud', 'Multi-function digital filter: six filters for PDM microphones and sigma-delta modulators.', '', ''),
    'MDIOS': ('net', 'MDIO target: lets an external MDIO controller access internal registers.', '', ''),
    'OTG1': ('net', "USB 2.0 high-speed OTG controller (two instances); the DK's fast link without a probe (CDC ACM).", 'Medium', 'Transport without a probe (PLANS 2.7, 8).'),
    'PKA': ('cry', 'Public key accelerator (RSA, ECC, modular arithmetic). Not on the N645 or N647.', '', ''),
    'PSSI': ('cam', 'Parallel synchronous slave interface, 8 or 16 bits; shares the DCMI interrupt.', '', ''),
    'PWR': ('crp', 'Power control: voltage scaling, supply monitors (VCORE, PVD, VBAT, backup-domain temperature, VDDIO rails), Stop and Standby flags, wake-up pins.', 'High', 'env.rail.*, pm.*: rail health and power-state entries without CONFIG_PM (spec 3.9, 11).'),
    'RAMCFG': ('mem', 'SRAM configuration: erase, AXISRAM bank shutdown, the FLEXRAM TCM split, and backup-SRAM ECC with single and double error flags and addresses.', 'High', 'mem.ecc.bkpsram, mem.axisram.sd: retained-RAM integrity and the floor plan.'),
    'RCC': ('crp', 'Reset and clock control: oscillators, four PLLs, IC dividers, peripheral clock enables and resets (with set and clear aliases at +0x800 and +0x1000), and the reset-cause flags.', 'High', 'reset.cause in the hello record; clock enables tell the probe which blocks are readable.'),
    'RIFSC': ('sec', 'Resource isolation framework controller: per-peripheral secure, privileged and CID settings. The SVD gives the registers without fields.', 'Medium', 'May block probe reads of some blocks (report 4.3).'),
    'RISAF': ('sec', 'Address-space firewall for memory regions; latches the illegal-access status, attributes and address.', 'High', 'fault.risaf: the address that tripped a RAM protection region.'),
    'RNG': ('cry', 'True random number generator with seed and clock error flags.', '', ''),
    'RTC': ('tim', 'Real-time clock and calendar with alarms, a wake-up timer and timestamping.', 'Low', 'Wall-clock time for soak records when no host clock is available.'),
    'SAES': ('cry', 'Secure AES coprocessor with hardware-derived keys. Not on the N645 or N647.', '', ''),
    'SAI1': ('aud', "Serial audio interface (two instances, two sub-blocks each): I2S, TDM, PCM. SAI1 pins are shared with the DK's 4-bit ETM trace.", 'Low', 'Disable SAI1 in the overlay for ETM trace (PLANS 6, D-alt).'),
    'SDMMC1': ('sto', 'SD, SDIO and eMMC host (two instances).', '', ''),
    'SPDIFRX': ('aud', 'S/PDIF receiver.', '', ''),
    'SPI1': ('ser', 'SPI and I2S controller (six instances) with FIFO and CRC; overrun, underrun, CRC, mode-fault and TI-frame error flags.', 'Medium', 'bus.spi.err (spec 3.8).'),
    'SYSCFG': ('sys', 'System configuration: boot pin state, Cortex-M55 locks, lockup handling, TCM sizes, I/O compensation cells, and the address of a failed posted write.', 'High', 'fault.lockup, fault.pahb, mem.tcm.size, dbg.boot.'),
    'TAMP': ('sec', 'Tamper detection and 32 backup registers kept in the backup domain across resets.', 'High', 'retained.bkp: boot count, last heartbeat sequence, reset snapshot.'),
    'UCPD': ('net', 'USB Type-C and Power Delivery controller.', '', ''),
    'USART1': ('ser', 'USART and UART (ten instances): asynchronous, synchronous, LIN, IrDA, smartcard; overrun, framing, noise and parity flags.', 'Medium', 'uart.<n>.err (spec 3.8); a zprof UART transport.'),
    'VENC': ('cam', 'Hardware video encoder.', '', ''),
    'VREFBUF': ('ana', 'Voltage reference buffer for the ADCs.', '', ''),
    'WWDG': ('tim', 'Window watchdog on the APB clock, with an early-wakeup interrupt. The SVD also lists the IWDG early interrupt (IRQ 18) under it.', 'Medium', 'wdt.wwdg.early.'),
    'XSPIM': ('sto', 'XSPI I/O manager: maps the three XSPI controllers onto the I/O ports.', '', ''),
    'XSPI1': ('sto', 'Extended-SPI controller (three instances) for external flash and PSRAM, memory-mapped.', '', ''),
}

# Signals zprof reads. Fields are checked against the SVD; an empty list means
# the whole register. all_instances applies the row to every block of the type.
SIG_FIELDS = ('domain', 'id', 'meaning', 'block', 'reg', 'fields', 'read_by', 'when', 'zephyr', 'source', 'notes', 'irq', 'all_instances')


def S(domain, sid, meaning, block, reg, fields, read_by, when, zephyr, source, notes='', irq=(), all_instances=False):
    return dict(zip(SIG_FIELDS, (domain, sid, meaning, block, reg, fields, read_by, when, zephyr, source, notes, tuple(irq), all_instances)))


SIGNALS = [
    S('Reset and faults', 'reset.cause', 'Why the last reset happened: lockup, brownout, pin, power-on, software, IWDG, WWDG, low-power', 'RCC', 'RCC_RSR',
      ['LCKRSTF', 'BORRSTF', 'PINRSTF', 'PORRSTF', 'SFTRSTF', 'IWDGRSTF', 'WWDGRSTF', 'LPWRRSTF'], 'agent', 'boot, into the hello record',
      'hwinfo_stm32 maps all but LCKRSTF (lockup is mapped only for STM32WB0)', 'SVD; pin', 'Read before anything clears it, then clear with RMVF.'),
    S('Reset and faults', 'reset.clear', 'Clears the reset flags so the next boot reads fresh ones', 'RCC', 'RCC_RSR', ['RMVF'], 'agent', 'boot, after reset.cause',
      'hwinfo_clear_reset_cause() (generic API)', 'SVD'),
    S('Reset and faults', 'reset.cause.hw', 'Hardware reset flags kept apart from RCC_RSR', 'RCC', 'RCC_HWRSR', [], 'agent', 'boot', 'not checked', 'SVD',
      'Compare with RCC_RSR on the DK before relying on either.'),
    S('Reset and faults', 'fault.lockup.route', 'Turns a core lockup into an NMI, so the fault record is written before the reset', 'SYSCFG', 'SYSCFG_CM55RSTCR',
      ['LOCKUP_RST_EN', 'LOCKUP_NMI_EN'], 'agent', 'boot (write)', 'none', 'SVD', 'IRQ 4 LOCKUP also reaches the NVIC through EXTI.', irq=[4]),
    S('Reset and faults', 'fault.pahb', 'Address of a posted write that failed on the M55 peripheral bus; an imprecise BusFault otherwise loses it', 'SYSCFG',
      'SYSCFG_AHBWP_ERROR_SR', ['PAHB_ERROR_ADDR'], 'agent', 'IRQ 52; fault path', 'none', 'SVD', 'Acknowledge with SYSCFG_CM55PAHBWPR.PAHB_ERROR_ACK.', irq=[52]),
    S('Reset and faults', 'fault.pahb.ack', 'Acknowledges the posted-write error', 'SYSCFG', 'SYSCFG_CM55PAHBWPR', ['PAHB_ERROR_ACK'], 'agent', 'IRQ 52', 'none', 'SVD', irq=[52]),
    S('Reset and faults', 'fault.iac', 'Which RIF-protected resource saw an illegal access (flags 0 to 31)', 'IAC', 'IAC_ISR0', [], 'agent', 'IRQ 13', 'none', 'SVD',
      'Flags continue in IAC_ISR1 to 5; clear through IAC_ICR0 to 5. Map a flag index to its peripheral with the RIF tables in RM0486.', irq=[13]),
    S('Reset and faults', 'fault.risaf', 'Illegal access to a protected memory region', 'RISAF', 'RISAF_IASR', ['CAEF', 'IAEF'], 'agent', 'fault path; heartbeat', 'none', 'SVD',
      'Clear through RISAF_IACR. The SVD describes one RISAF block.'),
    S('Reset and faults', 'fault.risaf.attr', 'Attributes of the illegal access: compartment ID, privilege, security, read or write', 'RISAF', 'RISAF_IAESR',
      ['IACID', 'IAPRIV', 'IASEC', 'IANRW'], 'agent', 'with fault.risaf', 'none', 'SVD'),
    S('Reset and faults', 'fault.risaf.addr', 'Address of the illegal access', 'RISAF', 'RISAF_IADDR', ['IADD'], 'agent', 'with fault.risaf', 'none', 'SVD'),
    S('Reset and faults', 'fault.rif.tamper', 'RIF tamper event (the SVD describes laser-attack detection)', None, None, [], 'agent', 'IRQ 12', 'none', 'SVD', irq=[12]),
    S('Reset and faults', 'fault.fpu', 'Floating-point exception flags routed to an interrupt (FPU safety flag)', 'SYSCFG', 'SYSCFG_CM55CR', ['FPU_IT_EN'], 'agent',
      'boot (write); IRQ 8', 'none', 'SVD', 'Counts FP exceptions such as divide by zero or overflow; which flags each bit enables is in RM0486 [unverified].', irq=[8]),
    S('Watchdogs', 'wdt.iwdg.early', 'Early-wakeup interrupt before the independent watchdog resets the board: a last-gasp hook', 'IWDG', 'IWDG_EWCR', ['EWIT', 'EWIE'],
      'agent', 'boot (write); IRQ 18', 'CONFIG_IWDG_STM32_EARLY_WAKEUP with a callback', 'SVD; pin', 'The SVD lists IRQ 18 as WDGLS_EARLY under WWDG.', irq=[18]),
    S('Watchdogs', 'wdt.iwdg.state', 'Whether the IWDG runs, and its early-wakeup flag', 'IWDG', 'IWDG_SR', ['ONF', 'EWIF'], 'agent', 'heartbeat', 'driver internal', 'SVD',
      'Clear EWIF with IWDG_ICR.EWIC.'),
    S('Watchdogs', 'wdt.wwdg.early', 'Window watchdog early-wakeup interrupt', 'WWDG', 'WWDG_CFR', ['EWI'], 'agent', 'boot (write); IRQ 19', 'not checked', 'SVD',
      'Flag in WWDG_SR.EWIF.', irq=[19]),
    S('Retained state', 'retained.bkp', 'Backup registers kept across resets: boot count, last heartbeat sequence, reset snapshot', 'TAMP', 'TAMP_BKP0R', ['BKP'], 'agent',
      'heartbeat (write); boot (read)', 'not checked', 'SVD', 'TAMP_BKP0R to BKP31R, without enabling backup SRAM. Writes need PWR_DBPCR.DBP.'),
    S('Retained state', 'retained.dbp', 'Write access to the backup domain', 'PWR', 'PWR_DBPCR', ['DBP'], 'agent', 'boot (write)', 'clock and RTC drivers set it', 'SVD'),
    S('Memory', 'mem.ecc.cache', 'ECC error in the M55 caches', None, None, [], 'agent', 'IRQ 5', 'none', 'SVD',
      'Detail is in the M55 RAS error records, which the SVD does not describe [unverified].', irq=[5]),
    S('Memory', 'mem.ecc.tcm', 'ECC error in the TCM', None, None, [], 'agent', 'IRQ 6', 'none', 'SVD', 'As for the caches.', irq=[6]),
    S('Memory', 'mem.ecc.bkpsram', 'Backup SRAM: single error corrected (SEC) or double error detected (DED)', 'RAMCFG', 'RAMCFG_BKPSRAMISR', ['SEC', 'DED'], 'agent',
      'IRQ 7; heartbeat', 'none', 'SVD', 'Clear with RAMCFG_BKPSRAMICR. A retained fault record must not sit in RAM with uncorrected errors.', irq=[7]),
    S('Memory', 'mem.ecc.bkpsram.sea', 'Address of the last corrected single error', 'RAMCFG', 'RAMCFG_BKPSRAMESEAR', ['ESEA'], 'agent', 'with mem.ecc.bkpsram', 'none', 'SVD'),
    S('Memory', 'mem.ecc.bkpsram.dea', 'Address of the last double error', 'RAMCFG', 'RAMCFG_BKPSRAMEDEAR', ['EDEA'], 'agent', 'with mem.ecc.bkpsram', 'none', 'SVD'),
    S('Memory', 'mem.ecc.bkpsram.enable', 'Backup SRAM ECC enable', 'RAMCFG', 'RAMCFG_BKPSRAMCR', ['ECCE'], 'agent', 'boot', 'none', 'SVD'),
    S('Memory', 'mem.tcm.size', 'TCM sizes chosen at boot; the floor plan has no TCM rows today', 'SYSCFG', 'SYSCFG_CM55TCMCR', ['CFGITCMSZ', 'CFGDTCMSZ'], 'agent or probe',
      'boot', 'none (no TCM nodes in the pinned devicetree)', 'SVD', 'Size encoding in RM0486.'),
    S('Memory', 'mem.flexram', 'FLEXRAM split between ITCM and DTCM', 'RAMCFG', 'RAMCFG_FLEXRAMCR', ['ITCMCFG', 'DTCMCFG'], 'agent or probe', 'boot', 'none', 'SVD'),
    S('Memory', 'mem.axisram.sd', 'AXISRAM bank shut down (AXISRAM3 to 6 are disabled in the pinned devicetree)', 'RAMCFG', 'RAMCFG_AXISRAM3CR', ['SRAMSD'], 'probe',
      'connect', 'none', 'SVD', 'The same bit in RAMCFG_AXISRAM2CR and AXISRAM4CR to 6CR.'),
    S('Memory', 'mem.clock', 'Memory clock enables, including backup SRAM, FLEXRAM and the AXISRAMs', 'RCC', 'RCC_MEMENR',
      ['AXISRAM3EN', 'AXISRAM4EN', 'AXISRAM5EN', 'AXISRAM6EN', 'BKPSRAMEN', 'FLEXRAMEN'], 'probe', 'connect', 'clock_control', 'SVD'),
    S('Environment', 'env.die.ts0', 'Temperature sensor 0 sample', 'DTS', 'DTS_TS0SDIFDATAR', ['SAMPLE_DATA', 'SAMPLE_TYPE', 'SAMPLE_FAULT'], 'agent', 'heartbeat',
      'none (no N6 DTS driver)', 'SVD', 'Conversion to degrees in RM0486 section 33 [unverified].'),
    S('Environment', 'env.die.ts1', 'Temperature sensor 1 sample', 'DTS', 'DTS_TS1SDIFDATAR', ['SAMPLE_DATA', 'SAMPLE_TYPE', 'SAMPLE_FAULT'], 'agent', 'heartbeat',
      'none (no N6 DTS driver)', 'SVD'),
    S('Environment', 'env.die.alarm', 'Alarm A threshold and hysteresis for sensor 0', 'DTS', 'DTS_TS0ALARMA_CFGR', ['ALARMA_THRESH', 'HYSTA_THRESH'], 'agent',
      'boot (write)', 'none', 'SVD', 'Alarm B in DTS_TS0ALARMB_CFGR; sensor 1 the same at TS1.'),
    S('Environment', 'env.die.irq', 'Alarm and fault status for sensor 0', 'DTS', 'DTS_TS0_ISR', ['IRQ_STATUS_ALARMA', 'IRQ_STATUS_ALARMB', 'IRQ_STATUS_FAULT'],
      'agent', 'IRQ 2', 'none', 'SVD', 'Clear with DTS_TS0_ICR; sensor 1 at DTS_TS1_ISR.', irq=[2]),
    S('Environment', 'env.rail.vcore', 'Core supply below or above its window', 'PWR', 'PWR_CR3', ['VCOREMONEN', 'VCOREL', 'VCOREH'], 'agent', 'heartbeat', 'none', 'SVD'),
    S('Environment', 'env.pvd', 'Programmable voltage detector output: early brown-out warning', 'PWR', 'PWR_CR2', ['PVDEN', 'PVDO'], 'agent', 'IRQ 0; heartbeat',
      'none', 'SVD', irq=[0]),
    S('Environment', 'env.vbat', 'VBAT and backup-domain temperature out of range', 'PWR', 'PWR_BDCR1', ['MONEN', 'VBATL', 'VBATH', 'TEMPL', 'TEMPH'], 'agent',
      'heartbeat', 'none', 'SVD'),
    S('Environment', 'env.rail.vddio', 'Supply ready flags: VDDIO2, VDDIO3, USB 3.3 V, analog', 'PWR', 'PWR_SVMCR3', ['VDDIO2RDY', 'VDDIO3RDY', 'USB33RDY', 'ARDY'],
      'agent', 'heartbeat', 'none', 'SVD', 'VDDIO4 and VDDIO5 in PWR_SVMCR1 and 2.'),
    S('Environment', 'env.vos', 'Voltage scaling requested and active; the CPU clock limit depends on it', 'PWR', 'PWR_VOSCR', ['VOS', 'ACTVOS', 'ACTVOSRDY'], 'agent',
      'hello; on change', 'set by SoC init', 'SVD', 'Record it with clk.cpu.'),
    S('Environment', 'env.iocell', 'I/O compensation cell ready (VDDIO1 shown)', 'SYSCFG', 'SYSCFG_VDDIO1CCSR', ['READY'], 'agent', 'heartbeat (DVT)', 'none', 'SVD',
      'The same for VDDIO2 to 4 and VDDIO.'),
    S('Power states', 'pm.stop_standby', 'The CPU entered Stop or Standby since the flags were cleared', 'PWR', 'PWR_CPUCR', ['STOPF', 'SBF', 'CSSF'], 'agent',
      'wake-up; heartbeat', 'none (CONFIG_PM is not available on the N6)', 'SVD', 'Clear with CSSF after reading.'),
    S('Power states', 'pm.wakeup', 'Which wake-up pin fired', 'PWR', 'PWR_WKUPSR', ['WKUPF1', 'WKUPF2', 'WKUPF3', 'WKUPF4'], 'agent', 'wake-up', 'none', 'SVD',
      irq=[189]),
    S('Debug', 'dbg.id', 'Device ID and silicon revision for the hello record', 'DBGMCU', 'DBGMCU_IDCODE', ['DEV_ID', 'REV_ID'], 'agent or probe', 'hello',
      'not checked', 'SVD', 'DEV_ID reads 0x486 on the N6.'),
    S('Debug', 'dbg.ap', 'Debug access ports present and enabled (AP1 is the M55)', 'DBGMCU', 'DBGMCU_SR', ['AP0_PRESENT', 'AP1_PRESENT', 'AP0_ENABLE', 'AP1_ENABLE'],
      'agent', 'hello', 'none', 'SVD', 'Answers whether debug is open (PLANS 2.7).'),
    S('Debug', 'dbg.lowpower', 'Keep debug and the trace clock alive in Sleep, Stop and Standby', 'DBGMCU', 'DBGMCU_CR',
      ['DBG_SLEEP', 'DBG_STOP', 'DBG_STANDBY', 'DBGCLKEN', 'TRACECLKEN'], 'agent', 'boot (debug-safe profile)', 'none', 'SVD',
      'RTT and trace survive low-power states only with these set.'),
    S('Debug', 'dbg.freeze.iwdg', 'Freeze the IWDG and the RTC while the core is halted', 'DBGMCU', 'DBGMCU_APB4FZ1', ['DBG_IWDG_STOP', 'DBG_RTC_STOP'], 'agent',
      'probe attach', 'none', 'SVD', 'Without it a breakpoint in Ozone or GDB lets the IWDG reset the board.'),
    S('Debug', 'dbg.freeze.wwdg', 'Freeze the WWDG while the core is halted', 'DBGMCU', 'DBGMCU_APB1LFZ1', ['DBG_WWDG1_STOP'], 'agent', 'probe attach', 'none', 'SVD',
      'Timers freeze through the same register and DBGMCU_APB2FZ1.'),
    S('Debug', 'dbg.freeze.npu', 'Freeze the NPU while the core is halted', 'DBGMCU', 'DBGMCU_AHB5FZ1', ['NPU_DBG_FREEZE'], 'agent', 'probe attach', 'none', 'SVD',
      'HPDMA channels in the same register, GPDMA channels in DBGMCU_AHB1FZ1.'),
    S('Debug', 'dbg.unlock', 'Opens debug in Flash boot (0xB4, written by secure code once per reset)', 'BSEC', 'BSEC_DBGCR', ['UNLOCK', 'AUTH_HDPL', 'AUTH_SEC'],
      'agent', 'boot (write)', 'none; CONFIG_ZPROF_N6_DEBUG_OPEN (planned)', 'SVD; RM0486 3.9', 'PLANS 2.7.'),
    S('Debug', 'dbg.ap_unlock', 'Unlocks the access port (0xB4)', 'BSEC', 'BSEC_AP_UNLOCK', ['UNLOCK'], 'agent', 'boot (write)', 'none', 'SVD; RM0486 4.5.19'),
    S('Debug', 'dbg.boot', 'Boot pin state: Flash boot (debug closed until unlocked) or development boot', 'SYSCFG', 'SYSCFG_BOOTSR', ['BOOT0', 'BOOT1'], 'agent',
      'hello', 'none', 'SVD', 'Tells the bridge whether RTT can work without the unlock.'),
    S('Debug', 'dbg.cti', 'Cross-trigger interrupts (debug monitor)', None, None, [], 'agent', 'IRQ 190, 191', 'debug monitor (spec 14)', 'SVD', irq=[190, 191]),
    S('Bus errors', 'bus.spi.err', 'SPI overrun, underrun, CRC error, mode fault, TI frame error', 'SPI1', 'SPI_SR', ['OVR', 'UDR', 'CRCE', 'MODF', 'TIFRE'],
      'agent (driver error path)', 'event', 'no generic API', 'SVD', 'All six SPIs.', all_instances=True),
    S('Bus errors', 'bus.i2c.err', 'I2C NACK, bus error, arbitration loss, overrun, PEC error, timeout', 'I2C1', 'I2C_ISR',
      ['NACKF', 'BERR', 'ARLO', 'OVR', 'PECERR', 'TIMEOUT'], 'agent (driver error path)', 'event', 'no generic API', 'SVD', 'All four I2Cs.', all_instances=True),
    S('Bus errors', 'uart.err', 'UART overrun, framing error, noise, parity error', 'USART1', 'USART_ISR_FIFO_ENABLED', ['ORE', 'FE', 'NE', 'PE'], 'agent',
      'event', 'uart_err_check()', 'SVD', 'All ten U(S)ARTs. The SVD has two views of this register at one offset (FIFO enabled and disabled).',
      all_instances=True),
    S('Bus errors', 'dma.hpdma.err', 'Channel transfer error, link-update error, user-setting error, timeout', 'HPDMA', 'HPDMA_C0SR', ['DTEF', 'ULEF', 'USEF', 'TOF'],
      'agent (DMA callback)', 'event', 'DMA callback status', 'SVD', 'Channel 0 shown; C1SR to C15SR are the same.'),
    S('Bus errors', 'dma.gpdma.err', 'Channel transfer error, link-update error, user-setting error, timeout', 'GPDMA', 'GPDMA_C0SR', ['DTEF', 'ULEF', 'USEF', 'TOF'],
      'agent (DMA callback)', 'event', 'DMA callback status', 'SVD', 'Channel 0 shown; C1SR to C15SR are the same.'),
    S('Bus errors', 'can.err', 'CAN transmit and receive error counters, receive error passive, error logging', 'FDCAN1', 'FDCAN_ECR', ['TEC', 'REC', 'RP', 'CEL'],
      'agent', 'heartbeat', 'can_get_state(), can_stats_get_*()', 'SVD', 'All three FDCANs.', all_instances=True),
    S('Bus errors', 'can.state', 'CAN last error code, error passive, warning, bus-off', 'FDCAN1', 'FDCAN_PSR', ['LEC', 'EP', 'EW', 'BO'], 'agent', 'heartbeat',
      'can_get_state()', 'SVD', 'All three FDCANs.', all_instances=True),
    S('Accelerators', 'npu.epoch', 'NPU end of epoch (an inference step completed)', None, None, [], 'agent', 'IRQ 53', 'not checked', 'SVD',
      'IRQ 54 to 56 are NPU lines 1 to 3, IRQ 57 the NPU cache.', irq=[53, 54, 55, 56, 57]),
    S('Accelerators', 'npu.cache.hit', 'NPU AXI cache read hits', 'CACHEAXI', 'CACHEAXI_RHMONR', ['RHITMON'], 'probe or agent', 'heartbeat', 'none', 'SVD'),
    S('Accelerators', 'npu.cache.miss', 'NPU AXI cache read misses', 'CACHEAXI', 'CACHEAXI_RMMONR', ['RMISSMON'], 'probe or agent', 'heartbeat', 'none', 'SVD'),
    S('Accelerators', 'npu.cache.monitor', 'Enables and resets the read hit and miss monitors', 'CACHEAXI', 'CACHEAXI_CR1', ['RHITMEN', 'RMISSMEN', 'RHITMRST', 'RMISSMRST'],
      'agent', 'boot (write)', 'none', 'SVD'),
    S('Accelerators', 'gpu.cache', 'GPU2D texture cache hits and misses', 'ICACHE', 'ICACHE_HMONR', ['HITMON'], 'probe or agent', 'heartbeat', 'none', 'SVD',
      'Misses in ICACHE_MMONR.MISSMON; enable in ICACHE_CR (HITMEN, MISSMEN).'),
    S('Accelerators', 'gpu.irq', 'GPU2D done, GPU2D error, GPU cache', None, None, [], 'agent', 'IRQ 65, 66, 67', 'not checked', 'SVD', irq=[65, 66, 67]),
    S('Clocks', 'clk.enable', 'Which peripheral clocks are on (one register per bus; APB1 low shown)', 'RCC', 'RCC_APB1LENR', [], 'probe', 'connect',
      'clock_control_on()', 'SVD', 'RCC_AHB1ENR to RCC_APB5ENR; the Peripherals tab names each block\'s bit. A block with its clock off reads as zero or faults.'),
]

# Arm core, debug and trace registers the SVD leaves out.
ARCH = 'Armv8-M ARM (architectural, not in the SVD)'
NOT_IN_SVD = [
    ('SCB', 'CPUID', 0xE000ED00, 'Processor part number and revision', 'Hello record: the M55 revision', ARCH),
    ('SCB', 'ICSR', 0xE000ED04, 'Interrupt control and state; VECTACTIVE is the active exception number', 'Per-IRQ identity from the probe (the agent reads IPSR)', ARCH),
    ('SCB', 'VTOR', 0xE000ED08, 'Vector table offset', 'Which image is running', ARCH),
    ('SCB', 'AIRCR', 0xE000ED0C, 'Priority grouping, system reset request', '', ARCH),
    ('SCB', 'SCR', 0xE000ED10, 'System control: SLEEPDEEP, sleep on exit', 'Power-state context', ARCH),
    ('SCB', 'CCR', 0xE000ED14, 'Configuration and control: unaligned and divide-by-zero trapping, cache enables', 'Fault configuration in the hello record', ARCH),
    ('SCB', 'SHCSR', 0xE000ED24, 'System handler control and state', '', ARCH),
    ('SCB', 'CFSR', 0xE000ED28, 'Configurable fault status (MemManage, BusFault, UsageFault)', 'fault.fatal record', ARCH),
    ('SCB', 'HFSR', 0xE000ED2C, 'HardFault status', 'fault.fatal record', ARCH),
    ('SCB', 'DFSR', 0xE000ED30, 'Debug fault status: halt, breakpoint, watchpoint', 'Debug monitor events', ARCH),
    ('SCB', 'MMFAR', 0xE000ED34, 'MemManage fault address', 'fault.fatal record', ARCH),
    ('SCB', 'BFAR', 0xE000ED38, 'BusFault address, precise faults only', 'fault.fatal record; imprecise posted writes need SYSCFG_AHBWP_ERROR_SR', ARCH),
    ('SCB', 'CPACR', 0xE000ED88, 'Coprocessor access (FPU, MVE)', '', ARCH),
    ('SCB', 'SFSR', 0xE000EDE4, 'Secure fault status', 'fault.fatal on a TrustZone image', ARCH),
    ('SCB', 'SFAR', 0xE000EDE8, 'Secure fault address', 'fault.fatal on a TrustZone image', ARCH),
    ('Debug', 'DHCSR', 0xE000EDF0, 'Debug halting control and status (C_DEBUGEN, S_HALT)', 'Bridge: whether a debugger holds the core', ARCH),
    ('Debug', 'DEMCR', 0xE000EDFC, 'Debug exception and monitor control; TRCENA enables DWT and ITM, MON_EN the debug monitor', 'Must be set for CYCCNT and ITM', ARCH),
    ('SysTick', 'SYST_CSR', 0xE000E010, 'SysTick control and status', 'The N6 system timer at the pin', ARCH),
    ('SysTick', 'SYST_RVR', 0xE000E014, 'SysTick reload value', 'Tick period', ARCH),
    ('SysTick', 'SYST_CVR', 0xE000E018, 'SysTick current value', '', ARCH),
    ('NVIC', 'NVIC_ISER0', 0xE000E100, 'Interrupt set-enable, 32 IRQs per register', 'Which IRQs are enabled', ARCH),
    ('NVIC', 'NVIC_ISPR0', 0xE000E200, 'Interrupt set-pending', 'Pending IRQs while the core is halted', ARCH),
    ('NVIC', 'NVIC_IABR0', 0xE000E300, 'Interrupt active bits', 'Active IRQs, read from the probe', ARCH),
    ('NVIC', 'NVIC_IPR0', 0xE000E400, 'Interrupt priority, one byte per IRQ (8 bits implemented per the SVD cpu block)', 'IRQ priority table in the hello record', ARCH),
    ('MPU', 'MPU_TYPE', 0xE000ED90, 'Number of MPU regions. The SVD says mpuPresent false; the M55 has an MPU', '', ARCH),
    ('MPU', 'MPU_CTRL', 0xE000ED94, 'MPU enable', '', ARCH),
    ('FPU', 'FPCCR', 0xE000EF34, 'Floating-point context control (lazy stacking)', 'Context-switch cost', ARCH),
    ('ITM', 'ITM_STIM0', 0xE0000000, 'Stimulus port 0', 'Software trace over SWO', ARCH),
    ('ITM', 'ITM_TCR', 0xE0000E80, 'ITM trace control', '', ARCH),
    ('DWT', 'DWT_CTRL', 0xE0001000, 'DWT control: CYCCNTENA and the profiling counter enables', 'Timing functions', ARCH),
    ('DWT', 'DWT_CYCCNT', 0xE0001004, 'Cycle counter', 'Timestamps; whether it counts with debug closed is open (PLANS 9)', ARCH),
    ('DWT', 'DWT_CPICNT', 0xE0001008, 'Extra cycles per instruction (8-bit, wraps)', 'Profile: stall cycles', ARCH),
    ('DWT', 'DWT_EXCCNT', 0xE000100C, 'Exception overhead cycles (8-bit, wraps)', 'Profile: interrupt entry and exit cost', ARCH),
    ('DWT', 'DWT_SLEEPCNT', 0xE0001010, 'Sleep cycles (8-bit, wraps)', '', ARCH),
    ('DWT', 'DWT_LSUCNT', 0xE0001014, 'Load-store extra cycles (8-bit, wraps)', '', ARCH),
    ('DWT', 'DWT_FOLDCNT', 0xE0001018, 'Folded instructions (8-bit, wraps)', '', ARCH),
    ('DWT', 'DWT_PCSR', 0xE000101C, 'PC sample, readable while the core runs', 'A statistical profile from the probe with no target code [unverified on the M55]', ARCH),
    ('FPB', 'FP_CTRL', 0xE0002000, 'Flash patch and breakpoint control', 'Hardware breakpoints available', ARCH),
    ('PMU', 'PMU_EVCNTR0', 0xE0003000, 'Armv8.1-M PMU event counter 0', 'PMU counters (spec 11: no PMU API on the N6 at the pin)', 'Armv8.1-M ARM; check against the M55 TRM'),
    ('PMU', 'PMU_CCNTR', 0xE000307C, 'PMU cycle counter', '', 'Armv8.1-M ARM; check against the M55 TRM'),
    ('PMU', 'PMU_CTRL', 0xE0003E04, 'PMU control', '', 'Armv8.1-M ARM; check against the M55 TRM'),
    ('TPIU', 'TPIU_SSPSR', 0xE0040000, 'Trace port supported sizes', 'ETM on CN10', 'Arm PPB location; the N6 trace subsystem is in RM0486 78 [unverified]'),
    ('ETM', 'TRCPRGCTLR', 0xE0041004, 'ETM programming control', 'Instruction trace (PLANS Phase D-alt)', 'Arm PPB location [unverified on the N6]'),
    ('Trace', 'ROM table', 0xE0080000, 'Trace subsystem ROM table: funnel, ETF, ETR, STM, CTI, TPIU', 'Discovery for the STM and ETR spike', 'RM0486 78'),
    ('Trace', 'STM stimulus, non-secure', 0x27F00000, 'STM stimulus window, 1 MB: 4096 ports of 256 B; the offset selects data, marked, timestamped or flag packets', 'Event tracing at one store per event (report 5)', 'RM0486 78'),
    ('Trace', 'STM stimulus, secure', 0x37F00000, 'Secure alias of the STM stimulus window', '', 'RM0486 78'),
    ('M55 RAS', 'Error records', None, 'Cache and TCM ECC error detail', 'Detail behind IRQ 5 and 6', 'Cortex-M55 TRM [unverified: address not extracted]'),
]

# Interrupt categories where the owning block in the SVD is not the subject.
IRQ_CATEGORY = {0: 'crp', 4: 'Faults', 5: 'mem', 6: 'mem', 7: 'mem', 8: 'Faults', 12: 'sec', 13: 'sec', 18: 'tim', 52: 'Faults',
                53: 'NPU', 54: 'NPU', 55: 'NPU', 56: 'NPU', 57: 'NPU', 65: 'gfx', 66: 'gfx', 67: 'gfx', 189: 'crp', 190: 'dbg', 191: 'dbg'}

# Names that differ between a block and its RCC enable / reset bit or DBGMCU freeze bit.
RCC_ALIAS = {'ADC1': 'ADC12', 'ADC2': 'ADC12', 'ADF': 'ADF1', 'GPDMA': 'GPDMA1', 'HPDMA': 'HPDMA1', 'FMC1': 'FMC', 'ETH': 'ETH1',
             'FDCAN1': 'FDCAN', 'FDCAN2': 'FDCAN', 'FDCAN3': 'FDCAN', 'SPDIFRX': 'SPDIFRX1', 'UCPD': 'UCPD1', 'DBGMCU': 'DBG', 'WWDG': 'WWDG1'}

# Reads that change state. Keyed by type; the SVD marks only Ethernet.
READ_EFFECTS = {
    'SPI1': {'SPI_RXDR': 'pops the RX FIFO'},
    'USART1': {'USART_RDR': 'pops received data and clears RXNE'},
    'LPUART1': {'LPUART_RDR': 'pops received data and clears RXNE'},
    'I2C1': {'I2C_RXDR': 'pops received data and clears RXNE'},
    'I3C1': {'I3C_RDR': 'pops the RX FIFO', 'I3C_RDWR': 'pops the RX FIFO'},
    'SAI1': {'SAI_ADR': 'pops the FIFO', 'SAI_BDR': 'pops the FIFO'},
    'ADC1': {'ADC_DR': 'clears the end-of-conversion flag'},
    'RNG': {'RNG_DR': 'consumes a random word'},
    'DCMI': {'DCMI_DR': 'pops the FIFO'},
    'PSSI': {'PSSI_DR': 'pops the FIFO'},
    'JPEG': {'JPEG_DOR': 'pops the output FIFO'},
    'CRYP': {'CRYP_DOUTR': 'pops the output FIFO'},
    'SAES': {'SAES_DOUTR': 'pops the output FIFO'},
    'OTG1': {'OTG_GRXSTSP': 'pops the RX status queue'},
}
READ_EFFECTS_RE = {'MDF1': (r'_DFLT\d+DR$', 'pops the filter output FIFO'), 'ADF': (r'_DFLT\d+DR$', 'pops the filter output FIFO'),
                   'SDMMC1': (r'_FIFOR\d+$', 'pops the data FIFO'), 'SPDIFRX': (r'_FMT\d_DR$', 'pops the FIFO')}
READ_CARE = {'RTC': {'RTC_SSR': 'locks the calendar shadow registers until RTC_DR is read',
                     'RTC_TR': 'locks the calendar shadow registers until RTC_DR is read'}}

# Defects found by reading, which svd_defects() cannot detect: (block, register, field,
# wrong text in the field description, report). One that ST fixes drops out.
KNOWN_DEFECTS = [('DBGMCU', 'DBGMCU_APB4FZ1', 'DBG_IWDG_STOP', 'WWDG',
                  'DBGMCU_APB4FZ1.DBG_IWDG_STOP is described as "WWDG stop in debug"; its enumerated values say IWDG.')]

MOD_WRITE = {'oneToClear': 'write 1 clears', 'oneToSet': 'write 1 sets', 'oneToToggle': 'write 1 toggles', 'zeroToClear': 'write 0 clears',
             'zeroToSet': 'write 0 sets', 'zeroToToggle': 'write 0 toggles', 'clear': 'any write clears', 'set': 'any write sets', 'modify': 'a write modifies'}


# --- SVD model ---

def txt(e, tag):
    return ' '.join((e.findtext(tag) or '').split()) if e is not None else ''


def num(s, default=None):
    s = (s or '').strip().lower()
    if not s:
        return default
    if s.startswith('#'):
        return int(s[1:].replace('x', '0'), 2)
    if s.startswith('0x'):
        return int(s, 16)
    if s.startswith('0b'):
        return int(s[2:], 2)
    return int(s, 10)


def hx(v, width=8):
    return '' if v is None else f'0x{v:0{width}X}'


def natural(s):
    return [int(p) if p.isdigit() else p for p in re.split(r'(\d+)', s)]


def bits(lsb, width):
    return f'[{lsb}]' if width == 1 else f'[{lsb + width - 1}:{lsb}]'


def inherit(defaults, el):
    d = dict(defaults)
    for k in ('size', 'access', 'resetValue', 'resetMask'):
        v = txt(el, k)
        if v:
            d[k] = v
    return d


def dim_names(el):
    n = num(txt(el, 'dim'))
    if not n:
        return [None], 0
    idx = txt(el, 'dimIndex')
    if '-' in idx and ',' not in idx:
        a, b = idx.split('-')
        names = [str(i) for i in range(int(a), int(b) + 1)] if a.isdigit() else [chr(c) for c in range(ord(a), ord(b) + 1)]
    elif idx:
        names = [x.strip() for x in idx.split(',')]
    else:
        names = [str(i) for i in range(n)]
    return names, num(txt(el, 'dimIncrement'), 0)


def parse_fields(r, access):
    out = []
    fs = r.find('fields')
    for f in (fs.findall('field') if fs is not None else []):
        if f.find('bitOffset') is not None:
            lsb, width = num(txt(f, 'bitOffset')), num(txt(f, 'bitWidth'), 1)
        elif f.find('lsb') is not None:
            lsb = num(txt(f, 'lsb'))
            width = num(txt(f, 'msb')) - lsb + 1
        else:
            m = re.match(r'\[(\d+):(\d+)\]', txt(f, 'bitRange'))
            lsb, width = int(m[2]), int(m[1]) - int(m[2]) + 1
        enums = [(txt(ev, 'name'), txt(ev, 'value'), txt(ev, 'description')) for ev in f.iter('enumeratedValue')]
        out.append(dict(name=txt(f, 'name'), lsb=lsb, width=width, access=txt(f, 'access') or access, desc=txt(f, 'description'),
                        enums=enums, read_action=txt(f, 'readAction'), mod_write=txt(f, 'modifiedWriteValues')))
    return sorted(out, key=lambda x: -x['lsb'])


def expand(el, base_off, defaults):
    """Registers from a register or cluster element, offsets relative to the block."""
    names, inc = dim_names(el)
    for i, ix in enumerate(names):
        off = base_off + num(txt(el, 'addressOffset'), 0) + i * inc
        d = inherit(defaults, el)
        if el.tag == 'cluster':
            for child in el:
                if child.tag in ('register', 'cluster'):
                    yield from expand(child, off, d)
            continue
        name = txt(el, 'name')
        if ix is not None:
            name = name.replace('[%s]', ix).replace('%s', ix)
        access = d.get('access', '')
        yield dict(name=name, offset=off, size=num(d.get('size'), 32), access=access, reset=num(d.get('resetValue')),
                   reset_mask=num(d.get('resetMask')), desc=txt(el, 'description'), read_action=txt(el, 'readAction'),
                   fields=parse_fields(el, access))


def load_svd(data):
    root = ET.fromstring(data)
    dev_defaults = inherit({}, root)
    elems = {txt(p, 'name'): p for p in root.find('peripherals').findall('peripheral')}
    blocks, irqs = {}, defaultdict(list)
    for name, p in elems.items():
        for i in p.findall('interrupt'):
            irqs[num(txt(i, 'value'))].append(dict(name=txt(i, 'name'), owner=name, desc=txt(i, 'description')))
        if name.endswith('_S'):
            continue
        tmpl = elems[p.get('derivedFrom')] if p.get('derivedFrom') else p
        src = p if p.find('registers') is not None else tmpl
        d = inherit(inherit(dev_defaults, tmpl), p)
        regs = []
        for el in src.find('registers'):
            if el.tag in ('register', 'cluster'):
                regs.extend(expand(el, 0, d))
        ab = p.find('addressBlock') if p.find('addressBlock') is not None else tmpl.find('addressBlock')
        sec = elems.get(name + '_S')
        blocks[name] = dict(
            name=name, type=p.get('derivedFrom') or name, group=txt(p, 'groupName') or txt(tmpl, 'groupName'),
            svd_desc=txt(p, 'description') or txt(tmpl, 'description'), base_ns=num(txt(p, 'baseAddress')),
            base_s=num(txt(sec, 'baseAddress')) if sec is not None else None, size=num(txt(ab, 'size')) if ab is not None else None,
            regs=sorted(regs, key=lambda r: r['offset']), irqs=[])
    for n, lst in irqs.items():
        for it in lst:
            owner = it['owner'][:-2] if it['owner'].endswith('_S') else it['owner']
            if owner in blocks:
                blocks[owner]['irqs'].append((n, it['name']))
    cpu = root.find('cpu')
    meta = dict(name=txt(root, 'name'), version=txt(root, 'version'), cpu={c.tag: (c.text or '').strip() for c in cpu} if cpu is not None else {})
    m = re.search(r'<!--(.*?)-->', data[:3000].decode('utf-8', 'replace'), re.S)
    meta['notice'] = ' '.join(m[1].split()) if m else ''
    return blocks, irqs, meta


# --- Input and version check ---

def bad_input(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def read_svd(path):
    """SVD bytes, ST's package name and a source label, from ST's zip or a bare .svd."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            hits = [i for i in z.infolist() if i.filename.rsplit('/', 1)[-1] == SVD_MEMBER]
            if len(hits) != 1 or hits[0].file_size > 200 << 20:
                bad_input(f'{path}: expected one {SVD_MEMBER} under 200 MB, found {len(hits)}')
            data, package, source = z.read(hits[0]), hits[0].filename.rpartition('/')[0], f'{path.name}: {hits[0].filename}'
    else:
        package = path.resolve().parent.name
        data, package, source = path.read_bytes(), package if re.fullmatch(r'\w+_svd_v\d+r\d+', package) else '', path.name
    if not re.search(rb'<name>\s*' + SVD_MEMBER[:-4].encode() + rb'\s*</name>', data[:4000]):
        bad_input(f'{path}: not the {SVD_MEMBER[:-4]} SVD')
    return data, package, source


def svd_id(data):
    """(git blob of the file with LF line endings, SVD version)."""
    lf = data.replace(b'\r\n', b'\n')
    m = re.search(rb'<version>\s*([^<]*?)\s*</version>', data[:4000])
    return hashlib.sha1(b'blob %d\0' % len(lf) + lf).hexdigest(), m[1].decode() if m else 'unknown'


def github(path):
    req = urllib.request.Request(f'https://api.github.com/repos/{DFP_REPO}/{path}',
                                 headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'zprof-svd-workbook'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def check_version(blob, version, package, online):
    """(status, findings): 0 current, 1 a different SVD exists, 2 could not tell."""
    base = f"{BASELINE['package']} (SVD version {BASELINE['version']}, blob {BASELINE['blob'][:12]})"
    if blob == BASELINE['blob']:
        status, out = 0, [f'the SVD is the baseline, {base}']
    else:
        status, out = 1, [f"the SVD is {package or 'from an unknown package'} (SVD version {version}, blob {blob[:12]}), not the baseline {base}: "
                          're-review the curated tables, then update BASELINE and host/svd/README.md']
    if not online:
        return status, out + ["Arm's DFP not checked (--offline)"]
    try:
        dfp = next((e['sha'] for e in github(f'contents/{DFP_DIR}') if e['name'] == SVD_MEMBER), None)
        if dfp is None:
            raise ValueError(f'no {DFP_DIR}/{SVD_MEMBER} there')
        when = github(f'commits?path={DFP_DIR}/{SVD_MEMBER}&per_page=1')[0]['commit']['committer']['date'][:10]
    except (OSError, ValueError, KeyError, IndexError) as e:
        return status or 2, out + [f"could not read Arm's DFP ({DFP_REPO}): {e}"]
    if dfp == blob:
        out.append(f"Arm's {DFP_REPO} has the same {SVD_MEMBER} (last changed there {when})")
    elif dfp == BASELINE['blob']:
        out.append(f"Arm's {DFP_REPO} still has the baseline (last changed there {when}): the input is newer than the DFP, or modified")
    else:
        status = 1
        out.append(f"Arm's {DFP_REPO} has a different {SVD_MEMBER} since {when} (blob {dfp[:12]}): ST has probably released an update, "
                   f'download {ST_SVD_URL}')
    return status, out


def known_defects(blocks):
    out = []
    for blk, reg, field, wrong, text in KNOWN_DEFECTS:
        r = next((r for r in blocks[blk]['regs'] if r['name'] == reg), None) if blk in blocks else None
        f = next((f for f in r['fields'] if f['name'] == field), None) if r else None
        if f and wrong in f['desc']:
            out.append(text)
    return out


# --- Zephyr devicetree at the pin ---

NODE_RE = re.compile(r'^\s*(?:([\w-]+)\s*:\s*)?([\w,.+-]+)@([0-9a-fA-F]+)\s*\{')
REF_RE = re.compile(r'^\s*&([\w-]+)\s*\{')


def parse_dts(paths):
    nodes, board_status = [], {}
    for p in paths:
        depth, stack = 0, []
        for raw in p.read_text(encoding='utf-8', errors='replace').splitlines():
            line = re.sub(r'/\*.*?\*/', '', re.sub(r'//.*', '', raw))
            m, r = NODE_RE.match(line), REF_RE.match(line)
            if m:
                node = dict(label=m[1] or '', name=m[2], addr=int(m[3], 16), compatible='', status=None, irqs=[])
                nodes.append(node)
                stack.append((node, depth))
            elif r:
                stack.append(({'ref': r[1]}, depth))
            elif stack and depth == stack[-1][1] + 1:
                cur = stack[-1][0]
                if (mm := re.match(r'\s*compatible\s*=\s*(.+);', line)) and 'ref' not in cur:
                    cur['compatible'] = ', '.join(re.findall(r'"([^"]+)"', mm[1]))
                elif mm := re.match(r'\s*status\s*=\s*"(\w+)"', line):
                    if 'ref' in cur:
                        board_status[cur['ref']] = mm[1]
                    else:
                        cur['status'] = mm[1]
                elif (mm := re.match(r'\s*interrupts\s*=\s*(.+);', line)) and 'ref' not in cur:
                    for cells in re.findall(r'<([^>]*)>', mm[1]):
                        vals = cells.split()
                        cur['irqs'].extend(int(v, 0) for v in vals[0::2] if re.fullmatch(r'0x[0-9a-fA-F]+|\d+', v))
            depth += line.count('{') - line.count('}')
            while stack and depth <= stack[-1][1]:
                stack.pop()
    return nodes, board_status


def zephyr_info(zephyr):
    n6 = zephyr / 'dts' / 'arm' / 'st' / 'n6'
    board = zephyr / 'boards' / 'st' / 'stm32n6570_dk'
    soc_nodes, _ = parse_dts(sorted(n6.glob('*.dtsi')))
    _, board_status = parse_dts([p for p in sorted(board.iterdir()) if p.suffix in ('.dts', '.dtsi') and 'fsbl' not in p.name and '_sb' not in p.name])
    try:
        sha = subprocess.run(['git', '-C', str(zephyr), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        sha = 'unknown'
    return soc_nodes, board_status, sha


def pinned_sha():
    m = re.search(r'name:\s*zephyr\b.*?revision:\s*([0-9a-f]{7,40})', (REPO / 'firmware' / 'west.yml').read_text(), re.S)
    return m[1] if m else ''


# --- Derived columns ---

def type_info(blk, blocks):
    t = blk['type']
    if t in TYPE_INFO:
        return TYPE_INFO[t]
    if m := re.fullmatch(r'GPIO([A-Z])', t):
        return ('io', f'GPIO port {m[1]}: mode, output type, speed, pull-up / pull-down, alternate function, atomic bit set / reset and lock.', '', '')
    if t.startswith('LPTIM'):
        return ('tim', 'Low-power timer that keeps counting in Stop mode on LSE or LSI.', '',
                'Zephyr can use an LPTIM as the system timer; the N6 uses SysTick at the pin.')
    if t.startswith('TIM'):
        regs = blocks[t]['regs']
        # ARR is wider than the counter when dithering is on, so size from CNT;
        # a 31-bit CNT shares bit 31 with UIFCPY and counts 32 bits.
        cnt = next((f['width'] for r in regs if r['name'].endswith('_CNT') for f in r['fields'] if f['name'] == 'CNT'), None)
        ch = sum(1 for r in regs if re.search(r'_CCR\d+$', r['name']))
        kind = blk['svd_desc'].split(' timer')[0].replace('General purpose', 'General-purpose')
        width = f'{32 if cnt == 31 else cnt}-bit counter' if cnt else 'counter'
        chans = f'{ch} capture / compare channels' if ch else 'time base only'
        return ('tim', f'{kind} timer: {width}, {chans}.', '', '')
    return ('sys', '', '', '')


def rcc_bits(rcc):
    en, rst = {}, {}
    for r in rcc['regs']:
        if r['offset'] >= 0x800:
            continue
        for pat, dst in ((r'RCC_(\w+?)ENR', en), (r'RCC_(\w+?)RSTR', rst)):
            m = re.fullmatch(pat, r['name'])
            if m and not r['name'].endswith('LPENR'):
                for f in r['fields']:
                    dst[f['name']] = (r['name'], f['name'], f['lsb'], m[1])
    return en, rst


def bus_name(raw):
    if raw in ('MISC', 'MEM', 'BUS', 'DIV'):
        return raw.lower()
    return re.sub(r'(APB\d)[LH]$', r'\1', raw)


def freeze_bits(dbg):
    out = defaultdict(list)
    for r in dbg['regs']:
        if not re.search(r'FZ\d$', r['name']):
            continue
        for f in r['fields']:
            if m := re.fullmatch(r'DBG_(\w+?)_STOP', f['name']):
                out[re.sub(r'_CH\d+$', '', m[1])].append(f"{r['name']}.{f['name']}")
    return {k: sorted(v, key=natural) for k, v in out.items()}


def summarize(items):
    if len(items) <= 3:
        return ', '.join(items)
    return f'{items[0]} to {items[-1].split(".")[-1]} ({len(items)} bits)'


def read_effect(blk, reg):
    t, name = blk['type'], reg['name']
    acts = sorted(({reg['read_action']} | {f['read_action'] for f in reg['fields']}) - {''})
    if acts:
        return f"SVD readAction: {', '.join(acts)}", 'avoid'
    if (eff := READ_EFFECTS.get(t, {}).get(name)):
        return f'Reading {eff} (inferred)', 'avoid'
    if t in READ_EFFECTS_RE and re.search(READ_EFFECTS_RE[t][0], name):
        return f'Reading {READ_EFFECTS_RE[t][1]} (inferred)', 'avoid'
    if (eff := READ_CARE.get(t, {}).get(name)):
        return f'Reading {eff} (inferred)', 'care'
    return '', ''


def write_semantics(blk, reg, by_offset):
    name, t = reg['name'], blk['type']
    if t == 'RCC' and 0x800 <= reg['offset'] < 0x1800:
        base = by_offset.get(reg['offset'] - (0x800 if reg['offset'] < 0x1000 else 0x1000))
        if base:
            return f"{'set' if reg['offset'] < 0x1000 else 'clear'} alias of {base}: writing 1 {'sets' if reg['offset'] < 0x1000 else 'clears'} those bits"
    if re.search(r'(_KR|KEYR)$', name):
        return 'key register: write the documented key sequence'
    if t != 'ETH' and re.search(r'(ICR\d*|IFCR|FCR|SCR|CICR|CLRFR)$', name):
        return 'write 1 clears the matching flag (inferred from the name)'
    return ''


def svd_defects(blocks):
    """Numbered registers whose indexed field names repeat a sibling's while the
    rest of the series shifts its indices: a copy-paste sign in the SVD."""
    found = []
    for b in blocks.values():
        if b['type'] != b['name']:
            continue
        series = defaultdict(list)
        for r in b['regs']:
            key = tuple(f['name'] for f in r['fields'] if re.search(r'\d', f['name']))
            if len(key) > 1 and re.search(r'\d+$', r['name']):
                series[re.sub(r'\d+$', '', r['name'])].append((r['name'], key))
        for regs in series.values():
            if len(regs) < 3 or len({k for _, k in regs}) < len(regs) - 1:
                continue
            first = {}
            for name, key in regs:
                if key in first:
                    found.append(f'{name} repeats the field names of {first[key]}')
                first.setdefault(key, name)
    return found


# --- Workbook ---

HEAD_FONT = Font(bold=True, color='FFFFFF')
HEAD_FILL = PatternFill('solid', fgColor='1F3A5F')
WRAP = Alignment(wrap_text=True, vertical='top')


def add_sheet(wb, title, columns, widths, rows, wrap=False, freeze='B2'):
    ws = wb.create_sheet(title)
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = freeze
    head = []
    for c in columns:
        cell = WriteOnlyCell(ws, value=c)
        cell.font, cell.fill = HEAD_FONT, HEAD_FILL
        head.append(cell)
    ws.append(head)
    n = 0
    for row in rows:
        if wrap:
            cells = []
            for v in row:
                cell = WriteOnlyCell(ws, value=v)
                cell.alignment = WRAP
                cells.append(cell)
            ws.append(cells)
        else:
            ws.append(row)
        n += 1
    ws.auto_filter.ref = f'A1:{get_column_letter(len(columns))}{n + 1}'
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('svd', type=Path, nargs='?', help="ST's stm32n6-svd.zip, or STM32N657.svd from it")
    ap.add_argument('zephyr', type=Path, nargs='?')
    ap.add_argument('out', type=Path, nargs='?')
    ap.add_argument('--check', action='store_true', help='only compare the SVD (or the baseline) with Arm\'s DFP')
    ap.add_argument('--offline', action='store_true', help="do not ask GitHub for Arm's DFP")
    a = ap.parse_args()

    if a.check:
        if a.svd:
            data, package, _ = read_svd(a.svd)
            blob, version = svd_id(data)
        else:
            blob, version, package = BASELINE['blob'], BASELINE['version'], BASELINE['package']
        status, out = check_version(blob, version, package, not a.offline)
        print('\n'.join(out))
        sys.exit(status)
    if not (a.svd and a.zephyr and a.out):
        ap.error('svd, zephyr and out are required unless --check')

    data, package, source = read_svd(a.svd)
    blob, version = svd_id(data)
    _, vcheck = check_version(blob, version, package, not a.offline)
    for line in vcheck:
        print('version check:', line, file=sys.stderr)
    blocks, irqs, meta = load_svd(data)
    soc_nodes, board_status, zsha = zephyr_info(a.zephyr)
    pin = pinned_sha()
    if pin and not zsha.startswith(pin[:12]):
        print(f'warning: Zephyr tree is at {zsha[:12]}, the pin is {pin[:12]}', file=sys.stderr)

    by_addr = defaultdict(list)
    for n in soc_nodes:
        if n['name'] not in ('soc', 'peripherals') and 'simple-bus' not in n['compatible']:
            by_addr[n['addr']].append(n)
    irq_nodes = defaultdict(list)
    for n in soc_nodes:
        for q in n['irqs']:
            irq_nodes[q].append(n['label'] or n['name'])

    # Signals: validate against the SVD and index them by register and field.
    sig_reg, sig_field, sig_irq, sig_rows, errors = defaultdict(set), defaultdict(set), defaultdict(set), [], []
    for s in SIGNALS:
        for q in s['irq']:
            sig_irq[q].add(s['id'])
        if not s['block']:
            sig_rows.append((s, None, None))
            continue
        blk = blocks.get(s['block'])
        reg = next((r for r in blk['regs'] if r['name'] == s['reg']), None) if blk else None
        if reg is None:
            errors.append(f"{s['id']}: no register {s['block']}.{s['reg']}")
            continue
        names = {f['name'] for f in reg['fields']}
        missing = [f for f in s['fields'] if f not in names]
        if missing:
            errors.append(f"{s['id']}: {s['reg']} has no field {', '.join(missing)}")
            continue
        targets = [b for b in blocks.values() if b['type'] == blk['type']] if s['all_instances'] else [blk]
        for b in targets:
            sig_reg[(b['name'], reg['name'])].add(s['id'])
            for f in s['fields']:
                sig_field[(b['name'], reg['name'], f)].add(s['id'])
        sig_rows.append((s, blk, reg))
    if errors:
        sys.exit('signal check failed:\n  ' + '\n  '.join(errors))

    rcc_en, rcc_rst = rcc_bits(blocks['RCC'])
    freeze = freeze_bits(blocks['DBGMCU'])
    order = sorted(blocks.values(), key=lambda b: natural(b['name']))
    nreg = sum(len(b['regs']) for b in order)
    nfld = sum(len(r['fields']) for b in order for r in b['regs'])
    unused_effects = {n for t in READ_EFFECTS.values() for n in t} - {r['name'] for b in order for r in b['regs']}
    defects = svd_defects(blocks) + known_defects(blocks)

    def lookup(table, name, suffix):
        for cand in (name, RCC_ALIAS.get(name)):
            if cand and cand + suffix in table:
                return table[cand + suffix]
        return None

    def periph_rows():
        for b in order:
            cat, desc, rel, note = type_info(b, blocks)
            en, rs = lookup(rcc_en, b['name'], 'EN'), lookup(rcc_rst, b['name'], 'RST')
            fz = freeze.get(b['name']) or freeze.get(RCC_ALIAS.get(b['name'], '')) or freeze.get(b['name'] + '1') or []
            nodes = by_addr.get(b['base_s'], []) + by_addr.get(b['base_ns'], [])
            labels = [n['label'] or n['name'] for n in nodes]
            status = []
            for n in nodes:
                st = board_status.get(n['label']) or n['status'] or 'okay (default)'
                status.append(f"{n['label'] or n['name']}: {st}")
            yield [b['name'], b['type'], b['group'], CATEGORY.get(cat, cat), desc, b['svd_desc'], hx(b['base_ns']), hx(b['base_s']),
                   hx(b['size'], 4) if b['size'] else '', bus_name(en[3]) if en else '', f'{en[0]}.{en[1]} [{en[2]}]' if en else '',
                   f'{rs[0]}.{rs[1]} [{rs[2]}]' if rs else '', summarize(fz), ', '.join(f'{n} {nm}' for n, nm in sorted(b['irqs'])),
                   len(b['regs']), sum(len(r['fields']) for r in b['regs']), ', '.join(labels),
                   '; '.join(dict.fromkeys(n['compatible'] for n in nodes if n['compatible'])), '; '.join(status), rel, note]

    def reg_rows():
        for b in order:
            by_offset = {r['offset']: r['name'] for r in b['regs']}
            for r in b['regs']:
                effect, probe = read_effect(b, r)
                yield [b['name'], r['name'], hx(r['offset'], 3), hx(b['base_ns'] + r['offset']),
                       hx(b['base_s'] + r['offset']) if b['base_s'] is not None else '', r['size'], r['access'], hx(r['reset']),
                       hx(r['reset_mask']), r['desc'], len(r['fields']), ', '.join(f"{f['name']}{bits(f['lsb'], f['width'])}" for f in r['fields']),
                       effect, probe, write_semantics(b, r, by_offset), ', '.join(sorted(sig_reg.get((b['name'], r['name']), ())))]

    def field_rows():
        for b in order:
            by_offset = {r['offset']: r['name'] for r in b['regs']}
            for r in b['regs']:
                reg_write = write_semantics(b, r, by_offset)
                for f in r['fields']:
                    mask = ((1 << f['width']) - 1) << f['lsb']
                    reset = '' if r['reset'] is None else f"0x{(r['reset'] >> f['lsb']) & ((1 << f['width']) - 1):X}"
                    # ST names most values B_0x..; the value and its description carry the meaning.
                    enums = '; '.join(f'{v}: {d or n}' if re.fullmatch(r'B_0x[0-9A-Fa-f]+', n) else f'{v}={n}' + (f' ({d})' if d and d != n else '')
                                      for n, v, d in f['enums'][:16])
                    write = f"{MOD_WRITE.get(f['mod_write'], f['mod_write'])} (SVD)" if f['mod_write'] else reg_write
                    yield [b['name'], r['name'], f['name'], bits(f['lsb'], f['width']), f['lsb'], f['width'], hx(mask), f['access'], reset,
                           f['desc'], enums, f['read_action'], f['mod_write'], write,
                           ', '.join(sorted(sig_field.get((b['name'], r['name'], f['name']), ())))]

    def irq_rows():
        for n in sorted(irqs):
            lst = irqs[n]
            owner = lst[0]['owner'][:-2] if lst[0]['owner'].endswith('_S') else lst[0]['owner']
            cat = IRQ_CATEGORY.get(n) or (type_info(blocks[owner], blocks)[0] if owner in blocks else '')
            yield [n, n + 16, ' / '.join(dict.fromkeys(i['name'] for i in lst)), ', '.join(dict.fromkeys(i['owner'] for i in lst)),
                   lst[0]['desc'], CATEGORY.get(cat, cat), ', '.join(dict.fromkeys(irq_nodes.get(n, []))), ', '.join(sorted(sig_irq.get(n, ())))]

    def signal_rows():
        for s, blk, reg in sig_rows:
            if reg is None:
                yield [s['domain'], s['id'], s['meaning'], '', '', '', '', '', '', '', ', '.join(map(str, s['irq'])), s['read_by'], s['when'],
                       s['zephyr'], s['source'], s['notes']]
                continue
            fl = [f for f in reg['fields'] if not s['fields'] or f['name'] in s['fields']]
            yield [s['domain'], s['id'], s['meaning'], blk['name'] + (' (all instances)' if s['all_instances'] else ''), reg['name'],
                   ', '.join(s['fields']) or '(whole register)', ', '.join(f"{f['name']}{bits(f['lsb'], f['width'])}" for f in fl),
                   hx(blk['base_ns'] + reg['offset']), hx(blk['base_s'] + reg['offset']) if blk['base_s'] is not None else '',
                   reg['access'], ', '.join(map(str, s['irq'])), s['read_by'], s['when'], s['zephyr'], s['source'], s['notes']]

    wb = Workbook(write_only=True)
    sha = hashlib.sha256(data).hexdigest()
    about = wb.create_sheet('About')
    about.column_dimensions['A'].width = 24
    about.column_dimensions['B'].width = 120
    cpu = meta['cpu']
    rows = [
        ('STM32N657 register workbook, zprof edition', ''),
        ('What', "ST's STM32N657 SVD re-organized and annotated for zprof: each block with both bus aliases, clock, reset, debug freeze and its Zephyr "
                 'node; every register and field with absolute addresses; the interrupt table with exception numbers; the signals zprof reads, '
                 'checked against the SVD; and the Arm core and trace registers the SVD leaves out.'),
        ('Source', f"{source}, {meta['name']} SVD version {meta['version']} (ST package {package or 'unknown'}, {ST_SVD_URL}); "
                   f'sha256 {sha}, git blob {blob}'),
        ('Version check', f'{dt.date.today().isoformat()}: ' + '; '.join(vcheck)),
        ('License', f"{meta['notice']} Text in the SVD description columns is ST's. Columns named zprof, Description (zprof), Category, "
                    'the signals and the Not in SVD tab are ours.'),
        ('CPU block', f"{cpu.get('name', '')} revision {cpu.get('revision', '')}, FPU {cpu.get('fpuPresent', '')}, MPU {cpu.get('mpuPresent', '')} "
                      f"(wrong: the M55 has an MPU), NVIC priority bits {cpu.get('nvicPrioBits', '')}"),
        ('Zephyr', f'Devicetree nodes and DK status from Zephyr {zsha[:12]} (pin {pin[:12] or "unknown"}): dts/arm/st/n6 and boards/st/stm32n6570_dk'),
        ('Generated', f'{dt.date.today().isoformat()} by host/svd/svd_workbook.py in murr2k/zprof'),
        ('Counts', f'{len(order)} blocks (each with a secure alias), {nreg} registers, {nfld} fields, {len(irqs)} interrupts '
                   f'(highest IRQn {max(irqs)}), {len(SIGNALS)} zprof signals'),
        ('Review', 'docs/OBSERVABILITY_AND_SVD_REVIEW.md in murr2k/zprof'),
        ('', ''),
        ('Tabs', ''),
        ('Peripherals', 'One row per block. Bus and clock enable come from the RCC_*ENR bit named after the block; reset from RCC_*RSTR; '
                        'debug freeze from the DBGMCU_*FZ1 bits; Zephyr node by unit address in the pinned SoC devicetree.'),
        ('Registers', 'Every register of every block, with non-secure and secure addresses. Probe read: avoid = reading changes state, '
                      'care = reading has a side effect to plan for, blank = none known.'),
        ('Fields', 'Every field, most significant first, with mask, field reset value, enumerated values and write semantics.'),
        ('Interrupts', 'IRQn, the exception number IPSR reports (IRQn + 16), owner in the SVD, Zephyr nodes that use it, zprof signals.'),
        ('zprof signals', 'Registers and interrupts zprof reads, grouped by domain. Every register and field here exists in this SVD; '
                          'the generator fails if one does not.'),
        ('Not in SVD', 'Arm core, debug and trace registers the SVD omits: SCB fault registers, NVIC, SysTick, DWT, ITM, MPU, PMU, the trace ROM table '
                       'and the STM stimulus window.'),
        ('', ''),
        ('Conventions', ''),
        ('Addresses', 'Hex strings. Non-secure aliases are 0x4xxxxxxx, secure 0x5xxxxxxx; Zephyr runs at the secure alias on the DK.'),
        ('Inferred columns', 'Read side effects, probe read and write semantics marked inferred come from register names, not from the SVD. '
                             'The SVD annotates read side effects only for Ethernet.'),
        ('Probe reads', 'A block whose clock is off reads as zero or faults: check its clock enable first. RIF may block debug reads of some blocks '
                        '[unverified].'),
        ('', ''),
        ('SVD caveats', 'No Arm core or CoreSight blocks; mpuPresent is false although the M55 has an MPU; RIFSC and RISAF registers have no fields; '
                        'RCC_RSR has no readAction although RMVF clears it.'),
    ]
    for d in defects:
        rows.append(('SVD defect', d))
    for k, v in rows:
        kc = WriteOnlyCell(about, value=k)
        kc.font = Font(bold=True, size=14 if k.startswith('STM32N657') else 11)
        kc.alignment = WRAP
        vc = WriteOnlyCell(about, value=v)
        vc.alignment = WRAP
        about.append([kc, vc])

    n_p = add_sheet(wb, 'Peripherals',
                    ['Peripheral', 'Type', 'Group', 'Category', 'Description (zprof)', 'SVD description', 'Non-secure base', 'Secure base', 'Size',
                     'Bus', 'Clock enable', 'Reset', 'Debug freeze on halt', 'IRQs', 'Registers', 'Fields', 'Zephyr node (pin)', 'Zephyr compatible',
                     'DK status (pin)', 'zprof relevance', 'zprof notes'],
                    [12, 10, 10, 20, 60, 34, 13, 13, 8, 8, 30, 30, 34, 30, 9, 8, 18, 34, 24, 10, 44], periph_rows(), wrap=True)
    n_r = add_sheet(wb, 'Registers',
                    ['Peripheral', 'Register', 'Offset', 'Non-secure address', 'Secure address', 'Size', 'Access', 'Reset value', 'Reset mask',
                     'Description', 'Fields', 'Field list', 'Read side effects', 'Probe read (inferred)', 'Write semantics', 'zprof signals'],
                    [12, 26, 8, 13, 13, 6, 12, 12, 12, 50, 7, 60, 30, 10, 36, 22], reg_rows(), freeze='C2')
    n_f = add_sheet(wb, 'Fields',
                    ['Peripheral', 'Register', 'Field', 'Bits', 'LSB', 'Width', 'Mask', 'Access', 'Reset', 'Description', 'Enumerated values',
                     'SVD readAction', 'SVD modifiedWriteValues', 'Write semantics', 'zprof signals'],
                    [12, 26, 22, 9, 5, 6, 12, 12, 8, 70, 30, 10, 12, 36, 22], field_rows(), freeze='D2')
    n_i = add_sheet(wb, 'Interrupts',
                    ['IRQn', 'Exception number', 'Name', 'Owner in SVD', 'Description', 'Category', 'Zephyr nodes (pin)', 'zprof signals'],
                    [7, 10, 22, 14, 50, 24, 28, 28], irq_rows(), freeze='C2')
    n_s = add_sheet(wb, 'zprof signals',
                    ['Domain', 'Signal', 'What it tells you', 'Peripheral', 'Register', 'Fields', 'Bits', 'Non-secure address', 'Secure address',
                     'Access', 'IRQ', 'Read by', 'When', 'Zephyr at the pin', 'Source', 'Notes'],
                    [16, 22, 46, 14, 24, 30, 36, 13, 13, 11, 8, 16, 20, 30, 14, 50], signal_rows(), wrap=True, freeze='C2')
    n_x = add_sheet(wb, 'Not in SVD', ['Block', 'Register', 'Address', 'Description', 'zprof use', 'Source'],
                    [10, 24, 13, 60, 50, 40], ([b, r, hx(addr), d, u, src] for b, r, addr, d, u, src in NOT_IN_SVD), wrap=True, freeze='C2')
    a.out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(a.out)

    print(f'{a.out}: {n_p} peripherals, {n_r} registers, {n_f} fields, {n_i} interrupts, {n_s} signals, {n_x} core registers')
    print(f'blocks without a clock-enable match: {[b["name"] for b in order if not lookup(rcc_en, b["name"], "EN")]}')
    print(f'blocks without a Zephyr node: {len([b for b in order if not (by_addr.get(b["base_s"]) or by_addr.get(b["base_ns"]))])}')
    if unused_effects:
        print(f'read-effect names not in the SVD: {sorted(unused_effects)}')
    for d in defects:
        print('svd defect:', d)


if __name__ == '__main__':
    main()
