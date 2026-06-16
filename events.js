import { EventEmitter } from 'events';
import { handleNotification } from './services/notification.js';

export const orderEventEmitter = new EventEmitter();
orderEventEmitter.setMaxListeners(100);

orderEventEmitter.on('NOTIFY_NEW_ORDER', (payload) => handleNotification('NOTIFY_NEW_ORDER', payload));
orderEventEmitter.on('NOTIFY_NEW_COMMENT', (payload) => handleNotification('NOTIFY_NEW_COMMENT', payload));
orderEventEmitter.on('NOTIFY_DELIVERY_COMPLETE', (payload) => handleNotification('NOTIFY_DELIVERY_COMPLETE', payload));
orderEventEmitter.on('NOTIFY_ORDER_CONFIRMED', (payload) => handleNotification('NOTIFY_ORDER_CONFIRMED', payload));
