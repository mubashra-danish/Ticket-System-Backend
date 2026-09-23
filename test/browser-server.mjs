// Dedicated browser-test server. This mock is never loaded by src/main.ts.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/app.module.js';
import { RazorpayService } from '../dist/razorpay.service.js';
import { configure } from '../dist/configure.js';
if(process.env.NODE_ENV!=='test'||process.env.DATABASE_PATH!==':memory:')throw new Error('Browser test server requires an isolated in-memory test database');
const orders=new Map();
const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(RazorpayService).useValue({
 async create(b){const id='order_'+b.id.replaceAll('-','');orders.set(id,{id,receipt:b.id,amount:b.amount,currency:b.currency});return orders.get(id);},
 async payment(id){const order=orders.get('order_'+id.slice(4));if(!order)throw new Error('Unknown test payment');return {id,order_id:order.id,amount:order.amount,currency:order.currency,status:'captured'};},
 async order(id){return orders.get(id);},
 async orderPayments(){return {items:[]};}
}).compile();
const app=module.createNestApplication({rawBody:true});configure(app);await app.listen(Number(process.env.PORT),'127.0.0.1');
