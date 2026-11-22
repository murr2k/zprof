// SPDX-License-Identifier: Apache-2.0
/**
 * Synthetic statistical function profile (Phase D) of the same synthetic target:
 * samples per call path, idle excluded. Shape: [name, module, self samples, children].
 */
export type Node = [string, string, number, Node[]?]

export const MODULES = ['app', 'dsp', 'kernel', 'drivers', 'net', 'lib', 'zprof', 'logging'] as const
export type Module = (typeof MODULES)[number]

export const PROFILE: Node = ['all busy samples', 'kernel', 0, [
  ['z_thread_entry', 'kernel', 40, [
    ['ctrl_loop_entry', 'app', 120, [
      ['ctrl_step', 'app', 800, [
        ['read_sensors', 'app', 300, [
          ['sensor_sample_fetch', 'drivers', 200, [
            ['spi_transceive', 'drivers', 400, [['spi_xfer_fifo', 'drivers', 2600]]],
          ]],
          ['q15_to_float', 'dsp', 900],
        ]],
        ['pid_update', 'app', 1500, [
          ['fir_q15', 'dsp', 9800],
          ['iir_biquad_df2t', 'dsp', 3300],
        ]],
        ['clamp_output', 'app', 400],
        ['pwm_set_cycles', 'drivers', 700],
        ['zprof_span_end', 'zprof', 350],
      ]],
      ['k_sleep', 'kernel', 200, [['z_swap', 'kernel', 1400]]],
    ]],
    ['sensor_rx_entry', 'app', 600, [
      ['k_msgq_get', 'kernel', 900, [['z_swap', 'kernel', 1100]]],
      ['sensor_decode', 'app', 3800, [['crc16_ccitt', 'lib', 2900]]],
      ['k_msgq_put', 'kernel', 700],
    ]],
    ['net_rx_thread', 'net', 300, [
      ['net_recv_data', 'net', 500, [
        ['net_ipv4_input', 'net', 900, [
          ['net_udp_input', 'net', 700, [
            ['cmd_handler', 'app', 400, [['zcbor_decode', 'lib', 1500], ['cmd_validate', 'app', 650]]],
          ]],
        ]],
        ['net_pkt_unref', 'net', 600],
      ]],
    ]],
    ['storage_entry', 'app', 200, [
      ['nvs_write', 'lib', 600, [
        ['flash_write', 'drivers', 300, [['qspi_page_program', 'drivers', 3600]]],
        ['nvs_flash_crc', 'lib', 800],
      ]],
    ]],
    ['work_queue_main', 'kernel', 150, [
      ['blink_work_fn', 'app', 90],
      ['flash_gc_work', 'app', 220, [['flash_erase', 'drivers', 1300]]],
    ]],
    ['zprof_heartbeat', 'zprof', 150, [
      ['k_thread_runtime_stats_all_get', 'kernel', 120],
      ['k_thread_stack_space_get', 'kernel', 380],
      ['zcbor_encode', 'lib', 160],
      ['zprof_frame_cobs', 'zprof', 90, [['SEGGER_RTT_WriteSkipNoLock', 'zprof', 70]]],
    ]],
    ['log_process_thread_func', 'logging', 120, [
      ['cbprintf_package_convert', 'logging', 600],
      ['log_output_msg_process', 'logging', 900, [['uart_poll_out', 'drivers', 400]]],
    ]],
  ]],
  ['_isr_wrapper', 'kernel', 600, [
    ['sys_clock_isr', 'kernel', 900, [['sys_clock_announce', 'kernel', 1300, [['z_ready_thread', 'kernel', 500]]]]],
    ['spi_dma_isr', 'drivers', 2100, [['k_sem_give', 'kernel', 900, [['z_ready_thread', 'kernel', 600]]]]],
    ['eth_gem_isr', 'drivers', 800, [['net_pkt_rx_alloc', 'net', 450]]],
  ]],
  ['z_reschedule', 'kernel', 900, [['arch_switch', 'kernel', 2800]]],
]]

export interface Flat { name: string; module: Module; self: number; total: number; depth: number; x0: number; x1: number; path: string }

/** Lay the tree out as a flame graph: x in percent of busy samples, depth from the root. */
export function layout(root: Node = PROFILE) {
  const out: Flat[] = []
  const total = (n: Node): number => n[2] + (n[3] ?? []).reduce((a, c) => a + total(c), 0)
  const all = total(root)
  const walk = (n: Node, depth: number, x0: number, path: string) => {
    const tot = total(n)
    const p = path ? `${path};${n[0]}` : n[0]
    out.push({ name: n[0], module: n[1] as Module, self: n[2], total: tot, depth, x0: (x0 / all) * 100, x1: ((x0 + tot) / all) * 100, path: p })
    let x = x0
    for (const c of n[3] ?? []) { walk(c, depth + 1, x, p); x += total(c) }
  }
  walk(root, 0, 0, '')
  return { nodes: out, all, depth: Math.max(...out.map((f) => f.depth)) + 1 }
}

/** Self samples aggregated by function name (a function appears under several paths). */
export function hotFunctions(nodes: Flat[], all: number) {
  const m = new Map<string, { name: string; module: Module; self: number; total: number }>()
  for (const f of nodes) {
    if (f.depth === 0) continue
    const e = m.get(f.name) ?? { name: f.name, module: f.module, self: 0, total: 0 }
    e.self += f.self
    e.total += f.total
    m.set(f.name, e)
  }
  return [...m.values()].map((e) => ({ ...e, selfPct: (e.self / all) * 100, totalPct: (e.total / all) * 100 })).sort((a, b) => b.self - a.self)
}
