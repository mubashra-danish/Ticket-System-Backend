import { randomBytes, createHmac } from 'node:crypto';
import { AppService } from './app.service.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayService } from './razorpay.service.js';
import type { Payment } from './bookings.js';
describe('verified ticket payments', () => {
  let store: AppService, payments: PaymentsService, gateway: RazorpayService;
  let provider: Map<string, Payment>;
  let sequence: number;
  let createSpy: import('vitest').MockInstance<RazorpayService['create']>;
  const guest = {
    name: 'Guest',
    email: 'guest@example.com',
    phone: '+91 9876543210',
  };
  const token = () => randomBytes(32).toString('hex');
  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_test_example');
    vi.stubEnv('RAZORPAY_KEY_SECRET', 'test-secret');
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', 'webhook-secret');
    store = new AppService();
    gateway = new RazorpayService();
    payments = new PaymentsService(store, gateway);
    provider = new Map();
    sequence = 0;
    createSpy = vi.spyOn(gateway, 'create').mockImplementation(async (b) => ({
      id: 'order_' + ++sequence,
      amount: b.amount,
      currency: b.currency,
      receipt: b.id,
    }));
    vi.spyOn(gateway, 'payment').mockImplementation(async (id) => {
      const p = provider.get(id);
      if (!p) throw new Error('No payment');
      return p;
    });
    vi.spyOn(gateway, 'orderPayments').mockImplementation(async (id) => ({
      items: [...provider.values()].filter((p) => p.order_id === id),
    }));
  });
  afterEach(() => {
    payments.onModuleDestroy();
    store.onModuleDestroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const event = (capacity = 1) =>
    store.create({
      name: 'Paid event',
      location: 'Studio',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      capacity,
      amount: 50000,
    });
  async function booking(eventId: string, overrides = {}) {
    const access = token();
    return {
      access,
      b: await payments.create(eventId, {
        ...guest,
        token: access,
        ...overrides,
      }),
    };
  }
  function capture(orderId: string, id = 'pay_1', overrides = {}) {
    const p: Payment = {
      id,
      order_id: orderId,
      amount: 50000,
      currency: 'INR',
      status: 'captured',
      ...overrides,
    };
    provider.set(id, p);
    return p;
  }
  function signed(b: { orderId: string | null }, access: string, id = 'pay_1') {
    return {
      token: access,
      razorpay_payment_id: id,
      razorpay_order_id: b.orderId,
      razorpay_signature: createHmac('sha256', 'test-secret')
        .update(b.orderId + '|' + id)
        .digest('hex'),
    };
  }
  function webhook(p: Payment) {
    const raw = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: p } },
      }),
    );
    return payments.webhook(
      raw,
      createHmac('sha256', 'webhook-secret').update(raw).digest('hex'),
    );
  }
  it('uses server prices and reuses a booking without creating another provider order', async () => {
    const e = event();
    const access = token();
    const b = await payments.create(e.id, {
      ...guest,
      token: access,
      amount: 1,
    });
    expect(b.amount).toBe(50000);
    expect(store.event(e.id).registered).toBe(0);
    await payments.create(e.id, { ...guest, token: access });
    expect(createSpy).toHaveBeenCalledTimes(1);
    await expect(payments.status({ token: token() })).rejects.toThrow(
      'not found',
    );
  });
  it('reserves the final seat and prevents concurrent overselling', async () => {
    const e = event();
    const results = await Promise.allSettled([
      booking(e.id),
      booking(e.id, { email: 'other@example.com' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('requires capture and a valid signature before issuing a ticket', async () => {
    const { access, b } = await booking(event().id);
    capture(b.orderId!, 'pay_1', { status: 'authorized' });
    await expect(
      payments.verify({
        ...signed(b, access),
        razorpay_signature: '0'.repeat(64),
      }),
    ).rejects.toThrow('signature');
    expect((await payments.verify(signed(b, access))).ticket).toBeNull();
    expect(await store.outbox.list()).toHaveLength(0);
    capture(b.orderId!);
    const paid = await payments.verify(signed(b, access));
    expect(paid.status).toBe('PAID');
    expect(paid.ticket?.qr).toHaveLength(64);
    await payments.verify(signed(b, access));
    const jobs = await store.outbox.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.ticketToken).toBe(paid.ticket?.qr);
  });
  it.each([{ amount: 1 }, { currency: 'USD' }, { order_id: 'order_wrong' }])(
    'rejects mismatched payment %j',
    async (mismatch) => {
      const { access, b } = await booking(event().id);
      capture(b.orderId!, 'pay_1', mismatch);
      await expect(payments.verify(signed(b, access))).rejects.toThrow('match');
    },
  );
  it('deduplicates webhook deliveries and callback races', async () => {
    const e = event();
    const { access, b } = await booking(e.id);
    const p = capture(b.orderId!);
    await Promise.all([
      webhook(p),
      webhook(p),
      payments.verify(signed(b, access)),
    ]);
    expect(store.event(e.id).registered).toBe(1);
    const first = await payments.status({ token: access });
    await webhook(p);
    expect((await payments.status({ token: access })).ticket).toEqual(
      first.ticket,
    );
  });
  it('rejects forged webhooks', async () => {
    await expect(
      payments.webhook(Buffer.from('{}'), 'a'.repeat(64)),
    ).rejects.toThrow('signature');
  });
  it('releases expired holds and puts late captures into the refund review queue when full', async () => {
    const e = event();
    const first = await booking(e.id);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 16 * 60 * 1000);
    expect((await payments.status({ token: first.access })).status).toBe(
      'EXPIRED',
    );
    const second = await booking(e.id, { email: 'other@example.com' });
    capture(second.b.orderId!, 'pay_2');
    await payments.verify(signed(second.b, second.access, 'pay_2'));
    await webhook(capture(first.b.orderId!));
    expect((await payments.status({ token: first.access })).status).toBe(
      'PAYMENT_REVIEW',
    );
    expect(await payments.review()).toHaveLength(1);
    expect(store.event(e.id).registered).toBe(1);
    clock.mockRestore();
  });
  it('recovers a missed webhook by reconciliation, even after hold expiry when a seat is free', async () => {
    const e = event();
    const { access, b } = await booking(e.id);
    capture(b.orderId!);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
    await payments.reconcile();
    expect((await payments.status({ token: access })).status).toBe('PAID');
  });
  it('does not blindly retry provider order creation after an ambiguous timeout', async () => {
    createSpy.mockRejectedValueOnce(new Error('timeout'));
    const e = event();
    const access = token();
    await expect(
      payments.create(e.id, { ...guest, token: access }),
    ).rejects.toThrow('timeout');
    const result = await payments.create(e.id, { ...guest, token: access });
    expect(result.orderId).toBeNull();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
  it('accepts a ticket exactly once at check-in', async () => {
    const { access, b } = await booking(event().id);
    capture(b.orderId!);
    const result = await payments.verify(signed(b, access));
    await payments.checkin({ ticket: result.ticket!.qr });
    await expect(
      payments.checkin({ ticket: result.ticket!.qr }),
    ).rejects.toThrow('already');
  });
  it('keeps failed and refunded payments from issuing tickets', async () => {
    const { access, b } = await booking(event().id);
    capture(b.orderId!, 'pay_1', { status: 'failed' });
    await payments.reconcile();
    expect((await payments.status({ token: access })).ticket).toBeNull();
    capture(b.orderId!, 'pay_1', { amount_refunded: 50000 });
    expect((await payments.verify(signed(b, access))).ticket).toBeNull();
  });
  it('revokes fully refunded tickets and prevents replay from resurrecting them', async () => {
    const e = event();
    const { access, b } = await booking(e.id);
    capture(b.orderId!);
    const paid = await payments.verify(signed(b, access));
    const p = capture(b.orderId!, 'pay_1', {
      status: 'refunded',
      amount_refunded: 50000,
    });
    const raw = Buffer.from(
      JSON.stringify({
        event: 'refund.processed',
        payload: { payment: { entity: p } },
      }),
    );
    const signature = createHmac('sha256', 'webhook-secret')
      .update(raw)
      .digest('hex');
    await payments.webhook(raw, signature);
    await payments.webhook(raw, signature);
    expect((await payments.status({ token: access })).status).toBe('REFUNDED');
    expect(store.event(e.id).registered).toBe(0);
    await expect(
      payments.checkin({ ticket: paid.ticket!.qr }),
    ).rejects.toThrow();
    capture(b.orderId!);
    await webhook(provider.get('pay_1')!);
    expect((await payments.status({ token: access })).ticket).toBeNull();
  });
});
