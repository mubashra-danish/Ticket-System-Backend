import { createStore } from './app.module.js';
import { MongoService } from './mongo.service.js';
describe('MongoDB configuration selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it.each(['MONGODB_URI', 'MONGO_URL', 'MONGO_URI'])(
    'uses %s instead of silently falling back to SQLite',
    async (key) => {
      for (const name of ['MONGODB_URI', 'MONGO_URL', 'MONGO_URI'])
        vi.stubEnv(name, '');
      vi.stubEnv(key, 'mongodb://localhost:27017/test');
      const connect = vi
        .spyOn(MongoService, 'connect')
        .mockRejectedValue(new Error('database unavailable'));
      await expect(createStore()).rejects.toThrow('database unavailable');
      expect(connect).toHaveBeenCalledWith('mongodb://localhost:27017/test');
    },
  );
});
