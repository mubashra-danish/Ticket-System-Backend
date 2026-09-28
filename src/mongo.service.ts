import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { MongoClient, MongoServerError } from 'mongodb';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  digest,
  field,
  email,
  eventAmount,
  type EventRow,
} from './app.service.js';
import { MongoBookings } from './mongo-bookings.js';
import { MongoEmailOutbox } from './mongo-email-outbox.js';
import { emailJob } from './email-outbox.js';
const deriveKey = promisify(scrypt);
type Registration = {
  id: string;
  eventId: string;
  eventName: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
};
export class MongoService {
  readonly bookings: MongoBookings;
  readonly outbox: MongoEmailOutbox;
  private constructor(private readonly client: MongoClient) {
    this.outbox = new MongoEmailOutbox(this.db);
    this.bookings = new MongoBookings(client, this.db, this.outbox);
  }
  private get db() {
    return this.client.db(process.env.MONGODB_DATABASE || undefined);
  }
  static async connect(uri: string) {
    let client: MongoClient | undefined;
    try {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const service = new MongoService(client);
      const hello = await service.db.command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid')
        throw new Error('Replica set required');
      await service.bookings.init();
      await service.outbox.init();
      await service.db
        .collection('events')
        .createIndex({ id: 1 }, { unique: true });
      await service.db
        .collection('registrations')
        .createIndex({ eventId: 1, email: 1 }, { unique: true });
      await service.db
        .collection('registrations')
        .createIndex({ createdAt: -1 });
      await service.db
        .collection('sessions')
        .createIndex({ token: 1 }, { unique: true });
      await service.db
        .collection('sessions')
        .createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
      await service.db
        .collection('limits')
        .createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
      return service;
    } catch(error) {
      await client?.close();
       console.error('================ MONGODB ERROR ================');
  console.error(error);
  console.error('=================================================');

      throw new Error(
        'MongoDB setup failed. Check the saved URI, database user permissions, network access, and replica set support (Atlas is supported).',
      );
    }
  }
  async onModuleDestroy() {
    await this.client.close();
  }
  async limit(key: string, maximum: number, windowMs: number) {
    const now = Date.now(),
      window = Math.floor(now / windowMs);
    const result = await this.db
      .collection<{ _id: string; count: number; expires: Date }>('limits')
      .findOneAndUpdate(
        { _id: key + ':' + window },
        {
          $inc: { count: 1 },
          $setOnInsert: { expires: new Date((window + 1) * windowMs) },
        },
        { upsert: true, returnDocument: 'after' },
      );
    return !!result && result.count <= maximum;
  }
  async login(body: Record<string, unknown>) {
    const address = email(body),
      password = field(body, 'password', 256);
    const [salt, hash] = (process.env.ADMIN_PASSWORD_HASH || '').split(':');
    if (!salt || !/^[a-f0-9]{128}$/.test(hash || ''))
      throw new UnauthorizedException('Admin account is not configured');
    const actual = (await deriveKey(password, salt, 64)) as Buffer;
    if (
      !timingSafeEqual(actual, Buffer.from(hash, 'hex')) ||
      address !== process.env.ADMIN_EMAIL?.toLowerCase()
    )
      throw new UnauthorizedException('Invalid email or password');
    const token = randomBytes(32).toString('hex');
    await this.db.collection('sessions').insertOne({
      token: digest(token),
      expires: new Date(Date.now() + 8 * 60 * 60 * 1000),
    });
    return token;
  }
  async authenticated(token: string) {
    return !!(await this.db
      .collection('sessions')
      .findOne(
        { token: digest(token), expires: { $gt: new Date() } },
        { projection: { _id: 1 } },
      ));
  }
  async logout(token: string) {
    await this.db.collection('sessions').deleteOne({ token: digest(token) });
  }
  async events() {
    return this.db
      .collection<EventRow>('events')
      .find({}, { projection: { _id: 0 } })
      .sort({ startsAt: 1 })
      .toArray();
  }
  async event(id: string) {
    const event = await this.db
      .collection<EventRow>('events')
      .findOne({ id }, { projection: { _id: 0 } });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }
  async create(body: Record<string, unknown>) {
    const name = field(body, 'name', 120),
      location = field(body, 'location', 240),
      startsAt = field(body, 'startsAt', 40),
      capacity = body.capacity;
    if (
      !Number.isFinite(Date.parse(startsAt)) ||
      Date.parse(startsAt) <= Date.now()
    )
      throw new BadRequestException('Choose a future event date');
    if (
      typeof capacity !== 'number' ||
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 100000
    )
      throw new BadRequestException('Capacity must be between 1 and 100,000');
    const amount = eventAmount(body.amount);
    const event: EventRow = {
      id: randomUUID(),
      name,
      location,
      startsAt: new Date(startsAt).toISOString(),
      capacity,
      amount,
      registered: 0,
    };
    await this.db.collection<EventRow>('events').insertOne({ ...event });
    return event;
  }
  async register(eventId: string, body: Record<string, unknown>) {
    const name = field(body, 'name', 120),
      address = email(body),
      phone = field(body, 'phone', 24);
    if (!/^[+\d ()-]{7,24}$/.test(phone))
      throw new BadRequestException('Invalid phone number');
    const session = this.client.startSession();
    try {
      return await session.withTransaction(
        async () => {
          const events = this.db.collection<EventRow>('events');
          const event = await events.findOne({ id: eventId }, { session });
          if (!event) throw new NotFoundException('Event not found');
          if (Date.parse(event.startsAt) <= Date.now())
            throw new ConflictException('Registration has closed');
          if (event.amount !== 0)
            throw new ConflictException('Paid registration is not available');
          const registrations =
            this.db.collection<Registration>('registrations');
          if (
            await registrations.findOne(
              { eventId, email: address },
              { session },
            )
          )
            throw new ConflictException('This email is already registered');
          const reserved = await events.updateOne(
            { id: eventId, registered: { $lt: event.capacity } },
            { $inc: { registered: 1 } },
            { session },
          );
          if (!reserved.modifiedCount)
            throw new ConflictException('This event is full');
          const id = randomUUID();
          await registrations.insertOne(
            {
              id,
              eventId,
              eventName: event.name,
              name,
              email: address,
              phone,
              createdAt: new Date().toISOString(),
            },
            { session },
          );
          await this.outbox.enqueue(
            emailJob(event, { id, name, email: address }),
            session,
          );
          return { id, eventName: event.name };
        },
        { writeConcern: { w: 'majority' } },
      );
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new ConflictException('This email is already registered');
      throw error;
    } finally {
      await session.endSession();
    }
  }
  async registrations() {
    return this.db
      .collection<Registration>('registrations')
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray();
  }
}
