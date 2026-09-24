import { randomBytes } from 'node:crypto';
import { AppService } from './app.service.js';
import { PaymentsService } from './payments.service.js';

describe('manual UPI payment approval', () => {
  let store: AppService, payments: PaymentsService;
  const guest = {
    name: 'Guest',
    email: 'guest@example.com',
    phone: '9876543210',
  };
  const ref = '123456789012';
  const decision = (reference = ref) => ({
    reference,
    amount: 50000,
    receivedInBank: true,
    note: 'Matched Guest and payment date in receiving bank statement',
  });
  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('PAYMENT_UPI_ID', 'organizer@bank');
    vi.stubEnv('PAYMENT_PAYEE_NAME', 'Organizer');
    store = new AppService();
    payments = new PaymentsService(store);
  });
  afterEach(() => {
    store.onModuleDestroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const event = (capacity = 2) =>
    store.create({
      name: 'Concert',
      location: 'Hall',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      capacity,
      amount: 50000,
    });
  async function booking(id: string, address = guest.email) {
    const token = randomBytes(32).toString('hex');
    const b = await payments.create(id, {
      ...guest,
      email: address,
      token,
      amount: 1,
    });
    return { b, token };
  }
  async function submitted(id: string, address = guest.email, reference = ref) {
    const result = await booking(id, address);
    await payments.submit({ token: result.token, reference });
    return result;
  }
  it('requires real payment instructions and refuses free-endpoint bypass', async () => {
    const e = event();
    expect(() => store.register(e.id, guest)).toThrow();
    vi.stubEnv('PAYMENT_UPI_ID', '');
    await expect(booking(e.id)).rejects.toThrow('not available');
    expect(() => event()).toThrow('PAYMENT_UPI_ID');
  });
  it('uses server price, snapshots recipient and does not issue tickets or email on a claim', async () => {
    const e = event();
    const { b, token } = await booking(e.id);
    expect(b.amount).toBe(50000);
    vi.stubEnv('PAYMENT_UPI_ID', 'changed@bank');
    const pending = await payments.submit({
      token,
      reference: ref,
      status: 'PAID',
    });
    expect(pending.status).toBe('AWAITING_APPROVAL');
    expect(pending.ticket).toBeNull();
    expect(pending.paymentInstructions?.upiId).toBe('organizer@bank');
    expect(store.event(e.id).registered).toBe(0);
    expect(await store.outbox.list()).toHaveLength(0);
    expect(await payments.review()).toHaveLength(1);
    expect((await payments.submit({ token, reference: ref })).status).toBe(
      'AWAITING_APPROVAL',
    );
    await expect(
      payments.submit({ token, reference: '222222222222' }),
    ).rejects.toThrow('already been submitted');
  });
  it('validates references and private booking access', async () => {
    const { token } = await booking(event().id);
    await expect(
      payments.submit({ token, reference: 'screenshot' }),
    ).rejects.toThrow('12-digit');
    await expect(
      payments.status({ token: randomBytes(32).toString('hex') }),
    ).rejects.toThrow('not found');
  });
  it('requires a submitted claim and exact verified bank details', async () => {
    const { b, token } = await booking(event().id);
    await expect(payments.approve(b.id, decision(), 'admin')).rejects.toThrow();
    await payments.submit({ token, reference: ref });
    for (const patch of [
      { receivedInBank: false },
      { amount: 1 },
      { reference: '222222222222' },
      { note: '' },
    ])
      await expect(
        payments.approve(b.id, { ...decision(), ...patch }, 'admin'),
      ).rejects.toThrow();
    expect(await store.outbox.list()).toHaveLength(0);
  });
  it('atomically approves once, records the admin, queues one email and allows one check-in', async () => {
    const e = event();
    const { b, token } = await submitted(e.id);
    const [one, two] = await Promise.all([
      payments.approve(b.id, decision(), 'admin@example.com'),
      payments.approve(b.id, decision(), 'admin@example.com'),
    ]);
    expect(one.status).toBe('PAID');
    expect(two.ticket).toEqual(one.ticket);
    expect(store.event(e.id).registered).toBe(1);
    expect(await store.outbox.list()).toHaveLength(1);
    expect((await store.bookings.get(b.id))?.decision?.actor).toBe(
      'admin@example.com',
    );
    expect((await payments.status({ token })).ticket?.qr).toHaveLength(64);
    await payments.checkin({ ticket: one.ticket?.qr });
    await expect(payments.checkin({ ticket: one.ticket?.qr })).rejects.toThrow(
      'already been checked in',
    );
    await expect(
      payments.reject(b.id, { reason: 'No' }, 'admin'),
    ).rejects.toThrow();
  });
  it('prevents a verified reference being reused across events and rolls back the second approval', async () => {
    const a = await submitted(event().id);
    const b = await submitted(event().id, 'other@example.com');
    await payments.approve(a.b.id, decision(), 'admin');
    await expect(payments.approve(b.b.id, decision(), 'admin')).rejects.toThrow(
      'already been used',
    );
    expect((await payments.status({ token: b.token })).status).toBe(
      'AWAITING_APPROVAL',
    );
    expect(await store.outbox.list()).toHaveLength(1);
  });
  it('does not let an unverified claim block the legitimate use of a reference', async () => {
    await submitted(event().id, 'claim@example.com');
    const valid = await submitted(event().id, 'real@example.com');
    expect(
      (await payments.approve(valid.b.id, decision(), 'admin')).status,
    ).toBe('PAID');
  });
  it('rejects without issuing an email, releases the seat and prevents later approval', async () => {
    const e = event(1);
    const { b, token } = await submitted(e.id);
    const rejected = await payments.reject(
      b.id,
      { reason: 'No matching credit. Contact us with the correct reference.' },
      'admin',
    );
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.ticket).toBeNull();
    expect((await payments.status({ token })).message).toContain(
      'No matching credit',
    );
    await expect(payments.approve(b.id, decision(), 'admin')).rejects.toThrow();
    await expect(payments.submit({ token, reference: ref })).rejects.toThrow();
    expect(await store.outbox.list()).toHaveLength(0);
    await booking(e.id);
  });
  it('holds seats for pending approval and prevents duplicate bookings', async () => {
    const e = event(1);
    await submitted(e.id);
    await expect(booking(e.id, 'other@example.com')).rejects.toThrow(
      'reserved',
    );
    await expect(booking(e.id)).rejects.toThrow('already');
  });
  it('does not oversell when an expired payment is approved after another booking took the seat', async () => {
    const e = event(1);
    const old = await submitted(e.id);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60000);
    const next = await submitted(e.id, 'other@example.com', '222222222222');
    const late = await payments.approve(old.b.id, decision(), 'admin');
    expect(late.status).toBe('PAYMENT_REVIEW');
    expect(late.ticket).toBeNull();
    expect(late.message).toContain('refund');
    expect(
      (await payments.approve(next.b.id, decision('222222222222'), 'admin'))
        .status,
    ).toBe('PAID');
    expect(store.event(e.id).registered).toBe(1);
    clock.mockRestore();
  });
  it('allows reporting a late transfer and approving it if a seat is available', async () => {
    const { b, token } = await booking(event().id);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60000);
    expect((await payments.status({ token })).status).toBe('EXPIRED');
    await payments.submit({ token, reference: ref });
    expect((await payments.approve(b.id, decision(), 'admin')).status).toBe(
      'PAID',
    );
  });
  it('rolls back the approval if email queue persistence fails', async () => {
    const e = event();
    const { b, token } = await submitted(e.id);
    vi.spyOn(store.outbox, 'enqueue').mockImplementation(() => {
      throw new Error('disk failure');
    });
    await expect(payments.approve(b.id, decision(), 'admin')).rejects.toThrow(
      'disk failure',
    );
    expect(store.event(e.id).registered).toBe(0);
    expect((await payments.status({ token })).status).toBe('AWAITING_APPROVAL');
  });
});
