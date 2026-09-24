import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { AppService, digest } from './app.service.js';
import type { MongoService } from './mongo.service.js';
export function configure(app: NestExpressApplication) {
  const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
  if (
    new URL(origin).origin !== origin ||
    (process.env.NODE_ENV === 'production' && !origin.startsWith('https://'))
  )
    throw new Error('APP_ORIGIN must be an exact origin (HTTPS in production)');
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '16kb' });
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== origin || !req.is('application/json'))
        return res
          .status(403)
          .json({ message: 'Request origin or content type is not allowed' });
      const login = req.path === '/api/auth/login';
      const service = app.get<AppService | MongoService>(AppService);
      if (
        !(await service.limit(
          (login
            ? 'login:'
            : req.path === '/api/payments/status'
              ? 'status:'
              : 'write:') + digest(req.ip || 'unknown'),
          login ? 10 : req.path === '/api/payments/status' ? 300 : 60,
          15 * 60 * 1000,
        ))
      ) {
        res.setHeader('Retry-After', '900');
        return res
          .status(429)
          .json({ message: 'Too many attempts. Try again in 15 minutes.' });
      }
    }
    next();
  });
  app.enableShutdownHooks();
}
