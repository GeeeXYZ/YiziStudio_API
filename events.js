import { EventEmitter } from 'events';

export const orderEventEmitter = new EventEmitter();
orderEventEmitter.setMaxListeners(100);
