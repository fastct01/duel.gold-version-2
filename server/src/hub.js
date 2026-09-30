/* The Hub is how services talk to players in real time without knowing about WebSockets.
   A service calls hub.notify(userId, message, { conn? }); the WebSocket gateway installs the sender that delivers it and
   returns how many sockets received it (services need that to deliver a match seed exactly once).
   Every notification is also emitted as a 'user' event, which is what tests and other listeners hook into. */
import { EventEmitter } from "node:events";

export class Hub extends EventEmitter {
  constructor() {
    super();
    this.sender = null;
    this.lister = null;
  }
  setSender(fn) { this.sender = fn; }
  setConnectionLister(fn) { this.lister = fn; }
  /* opts.conn: deliver only to that connection id; opts.except: to every connection but that one.
     Returns the number of sockets the message reached. */
  notify(userId, message, opts) {
    this.emit("user", userId, message, opts);
    return this.sender ? this.sender(userId, message, opts) : 0;
  }
  /* ids of the player's open connections */
  connections(userId) { return this.lister ? this.lister(userId) : []; }
}
