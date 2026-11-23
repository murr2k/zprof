/*
 * The protocol analyzer's records: Ethernet frames, I2C messages and disk
 * transfers, each only while the host asked for it (zprof_proto, CT_PROTO; every
 * session starts with none). Received frames come from Zephyr's net_recv_data
 * tracing hook; the rest from linker wraps of the drivers' functions (CMakeLists:
 * --wrap=eth_stm32_tx, i2c_stm32_transaction, disk_access_read, disk_access_write),
 * each behind a Kconfig that depends on its driver.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <string.h>

#include <zephyr/kernel.h>
#include <cmsis_core.h>

#include <zprof/proto.h>

#include "zprof_internal.h"

volatile uint32_t zprof_proto;   /* ZPROF_PROTO_* recorded now */

const uint32_t zprof_proto_avail =
	(IS_ENABLED(CONFIG_ZPROF_BUS_ETH_RX) || IS_ENABLED(CONFIG_ZPROF_BUS_ETH_STM32_TX) ? ZPROF_PROTO_ETH : 0) |
	(IS_ENABLED(CONFIG_ZPROF_BUS_I2C_STM32) ? ZPROF_PROTO_I2C : 0) |
	(IS_ENABLED(CONFIG_ZPROF_BUS_DISK) ? ZPROF_PROTO_DISK : 0);

static ALWAYS_INLINE uint32_t now(void)
{
#ifdef CONFIG_ZPROF_TS_DWT
	return DWT->CYCCNT;
#else
	return k_cycle_get_32();
#endif
}

static ALWAYS_INLINE bool want(uint32_t bus)
{
	return zprof_ring.on && (zprof_proto & bus) != 0u;
}

/* ---- Ethernet ----------------------------------------------------------- */

#if defined(CONFIG_ZPROF_BUS_ETH_RX) || defined(CONFIG_ZPROF_BUS_ETH_STM32_TX)
#include <zephyr/net/net_pkt.h>

#define SNAP_WORDS (ZPROF_ETH_SNAP / 4)

/* zprof's own stream (TCP, either port): left out, or it would trace itself. */
static bool ours(const uint8_t *b, size_t n)
{
#ifdef CONFIG_ZPROF_TRANSPORT_TCP
	if (n < 34u || b[12] != 0x08 || b[13] != 0x00 || b[23] != 6u) {
		return false;   /* not IPv4 TCP */
	}
	size_t l4 = 14u + (size_t)(b[14] & 0x0Fu) * 4u;

	if (l4 + 4u > n) {
		return false;
	}
	uint16_t sport = (uint16_t)(b[l4] << 8 | b[l4 + 1u]);
	uint16_t dport = (uint16_t)(b[l4 + 2u] << 8 | b[l4 + 3u]);

	return sport == CONFIG_ZPROF_TCP_PORT || dport == CONFIG_ZPROF_TCP_PORT;
#else
	ARG_UNUSED(b);
	ARG_UNUSED(n);
	return false;
#endif
}

/* The frame's first bytes into w (zero-padded); false for zprof's own. */
static bool snap(struct net_pkt *pkt, uint32_t *w)
{
	memset(w, 0, ZPROF_ETH_SNAP);
	size_t n = net_buf_linearize(w, ZPROF_ETH_SNAP, pkt->frags, 0, ZPROF_ETH_SNAP);

	return !ours((const uint8_t *)w, n);
}
#endif

#ifdef CONFIG_ZPROF_BUS_ETH_RX
/* sys_port_trace_net_recv_data_enter: every frame the driver hands up, its
 * Ethernet header still in front (zephyr_custom_tracing.h). */
void zprof_net_rx(void *pkt)
{
	uint32_t w[SNAP_WORDS];

	if (!want(ZPROF_PROTO_ETH) || pkt == NULL || !snap(pkt, w)) {
		return;
	}
	zprof_put_n(ZPROF_EV_ETH_RX, (uint16_t)MIN(net_pkt_get_len(pkt), UINT16_MAX), SNAP_WORDS, w);
}
#endif

#ifdef CONFIG_ZPROF_BUS_ETH_STM32_TX
int __real_eth_stm32_tx(const struct device *dev, struct net_pkt *pkt);

/* The driver's transmit: it copies the frame to the DMA, starts it and waits for
 * the transmit-complete interrupt, so its end is the frame on the wire. */
int __wrap_eth_stm32_tx(const struct device *dev, struct net_pkt *pkt)
{
	if (!want(ZPROF_PROTO_ETH)) {
		return __real_eth_stm32_tx(dev, pkt);
	}
	uint32_t w[1 + SNAP_WORDS];
	bool keep = snap(pkt, &w[1]);
	uint16_t len = (uint16_t)MIN(net_pkt_get_len(pkt), UINT16_MAX);
	uint32_t t0 = now();
	int ret = __real_eth_stm32_tx(dev, pkt);

	if (keep) {
		w[0] = ((now() - t0) & 0x7FFFFFFFu) | (ret != 0 ? 0x80000000u : 0u);
		zprof_put_n(ZPROF_EV_ETH_TX, len, 1 + SNAP_WORDS, w);
	}
	return ret;
}
#endif

/* ---- I2C ---------------------------------------------------------------- */

#ifdef CONFIG_ZPROF_BUS_I2C_STM32
#include <zephyr/drivers/i2c.h>

int __real_i2c_stm32_transaction(const struct device *dev, struct i2c_msg msg,
				 uint8_t *next_msg_flags, uint16_t periph);

/* One message of a transfer (the driver loops over them under its bus mutex). */
int __wrap_i2c_stm32_transaction(const struct device *dev, struct i2c_msg msg,
				 uint8_t *next_msg_flags, uint16_t periph)
{
	if (!want(ZPROF_PROTO_I2C)) {
		return __real_i2c_stm32_transaction(dev, msg, next_msg_flags, periph);
	}
	uint32_t t0 = now();
	int ret = __real_i2c_stm32_transaction(dev, msg, next_msg_flags, periph);
	uint32_t w[6] = {(uint32_t)(uintptr_t)dev, (uint32_t)msg.flags << 16 | (msg.len & 0xFFFFu),
			 now() - t0, (uint32_t)ret, 0, 0};

#ifdef CONFIG_ZPROF_BUS_I2C_DATA
	if (msg.buf != NULL) {
		memcpy(&w[4], msg.buf, MIN(msg.len, 8u));   /* written, or as read */
	}
	zprof_put_n(ZPROF_EV_I2C, periph, 6, w);
#else
	zprof_put_n(ZPROF_EV_I2C, periph, 4, w);   /* timing only: the data stays on the bus */
#endif
	return ret;
}
#endif

/* ---- disk --------------------------------------------------------------- */

#ifdef CONFIG_ZPROF_BUS_DISK
#include <zephyr/storage/disk_access.h>

int __real_disk_access_read(const char *pdrv, uint8_t *data_buf, uint32_t start_sector,
			    uint32_t num_sector);
int __real_disk_access_write(const char *pdrv, const uint8_t *data_buf, uint32_t start_sector,
			     uint32_t num_sector);

static void disk_rec(uint16_t op, const char *pdrv, uint32_t start, uint32_t n, uint32_t t0, int ret)
{
	uint32_t w[5] = {(uint32_t)(uintptr_t)pdrv, start, n, now() - t0, (uint32_t)ret};

	zprof_put_n(ZPROF_EV_DISK, op, 5, w);
}

int __wrap_disk_access_read(const char *pdrv, uint8_t *data_buf, uint32_t start_sector,
			    uint32_t num_sector)
{
	if (!want(ZPROF_PROTO_DISK)) {
		return __real_disk_access_read(pdrv, data_buf, start_sector, num_sector);
	}
	uint32_t t0 = now();
	int ret = __real_disk_access_read(pdrv, data_buf, start_sector, num_sector);

	disk_rec(0, pdrv, start_sector, num_sector, t0, ret);
	return ret;
}

int __wrap_disk_access_write(const char *pdrv, const uint8_t *data_buf, uint32_t start_sector,
			     uint32_t num_sector)
{
	if (!want(ZPROF_PROTO_DISK)) {
		return __real_disk_access_write(pdrv, data_buf, start_sector, num_sector);
	}
	uint32_t t0 = now();
	int ret = __real_disk_access_write(pdrv, data_buf, start_sector, num_sector);

	disk_rec(1, pdrv, start_sector, num_sector, t0, ret);
	return ret;
}
#endif
