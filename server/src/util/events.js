import { EventEmitter } from 'node:events';
// In-process bus. Server pushes events to connected clients of the matching user via WebSocket.
export const bus = new EventEmitter();
bus.setMaxListeners(1000);
export const notify = (userId, type, payload = {}) => bus.emit('user-event', { userId, type, payload });
