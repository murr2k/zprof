/*
 * zprof's TCP transport: one client at a time on CONFIG_ZPROF_TCP_PORT.
 *
 * At connect: the preamble, then the hello on the control channel (versions,
 * build id, clocks, ring size, the sender thread, the thread table, the
 * interrupt table), then the hooks start recording. Every
 * CONFIG_ZPROF_SENDER_PERIOD_MS the sender sends what the ring holds, in
 * frames of whole records of at most CONFIG_ZPROF_SEND_CHUNK bytes, straight
 * from the ring (TCP copies the data inside send), and frees it after. A SYNC
 * record every CONFIG_ZPROF_SYNC_MS ties the timestamp to the kernel's 64-bit
 * cycle count; once a second the kernel's own per-thread execution cycles go
 * into the trace too (THREAD_STATS), for checking the trace against them, and
 * the thread table is sent again if it changed. A client that closes, or a
 * send stalled for 5 s, ends the session.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/irq.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/socket.h>
#include <zephyr/sw_isr_table.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/version.h>
#include <cmsis_core.h>

#include <zprof/proto.h>
#include <zprof/zprof.h>

#include "zprof_internal.h"

LOG_MODULE_REGISTER(zprof, LOG_LEVEL_INF);

#define MASK (ZPROF_RING_WORDS - 1u)

extern const uint8_t zprof_build_id[16];

static uint16_t seq[8];
static uint8_t hb[768]; /* hello and thread table, sent in frames of this size */
static size_t hn;
static uint32_t threads_sig;

static int send_iov(int s, struct iovec *iov, int n)
{
	while (n > 0) {
		struct msghdr msg = {.msg_iov = iov, .msg_iovlen = n};
		ssize_t r = zsock_sendmsg(s, &msg, 0);

		if (r < 0) {
			return -errno;
		}
		/* step over what went */
		while (n > 0 && (size_t)r >= iov->iov_len) {
			r -= iov->iov_len;
			iov++;
			n--;
		}
		if (n > 0) {
			iov->iov_base = (uint8_t *)iov->iov_base + r;
			iov->iov_len -= r;
		}
	}
	return 0;
}

static int send_frame(int s, uint8_t ch, const void *p1, size_t n1, const void *p2, size_t n2)
{
	uint8_t hdr[ZPROF_FRAME_HDR];
	struct iovec iov[3];
	int n = 0;

	hdr[0] = ch;
	hdr[1] = 0;
	sys_put_le16(seq[ch & 7]++, &hdr[2]);
	sys_put_le32((uint32_t)(n1 + n2), &hdr[4]);
	iov[n++] = (struct iovec){.iov_base = hdr, .iov_len = sizeof(hdr)};
	if (n1 > 0) {
		iov[n++] = (struct iovec){.iov_base = (void *)p1, .iov_len = n1};
	}
	if (n2 > 0) {
		iov[n++] = (struct iovec){.iov_base = (void *)p2, .iov_len = n2};
	}
	return send_iov(s, iov, n);
}

static int hflush(int s)
{
	int r = hn > 0 ? send_frame(s, ZPROF_CH_CONTROL, hb, hn, NULL, 0) : 0;

	hn = 0;
	return r;
}

static int tlv(int s, uint16_t tag, const void *v, uint16_t len)
{
	if (hn + 4u + len > sizeof(hb) && hflush(s) < 0) {
		return -EIO;
	}
	if (4u + len > sizeof(hb)) {
		return -EINVAL;
	}
	sys_put_le16(tag, &hb[hn]);
	sys_put_le16(len, &hb[hn + 2]);
	memcpy(&hb[hn + 4], v, len);
	hn += 4u + len;
	return 0;
}

struct table_ctx {
	int s;
	int err;
	uint32_t sig;
	bool send;
};

/* the hello's metric dictionary and capture status (defined with the capture code) */
struct dict_ctx {
	int s;
	int err;
};
static void dict_entry(uint16_t index, const struct zprof_metric *m, void *user);
static int cap_status(int s);
static int rec_status(int s);

static void thread_entry(const struct k_thread *t, void *user)
{
	struct table_ctx *c = user;
	const char *name = k_thread_name_get((k_tid_t)t);
	size_t nl = name ? strnlen(name, CONFIG_THREAD_MAX_NAME_LEN) : 0;

	c->sig = c->sig * 31u + (uint32_t)(uintptr_t)t + (uint32_t)nl + (nl ? (uint8_t)name[0] : 0u);
	if (!c->send || c->err) {
		return;
	}
	uint8_t v[20 + CONFIG_THREAD_MAX_NAME_LEN];

	sys_put_le32((uint32_t)(uintptr_t)t, &v[0]);
	sys_put_le32((uint32_t)(int32_t)t->base.prio, &v[4]);
#ifdef CONFIG_THREAD_MONITOR
	sys_put_le32((uint32_t)(uintptr_t)t->entry.pEntry, &v[8]);
#else
	sys_put_le32(0, &v[8]);
#endif
	sys_put_le32((uint32_t)t->stack_info.start, &v[12]);
	sys_put_le32((uint32_t)t->stack_info.size, &v[16]);
	memcpy(&v[20], name, nl);
	c->err = tlv(c->s, ZPROF_HT_THREAD, v, (uint16_t)(20u + nl));
}

/* The thread table: sent when `send`, and its signature returned either way. */
static int thread_table(int s, bool send, uint32_t *sig)
{
	struct table_ctx c = {.s = s, .send = send};

	k_thread_foreach_unlocked(thread_entry, &c);
	*sig = c.sig;
	if (send && !c.err) {
		c.err = tlv(s, ZPROF_HT_END, NULL, 0);
		if (!c.err) {
			c.err = hflush(s);
		}
	}
	return c.err;
}

static int hello(int s)
{
	uint8_t v[16];
	int err = 0;

	sys_put_le16(ZPROF_PROTO_VERSION, v);
	err |= tlv(s, ZPROF_HT_PROTO, v, 2);
	err |= tlv(s, ZPROF_HT_KERNEL, KERNEL_VERSION_STRING, sizeof(KERNEL_VERSION_STRING) - 1);
	{
		uint8_t b[20];

		memcpy(b, zprof_build_id, 16);
		sys_put_le32((uint32_t)(uintptr_t)zprof_build_id, &b[16]);
		err |= tlv(s, ZPROF_HT_BUILD_ID, b, sizeof(b));
	}
	sys_put_le32(zprof_ts_hz(), &v[0]);
	sys_put_le32(sys_clock_hw_cycles_per_sec(), &v[4]);
	sys_put_le32(IS_ENABLED(CONFIG_ZPROF_TS_DWT) ? ZPROF_TS_SRC_DWT : ZPROF_TS_SRC_KCYCLE, &v[8]);
	err |= tlv(s, ZPROF_HT_CLOCKS, v, 12);
	sys_put_le32(CONFIG_ZPROF_RING_SIZE, v);
	err |= tlv(s, ZPROF_HT_RING, v, 4);
	sys_put_le32((uint32_t)(uintptr_t)k_current_get(), v);
	err |= tlv(s, ZPROF_HT_SENDER, v, 4);
	sys_put_le32(zprof_classes, v);
	err |= tlv(s, ZPROF_HT_CLASSES, v, 4);
#ifdef CONFIG_GEN_SW_ISR_TABLE
	for (unsigned int irq = 0; irq < IRQ_TABLE_SIZE && !err; irq++) {
		const struct _isr_table_entry *e = &_sw_isr_table[irq];

		if (e->isr == z_irq_spurious) {
			continue;
		}
		sys_put_le16((uint16_t)irq, &v[0]);
		v[2] = (uint8_t)NVIC_GetPriority((IRQn_Type)irq);
		v[3] = (uint8_t)irq_is_enabled(irq);
		sys_put_le32((uint32_t)(uintptr_t)e->isr, &v[4]);
		sys_put_le32((uint32_t)(uintptr_t)e->arg, &v[8]);
		err |= tlv(s, ZPROF_HT_IRQ, v, 12);
	}
#endif
	if (err) {
		return -EIO;
	}
	struct dict_ctx dc = {.s = s};

	zprof_metric_dict(dict_entry, &dc);
	if (dc.err || cap_status(s) < 0 || rec_status(s) < 0) {
		return -EIO;
	}
	return thread_table(s, true, &threads_sig);
}

#ifdef CONFIG_THREAD_RUNTIME_STATS
static void stats_entry(const struct k_thread *t, void *user)
{
	k_thread_runtime_stats_t st;

	ARG_UNUSED(user);
	if (k_thread_runtime_stats_get((k_tid_t)t, &st) == 0) {
		zprof_put(ZPROF_EV_THREAD_STATS, 0, 3, (uint32_t)(uintptr_t)t,
			  (uint32_t)st.execution_cycles, (uint32_t)(st.execution_cycles >> 32), 0);
	}
}
#endif

static void thread_stats(void)
{
#ifdef CONFIG_THREAD_RUNTIME_STATS
	k_thread_foreach_unlocked(stats_entry, NULL);
#endif
}

/* Send what the ring holds, in frames of whole records. */
static int drain(int s)
{
	struct zprof_ring *r = &zprof_ring;
	uint32_t t = r->tail;
	uint32_t h = r->head;

	while (t != h) {
		uint32_t end = t;

		while (end != h) {
			uint32_t n = ZPROF_REC_WORDS(ZPROF_REC_NW(r->w[(end + 1u) & MASK]));

			if ((end - t + n) * 4u > CONFIG_ZPROF_SEND_CHUNK) {
				break;
			}
			end += n;
		}
		uint32_t a = t & MASK;
		uint32_t words = end - t;
		uint32_t first = words < ZPROF_RING_WORDS - a ? words : ZPROF_RING_WORDS - a;
		int err = send_frame(s, ZPROF_CH_TRACE, &r->w[a], first * 4u, &r->w[0],
				     (words - first) * 4u);

		if (err) {
			return err;
		}
		t = end;
		compiler_barrier();
		r->tail = t;
	}
	return 0;
}

/*
 * Capture-then-upload: the hooks write straight into a buffer from the port
 * (zprof_port_alloc, asked once) instead of the ring (zprof_capture_begin), and
 * the sender sends only a status every 500 ms. Nothing has to keep up with the
 * events meanwhile: a sender held off by the network stack (a screenshot's
 * 1.5 MB send makes about 2 MB/s of events) loses nothing, where moving the
 * ring into the buffer lost records whenever the ring filled first. At the end
 * (the time asked for, the host's stop, or the buffer full) the hooks go back
 * to the ring and the buffer goes as ordinary trace frames, so the host decodes
 * it as the stream it would have been. Records the ring could not hold during
 * the upload are an OVERFLOW, as in streaming.
 */
static struct {
	uint8_t state;      /* ZPROF_CAP_* */
	bool tried, stop;
	uint32_t *buf;
	uint32_t cap, len;  /* words; len: written, once the capture has ended */
	uint32_t t0, ms;    /* uptime at the start; length asked for (0: until stopped or full) */
	uint32_t lost0;     /* the session's losses when it began */
} cap;

/* Words in the capture so far (the hooks' count while recording). */
static uint32_t cap_words(void)
{
	return cap.state == ZPROF_CAP_RECORDING ? zprof_ring.cap_len : cap.len;
}

#define CAP_BYTES ((uint32_t)CONFIG_ZPROF_CAPTURE_KB * 1024u)

static int cap_status(int s)
{
	uint8_t v[16];

	sys_put_le32(cap.state, &v[0]);
	sys_put_le32(cap_words() * 4u, &v[4]);
	sys_put_le32(cap.buf != NULL ? cap.cap * 4u : (cap.tried ? 0u : CAP_BYTES), &v[8]);
	sys_put_le32(cap.state == ZPROF_CAP_RECORDING ? k_uptime_get_32() - cap.t0 : 0u, &v[12]);
	return (tlv(s, ZPROF_HT_CAPTURE, v, sizeof(v)) < 0 || hflush(s) < 0) ? -EIO : 0;
}

static void cap_start(uint32_t ms)
{
	if (!cap.tried && CAP_BYTES > 0u) {
		cap.tried = true;
		cap.buf = zprof_port_alloc(CAP_BYTES);
		cap.cap = cap.buf != NULL ? CAP_BYTES / 4u : 0u;
	}
	if (cap.buf == NULL) {
		cap.state = ZPROF_CAP_UNAVAILABLE;
		return;
	}
	cap.len = 0u;
	cap.ms = ms;
	cap.stop = false;
	cap.t0 = k_uptime_get_32();
	cap.lost0 = zprof_ring.dropped_all;
	cap.state = ZPROF_CAP_RECORDING;
	zprof_capture_begin(cap.buf, cap.cap);
	LOG_INF("capture: recording %u KB for %u ms", cap.cap / 256u, ms);
}

/* Full: a record was refused since it began, or nearly no room is left. */
static bool cap_full(void)
{
	return zprof_ring.dropped_all != cap.lost0 || zprof_ring.cap_len + 64u > cap.cap;
}

static int cap_upload(int s)
{
	uint32_t t = 0;

	while (t < cap.len) {
		uint32_t end = t;

		while (end < cap.len) {
			uint32_t n = ZPROF_REC_WORDS(ZPROF_REC_NW(cap.buf[end + 1u]));

			if ((end - t + n) * 4u > CONFIG_ZPROF_SEND_CHUNK) {
				break;
			}
			end += n;
		}
		if (send_frame(s, ZPROF_CH_TRACE, &cap.buf[t], (end - t) * 4u, NULL, 0) < 0) {
			return -EIO;
		}
		t = end;
	}
	return 0;
}

/* Stop recording, send the buffer, report it done; then streaming carries on. */
static int cap_finish(int s)
{
	cap.len = zprof_capture_end();   /* the hooks write the ring again */
	uint32_t bytes = cap.len * 4u;

	cap.state = ZPROF_CAP_UPLOADING;
	if (cap_status(s) < 0 || cap_upload(s) < 0) {
		return -EIO;
	}
	cap.state = ZPROF_CAP_DONE;
	if (cap_status(s) < 0) {
		return -EIO;
	}
	LOG_INF("capture: %u KB uploaded", bytes / 1024u);
	cap.state = ZPROF_CAP_OFF;
	cap.len = 0u;
	return 0;
}

/* The flight recorder's state: HT_RECORDER. */
static int rec_status(int s)
{
	uint8_t v[16];
	uint32_t held = zprof_rec.state == ZPROF_REC_HELD ? (zprof_ring.head - zprof_ring.tail) * 4u : 0u;

	sys_put_le32(zprof_rec.state, &v[0]);
	sys_put_le32(zprof_rec.post_ms, &v[4]);
	sys_put_le32(zprof_rec.triggers, &v[8]);
	sys_put_le32(held, &v[12]);
	return (tlv(s, ZPROF_HT_RECORDER, v, sizeof(v)) < 0 || hflush(s) < 0) ? -EIO : 0;
}

/* The metric dictionary in the hello: u16 index, u8 kind, u8 0, name NUL unit. */
static void dict_entry(uint16_t index, const struct zprof_metric *m, void *user)
{
	struct dict_ctx *c = user;
	uint8_t v[4 + 96];
	size_t nl = strnlen(m->name, 63), ul = strnlen(m->unit, 31);

	if (c->err) {
		return;
	}
	sys_put_le16(index, &v[0]);
	v[2] = m->kind;
	v[3] = 0;
	memcpy(&v[4], m->name, nl);
	v[4 + nl] = 0;
	memcpy(&v[5 + nl], m->unit, ul);
	c->err = tlv(c->s, ZPROF_HT_METRIC, v, (uint16_t)(5u + nl + ul));
}

/*
 * Control from the host: frames on the control channel holding TLV commands.
 * Read without waiting, a few bytes at a time, between sends; a frame too long
 * for the buffer is skipped. Answers go out as TLV in a control frame.
 */
static uint8_t cb[64];
static size_t cn;
static uint32_t cskip;

static int control(int s, const uint8_t *p, size_t n)
{
	while (n >= 4u) {
		uint16_t tag = sys_get_le16(p);
		uint16_t len = sys_get_le16(p + 2);

		if (4u + len > n) {
			break;
		}
		if (tag == ZPROF_CT_CLASSES && len == 4u) {
			uint8_t v[4];

			zprof_classes = sys_get_le32(p + 4) & BIT_MASK(ZPROF_OBJ_LAST - ZPROF_OBJ_FIRST + 1);
			sys_put_le32(zprof_classes, v);
			if (tlv(s, ZPROF_HT_CLASSES, v, sizeof(v)) < 0 || hflush(s) < 0) {
				return -EIO;
			}
			LOG_INF("recording object classes 0x%02x", zprof_classes);
		} else if (tag == ZPROF_CT_CAPTURE && len == 4u) {
			if (cap.state != ZPROF_CAP_RECORDING) {
				cap_start(sys_get_le32(p + 4));
			}
			if (cap_status(s) < 0) {
				return -EIO;
			}
		} else if (tag == ZPROF_CT_CAPTURE_STOP) {
			cap.stop = true;
		} else if (tag == ZPROF_CT_RECORDER && len == 4u) {
			/* takes effect when this client leaves: it records while nobody streams */
			zprof_recorder_set(sys_get_le32(p + 4));
			LOG_INF("flight recorder %s", zprof_rec.state == ZPROF_REC_OFF ? "off" : "armed");
			if (rec_status(s) < 0) {
				return -EIO;
			}
		}
		p += 4u + len;
		n -= 4u + len;
	}
	return 0;
}

/* 0: nothing more for now; < 0: the client left or the connection broke */
static int poll_control(int s)
{
	for (;;) {
		ssize_t n = zsock_recv(s, &cb[cn], sizeof(cb) - cn, ZSOCK_MSG_DONTWAIT);

		if (n == 0) {
			return -ENOTCONN;
		}
		if (n < 0) {
			return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -errno;
		}
		cn += (size_t)n;
		for (;;) {
			if (cskip > 0) {
				size_t k = cskip < cn ? cskip : cn;

				memmove(cb, &cb[k], cn - k);
				cn -= k;
				cskip -= k;
				if (cskip > 0) {
					break;
				}
			}
			if (cn < ZPROF_FRAME_HDR) {
				break;
			}
			uint32_t len = sys_get_le32(&cb[4]);

			if (ZPROF_FRAME_HDR + len > sizeof(cb)) {
				cskip = ZPROF_FRAME_HDR + len;   /* too long for us: step over it */
				continue;
			}
			if (cn < ZPROF_FRAME_HDR + len) {
				break;
			}
			if (cb[0] == ZPROF_CH_CONTROL && control(s, &cb[ZPROF_FRAME_HDR], len) < 0) {
				return -EIO;
			}
			memmove(cb, &cb[ZPROF_FRAME_HDR + len], cn - ZPROF_FRAME_HDR - len);
			cn -= ZPROF_FRAME_HDR + len;
		}
	}
}

static void session(int s)
{
	uint8_t pre[8] = {'Z', 'P', 'R', 'F'};
	uint32_t t_sync, t_stats;

	memset(seq, 0, sizeof(seq));
	hn = 0;
	cn = 0;
	cskip = 0;
	if (cap.state != ZPROF_CAP_UNAVAILABLE) {
		cap.state = ZPROF_CAP_OFF;   /* a capture in progress went with the last client */
	}
	cap.len = 0u;
	/* every session starts recording every class: a client that says nothing gets
	 * them all, whatever the last one chose (the bridge sends its choice again) */
	zprof_classes = BIT_MASK(ZPROF_OBJ_LAST - ZPROF_OBJ_FIRST + 1);
	sys_put_le16(ZPROF_PROTO_VERSION, &pre[4]);
	sys_put_le16(0, &pre[6]);
	struct iovec iov = {.iov_base = pre, .iov_len = sizeof(pre)};

	if (send_iov(s, &iov, 1) < 0 || hello(s) < 0) {
		return;
	}
	/* A held flight recording goes first, as ordinary trace frames: the ring still
	 * holds it (the hooks stopped at the freeze), ending with a SYNC the host places
	 * it by. Then this session starts afresh; the recorder is armed again. */
	if (zprof_rec.state == ZPROF_REC_HELD) {
		uint32_t bytes = (zprof_ring.head - zprof_ring.tail) * 4u;

		if (drain(s) < 0) {
			return;
		}
		zprof_recorder_taken();
		if (rec_status(s) < 0) {
			return;
		}
		LOG_INF("flight recording sent: %u KB", bytes / 1024u);
	}
	/* what one hook costs, measured with the ring on, its records thrown away */
	zprof_session(true);
	uint8_t cost[4];

	sys_put_le32(zprof_calibrate(), cost);
	zprof_session(true);
	if (tlv(s, ZPROF_HT_HOOK_COST, cost, sizeof(cost)) < 0 || hflush(s) < 0) {
		return;
	}
	zprof_sync();
	thread_stats();
	zprof_heartbeat_reset();
	uint32_t last_drain = k_uptime_get_32();
	uint32_t t_hb = last_drain, t_cap = last_drain, n_hb = 0;

	t_sync = t_stats = last_drain;

	bool busy = false;

	for (;;) {
		struct zprof_ring *r = &zprof_ring;

		/* No sleep when the ring is half full; a short one while it fills fast
		 * (a busy network stack makes 100,000 events a second, which fill a
		 * 32 KB ring in 25 ms: measured on the N6 under a 1.5 MB screenshot). */
		if ((r->head - r->tail) < ZPROF_RING_WORDS / 2u) {
			k_msleep(busy ? CONFIG_ZPROF_SENDER_BUSY_MS : CONFIG_ZPROF_SENDER_PERIOD_MS);
		}
		uint32_t now = k_uptime_get_32();
		uint32_t held = (r->head - r->tail) * 4u;

		if (held / 4u > zprof_ring_peak) {
			zprof_ring_peak = held / 4u;
		}
		if (cap.state == ZPROF_CAP_RECORDING) {
			/* the hooks write the capture buffer; what the ring held before goes
			 * out first (older than the capture), then nothing but a status */
			if (held > 0u && drain(s) < 0) {
				break;
			}
			if (cap_full() || cap.stop || (cap.ms != 0u && now - cap.t0 >= cap.ms)) {
				if (cap_finish(s) < 0) {
					break;
				}
				last_drain = now;
			} else if (now - t_cap >= 500u) {
				if (cap_status(s) < 0) {
					break;
				}
				t_cap = now;
			}
		} else if (held >= CONFIG_ZPROF_DRAIN_BYTES || now - last_drain >= CONFIG_ZPROF_DRAIN_MS) {
			/* a send costs about the same whatever its size: send when there is
			 * enough to be worth one, or the data is getting old */
			if (drain(s) < 0) {
				break;
			}
			last_drain = now;
		}
		busy = held >= CONFIG_ZPROF_RING_SIZE / 8u;

		if (now - t_hb >= CONFIG_ZPROF_HEARTBEAT_MS) {
			zprof_heartbeat(n_hb++);
			t_hb = now;
		}

		if (now - t_sync >= CONFIG_ZPROF_SYNC_MS) {
			zprof_sync();
			t_sync = now;
		}
		if (now - t_stats >= 1000u) {
			uint32_t sig;

			thread_stats();
			thread_table(s, false, &sig);
			if (sig != threads_sig) {
				threads_sig = sig;
				if (thread_table(s, true, &sig) < 0) {
					break;
				}
			}
			t_stats = now;
		}
		/* control from the host; also how a client that left is noticed */
		if (poll_control(s) < 0) {
			break;
		}
	}
	LOG_INF("session ended, %u records dropped", zprof_ring.dropped_all);
}

static int listen_socket(void)
{
	struct sockaddr_in addr = {
		.sin_family = AF_INET,
		.sin_port = htons(CONFIG_ZPROF_TCP_PORT),
		.sin_addr = {.s_addr = htonl(INADDR_ANY)},
	};

	for (;;) {
		int srv = zsock_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);

		if (srv >= 0 && zsock_bind(srv, (struct sockaddr *)&addr, sizeof(addr)) == 0 &&
		    zsock_listen(srv, 1) == 0) {
			return srv;
		}
		if (srv >= 0) {
			zsock_close(srv);
		}
		k_sleep(K_SECONDS(1));
	}
}

/*
 * Serve sessions for ever. A session ends when its client closes, a send fails
 * or stalls for 5 s (a cable pulled: the bridge reconnects once the link is back
 * and is accepted as soon as this one has given up), and the listening socket is
 * made again if accept keeps failing, so no network fault needs a reset.
 */
static void sender(void *p1, void *p2, void *p3)
{
	zprof_self = k_current_get();

	int srv = listen_socket();
	int fails = 0;

	LOG_INF("zprof on tcp/%d", CONFIG_ZPROF_TCP_PORT);

	for (;;) {
		int c = zsock_accept(srv, NULL, NULL);

		if (c < 0) {
			if (++fails >= 10) {
				LOG_WRN("accept keeps failing (%d): listening again", errno);
				zsock_close(srv);
				srv = listen_socket();
				fails = 0;
			}
			k_msleep(100);
			continue;
		}
		fails = 0;
		struct zsock_timeval tv = {.tv_sec = 5};
		int one = 1;

		zsock_setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
		zsock_setsockopt(c, IPPROTO_TCP, ZSOCK_TCP_NODELAY, &one, sizeof(one));
		LOG_INF("session started");
		session(c);
		zprof_session(false);
		zsock_close(c);
		zprof_recorder_resume();   /* nobody streams: the flight recorder records, if armed */
	}
}

/* named "zprof_sender" by K_THREAD_DEFINE */
K_THREAD_DEFINE(zprof_sender, CONFIG_ZPROF_SENDER_STACK, sender, NULL, NULL, NULL,
		CONFIG_ZPROF_SENDER_PRIO, 0, 1000);
