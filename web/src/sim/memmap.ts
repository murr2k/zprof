import { THREADS } from './target'

/**
 * RAM floor plan of the STM32N6570-DK build. Region names, bases, sizes and
 * attributes come from the pinned Zephyr devicetree (dts/arm/st/n6/stm32n6.dtsi,
 * stm32n657X0.dtsi, boards/st/stm32n6570_dk: zephyr,sram = axisram1, the 2 MiB
 * FLEXRAM + AXISRAM1 + AXISRAM2 range given to the chainloaded application).
 * The section layout inside it is synthetic: what our app's zephyr.map would
 * look like. The real one comes from the linker map and rom/ram reports.
 */
export type BlockKind = 'data' | 'bss' | 'stack' | 'heap' | 'pool' | 'log' | 'rtt' | 'tunables' | 'retained' | 'free' | 'reserved'
export interface MemBlock {
  name: string
  kind: BlockKind
  start: number
  size: number
  note?: string
  /** Live usage source: 'heap', 'slab', 'log', 'rtt', or 'stack:<thread index>' / 'stack:isr'. */
  live?: string
}
export interface MemRegion {
  name: string
  dt: string
  base: number
  size: number
  attr: string
  enabled: boolean
  note: string
  blocks: MemBlock[]
}

const KiB = 1024
const align = (a: number, n: number) => Math.ceil(a / n) * n

function layoutSram(): MemBlock[] {
  const out: MemBlock[] = []
  let a = 0x34000000
  const put = (name: string, kind: BlockKind, size: number, extra: Partial<MemBlock> = {}, al = 8) => {
    a = align(a, al)
    out.push({ name, kind, start: a, size, ...extra })
    a += size
  }
  put('datas', 'data', 0x2580, { note: 'initialized data (copied at boot)' })
  put('bss', 'bss', 0x9a00, { note: 'kernel objects, net stack state, driver data' })
  put('z_interrupt_stacks', 'stack', 2048, { live: 'stack:isr', note: 'ISR stack; PSPLIM/MSPLIM guard (ARMv8-M stack limit)' }, 8)
  THREADS.forEach((t, i) => put(`${t.name} stack`, 'stack', t.stack, { live: `stack:${i}`, note: 'K_THREAD_STACK, noinit' }, 8))
  put('_system_heap', 'heap', 24 * KiB, { live: 'heap', note: 'k_malloc heap (CONFIG_HEAP_MEM_POOL_SIZE)' }, 8)
  put('net_buf rx pool', 'pool', 48 * 1536, { live: 'slab', note: '48 x 1536 B net_buf data' }, 32)
  put('log buffer', 'log', 4 * KiB, { live: 'log', note: 'CONFIG_LOG_BUFFER_SIZE' }, 8)
  // zprof non-cacheable window: RTT must bypass the M55 D-cache (PLANS.md section 2.7).
  put('zprof_nocache: RTT CB', 'rtt', 168, { note: 'SEGGER RTT control block, MPU ATTR_MPU_RAM_NOCACHE' }, 32 * KiB)
  put('RTT up 1 (trace)', 'rtt', 16 * KiB, { live: 'rtt', note: 'zprof frames to the host' })
  put('RTT up 0 / down 0', 'rtt', 2 * KiB, { note: 'console and shell' })
  put('RTT down 1 (commands)', 'rtt', 1 * KiB, { note: 'host to agent: parameter writes' })
  put('zprof tunables block', 'tunables', 256, { note: 'registered parameters, seqlock per entry' })
  put('zprof watch block', 'tunables', 512, { note: 'watch samples staged for the next frame' })
  return out
}

export const REGIONS: MemRegion[] = [
  {
    name: 'axisram1 (zephyr,sram)', dt: 'memory@34000000', base: 0x34000000, size: 2048 * KiB, attr: 'RAM, cacheable', enabled: true,
    note: '400 KiB FLEXRAM + 624 KiB AXISRAM1 + 1 MiB AXISRAM2, the chainloaded application RAM', blocks: layoutSram(),
  },
  { name: 'backup SRAM', dt: 'memory@3c000000', base: 0x3c000000, size: 8 * KiB, attr: 'RAM, ATTR_MPU_RAM_NOCACHE', enabled: true,
    note: 'Disabled in the SoC dtsi; our board overlay enables it for retained state',
    blocks: [
      { name: 'zprof fault record', kind: 'retained', start: 0x3c000000, size: 1024, note: 'retained across reset: last fault, last heartbeat seq' },
      { name: 'boot counters', kind: 'retained', start: 0x3c000400, size: 64, note: 'boot count, reset causes' },
    ] },
  { name: 'AXISRAM3', dt: 'memory@34200000', base: 0x34200000, size: 448 * KiB, attr: 'RAM', enabled: false, note: 'status = "disabled" in stm32n657X0.dtsi (ramcfg_sram3_axi)', blocks: [] },
  { name: 'AXISRAM4', dt: 'memory@34270000', base: 0x34270000, size: 448 * KiB, attr: 'RAM', enabled: false, note: 'status = "disabled"', blocks: [] },
  { name: 'AXISRAM5', dt: 'memory@342e0000', base: 0x342e0000, size: 448 * KiB, attr: 'RAM', enabled: false, note: 'status = "disabled"', blocks: [] },
  { name: 'AXISRAM6', dt: 'memory@34350000', base: 0x34350000, size: 448 * KiB, attr: 'RAM', enabled: false, note: 'status = "disabled"', blocks: [] },
]

export const HEAP_BASE = REGIONS[0].blocks.find((b) => b.kind === 'heap')!.start
export const hex = (a: number) => `0x${a.toString(16).padStart(8, '0')}`
