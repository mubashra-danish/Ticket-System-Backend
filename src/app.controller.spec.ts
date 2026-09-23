import { AppService } from './app.service.js';
describe('registration rules', () => {
  let service: AppService;
  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    service = new AppService();
  });
  afterEach(() => service.onModuleDestroy());
  const event = () => ({
    name: 'Meetup',
    location: 'Studio',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    capacity: 1,
  });
  const guest = {
    name: 'Guest',
    email: 'guest@example.com',
    phone: '+91 9876543210',
  };
  it('prevents duplicate registrations and overselling', () => {
    const created = service.create(event());
    service.register(created.id, guest);
    expect(() => service.register(created.id, guest)).toThrow(
      'already registered',
    );
    expect(() =>
      service.register(created.id, { ...guest, email: 'other@example.com' }),
    ).toThrow('full');
    expect(service.event(created.id).registered).toBe(1);
  });
  it('rejects invalid capacities, dates, and unsupported payments', () => {
    expect(() => service.create({ ...event(), capacity: 0 })).toThrow(
      'Capacity',
    );
    expect(() => service.create({ ...event(), startsAt: 'invalid' })).toThrow(
      'future',
    );
    expect(() => service.create({ ...event(), amount: 100 })).toThrow(
      'payment',
    );
  });
  it('rejects invalid attendees without reserving seats', () => {
    const created = service.create(event());
    expect(() =>
      service.register(created.id, { ...guest, email: 'broken' }),
    ).toThrow('email');
    expect(service.event(created.id).registered).toBe(0);
  });
});
