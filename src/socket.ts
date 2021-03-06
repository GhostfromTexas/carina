import { MessageParseError, ConstellationError, CancelledError } from './errors';
import { ExponentialReconnectionPolicy, ReconnectionPolicy } from './reconnection';
import { EventEmitter } from 'events';
import { Packet, PacketState } from './packets';

import { resolveOn } from './util';
import * as pako from 'pako';

// DO NOT EDIT, THIS IS UPDATE BY THE BUILD SCRIPT
const packageVersion = '0.7.0'; // package version

/**
 * The GzipDetector is used to determine whether packets should be compressed
 * before sending to Constellation.
 */
export interface GzipDetector {
    /**
     * shouldZip returns true if the packet, encoded as a string, should
     * be gzipped before sending to Constellation.
     * @param {string} packet `raw` encoded as a string
     * @param {any}    raw    the JSON-serializable object to be sent
     */
    shouldZip(packet: string, raw: any): boolean;
}

/**
 * SizeThresholdGzipDetector is a GzipDetector which zips all packets longer
 * than a certain number of bytes.
 */
export class SizeThresholdGzipDetector implements GzipDetector {
    constructor(private threshold: number) {}

    shouldZip(packet: string): boolean {
        return packet.length > this.threshold;
    }
}

/**
 * SocketOptions are passed to the
 */
export interface SocketOptions {
    // Whether to announce that the client is a bot in the socket handshake.
    // Note that setting it to `false` may result in a ban. Defaults to true.
    isBot?: boolean;

    // User agent header to advertise in connections.
    userAgent?: string;

    // Settings to use for reconnecting automatically to Constellation.
    // Defaults to automatically reconnecting with the ExponentialPolicy.
    reconnectionPolicy?: ReconnectionPolicy;
    autoReconnect?: boolean;

    // Websocket URL to connect to, defaults to wss://constellation.beam.pro
    url?: string;

    // Interface used to determine whether messages should be gzipped.
    // Defaults to a strategy which gzipps messages greater than 1KB in size.
    gzip?: GzipDetector;

    // Optional JSON web token to use for authentication.
    jwt?: string;
    // Optional OAuth token to use for authentication.
    authToken?: string;

    // Timeout on Constellation method calls before we throw an error.
    replyTimeout?: number;

    // Duration upon which to send a ping to the server. Defaults to 10 seconds.
    pingInterval?: number;
}

/**
 * State is used to record the status of the websocket connection.
 */
export enum State {
    // a connection attempt has not been made yet
    Idle = 1,
    // a connection attempt is currently being made
    Connecting,
    // the socket is connection and data may be sent
    Connected,
    // the socket is gracefully closing; after this it will become Idle
    Closing,
    // the socket is reconnecting after closing unexpectedly
    Reconnecting,
    // connect was called whilst the old socket was still open
    Refreshing,
}

function getDefaults(): SocketOptions {
    return {
        url: 'wss://constellation.beam.pro',
        userAgent: `Carina ${packageVersion}`,
        replyTimeout: 10000,
        isBot: false,
        gzip: new SizeThresholdGzipDetector(1024),
        autoReconnect: true,
        reconnectionPolicy: new ExponentialReconnectionPolicy(),
        pingInterval: 10 * 1000,
    };
}

const jwtValidator = /^[\w_-]+?\.[\w_-]+?\.([\w_-]+)?$/i;

/**
 * The ConstellationSocket provides a somewhat low-level RPC framework for
 * interacting with Constellation over a websocket. It also provides
 * reconnection logic.
 */
export class ConstellationSocket extends EventEmitter {
    // WebSocket constructor, may be overridden if the environment
    // does not natively support it.
    public static WebSocket: any = typeof WebSocket === 'undefined' ? null : WebSocket;

    private reconnectTimeout: NodeJS.Timer | number;
    private pingTimeout: NodeJS.Timer | number;
    private options: SocketOptions;
    private state: State;
    private socket: WebSocket;

    constructor(options: SocketOptions = {}) {
        super();
        this.setOptions(options);

        if (ConstellationSocket.WebSocket === undefined) {
            throw new Error('Cannot find a websocket implementation; please provide one by ' +
                'running ConstellationSocket.WebSocket = myWebSocketModule;')
        }

        this.on('message', (msg: { data: string }) => this.extractMessage(msg.data));
        this.on('open', () => this.schedulePing());

        this.on('event:hello', () => {
            this.options.reconnectionPolicy.reset();
            this.setState(State.Connected);
        });

        this.on('close', () => {
            if (this.state === State.Refreshing) {
                this.setState(State.Idle);
                this.connect();
                return;
            }

            if (this.state === State.Closing || !this.options.autoReconnect) {
                this.setState(State.Idle);
                return;
            }

            this.setState(State.Reconnecting);
            this.reconnectTimeout = setTimeout(() => {
                this.connect();
            }, this.options.reconnectionPolicy.next());
        });
    }

    /**
     * Set the given options.
     * Defaults and previous option values will be used if not supplied.
     */
    public setOptions(options: SocketOptions) {
        this.options = {
            ...getDefaults(),
            ...this.options,
            ...options,
        };

        if (this.options.jwt && !jwtValidator.test(this.options.jwt)) {
            throw new Error('Invalid jwt');
        }

        if (this.options.jwt && this.options.authToken) {
            throw new Error('Cannot connect to Constellation with both JWT and OAuth token.');
        }
    }

    /**
     * Open a new socket connection. By default, the socket will auto
     * connect when creating a new instance.
     */
    public connect(): this {
        if (this.state === State.Closing) {
            this.setState(State.Refreshing);
            return this;
        }

        const protocol = this.options.gzip ? 'cnstl-gzip' : 'cnstl';
        const extras = {
            headers: <{ [name: string]: string | boolean }>{
                'User-Agent': this.options.userAgent,
                'X-Is-Bot': this.options.isBot,
            },
        };

        let url = this.options.url;
        if (this.options.authToken) {
            extras.headers['Authorization'] = `Bearer ${this.options.authToken}`;
        } else if (this.options.jwt) {
            url += `?jwt=${this.options.jwt}`; // invalid JWTs will cause errors
        }

        this.socket = new ConstellationSocket.WebSocket(url, protocol, extras);
        this.socket.binaryType = 'arraybuffer';

        this.setState(State.Connecting);

        this.rebroadcastEvent('open');
        this.rebroadcastEvent('close');
        this.rebroadcastEvent('message');

        this.socket.addEventListener('error', err => {
            if (this.state === State.Closing) {
                // Ignore errors on a closing socket.
                return;
            }

            this.emit('error', err);
        });

        return this;
    }

    /**
     * Returns the current state of the socket.
     * @return {State}
     */
    public getState(): State {
        return this.state;
    }

    /**
     * Close gracefully shuts down the websocket.
     */
    public close() {
        if (this.state === State.Reconnecting) {
            clearTimeout(<number>this.reconnectTimeout);
            this.setState(State.Idle);
            return;
        }

        this.setState(State.Closing);
        this.socket.close();
        clearTimeout(<number>this.pingTimeout);
    }

    /**
     * Executes an RPC method on the server. Returns a promise which resolves
     * after it completes, or after a timeout occurs.
     */
    public execute(method: string, params: { [key: string]: any } = {}): Promise<any> {
        return this.send(new Packet(method, params));
    }

    /**
     * Send emits a packet over the websocket.
     */
    public send(packet: Packet): Promise<any> {
        const timeout = packet.getTimeout(this.options.replyTimeout);
        const promise = Promise.race([
            // Wait for replies to that packet ID:
            resolveOn<{ err: Error, result: any }>(this, `reply:${packet.id()}`, timeout)
            .then(result => {
                if (result.err) {
                    throw result.err;
                }

                return result.result;
            }),
            // Reject the packet if the socket closes before we get a reply:
            resolveOn(this, 'close', timeout + 1)
            .then(() => { throw new CancelledError() }),
        ]);

        packet.emit('send', promise);
        packet.setState(PacketState.Sending);
        this.sendPacketInner(packet);

        return promise;
    }

    private setState(state: State) {
        if (this.state === state) {
            return;
        }

        this.state = state;
        this.emit('state', state);
    }

    private sendPacketInner(packet: Packet) {
        const data = JSON.stringify(packet);
        const payload = this.options.gzip.shouldZip(data, packet.toJSON())
            ? pako.gzip(data)
            : data;

        this.emit('send', payload);
        this.socket.send(payload);
    }

    private extractMessage(packet: string | Buffer) {
        let messageString: string;
        // If the packet is binary, then we need to unzip it
        if (typeof packet !== 'string') {
            messageString = <string> <any> pako.ungzip(packet, { to: 'string' });
        } else {
            messageString = packet;
        }

        let message: any;
        try {
            message = JSON.parse(messageString);
        } catch (err) {
            throw new MessageParseError('Message returned was not valid JSON');
        }

        // Bump the ping timeout whenever we get a message reply.
        this.schedulePing();

        switch (message.type) {
        case 'event':
            this.emit(`event:${message.event}`, message.data);
            break;
        case 'reply':
            let err = message.error ? ConstellationError.from(message.error) : null;
            this.emit(`reply:${message.id}`, { err, result: message.result });
            break;
        default:
            throw new MessageParseError(`Unknown message type "${message.type}"`);
        }
    }

    private rebroadcastEvent(name: string) {
        this.socket.addEventListener(name, evt => this.emit(name, evt));
    }

    private schedulePing() {
        clearTimeout(<number>this.pingTimeout);

        this.pingTimeout = setTimeout(() => {
            if (this.state !== State.Connected) {
                return;
            }

            const packet = new Packet('ping', null);
            const timeout = this.options.replyTimeout;

            setTimeout(() => {
                this.sendPacketInner(packet);
                this.emit('ping');
            });

            Promise.race([
                resolveOn(this, `reply:${packet.id()}`, timeout),
                resolveOn(this, 'close', timeout + 1),
            ])
            .then(() => this.emit('pong'))
            .catch(err => {
                this.socket.close();
                this.emit('warning', err)
            });
        }, this.options.pingInterval);
    }
}
