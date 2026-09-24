import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MongoService } from './mongo.service.js';
import { PaymentsService } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';
import { EmailService, EmailTransport } from './email.service.js';
import { EmailController } from './email.controller.js';
export function createStore() {
  const uri =
    process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI;
  return uri ? MongoService.connect(uri) : new AppService();
}
@Module({
  controllers: [AppController, PaymentsController, EmailController],
  providers: [
    { provide: AppService, useFactory: createStore },
    PaymentsService,
    EmailService,
    EmailTransport,
  ],
})
export class AppModule {}
