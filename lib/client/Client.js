'use strict';

// Dependencies ---------------------------------------------------------------
// ----------------------------------------------------------------------------
var lithium = require('lithium/client/lithium').lithium,
    Promise = require('bluebird'),
    bison = require('bisonjs'),
    util = require('../shared/util'),
    Action = require('../shared/Action'),
    InstanceList = require('./InstanceList'),
    CobaltError = require('./Error'),
    Room = require('./Room'),
    Player = require('./Player'),
    Emitter = require('../shared/Emitter');


// Lockstep Client ------------------------------------------------------------
// ----------------------------------------------------------------------------
function Client(
    gameIdent, gameVersion, playerClass, roomClass, loadHandler, tickHandler,
    networkInterface
) {

    Emitter.call(this);

    this._playerClass = playerClass || Player;
    this._roomClass = roomClass || Room;

    this._port = null;
    this._hostname = null;
    this._isConnected = false;
    this._isClosing = false;
    this._logger = null;
    this._parent = null;

    this._gameIdent = gameIdent;
    this._gameVersion = gameVersion;
    this._serverVersion = null;
    this._protocolVersion = null;

    this._player = null;
    this._players = new InstanceList(this, this._playerClass);
    this._playerEvents = [];

    this._room = null;
    this._rooms = new InstanceList(this, this._roomClass);
    this._tickCount = -1;
    this._lastTick = -1;

    this._promises = [];
    this._connectPromise = null;
    this._closePromise = null;
    this._responseId = 0;

    this._loadHandler = loadHandler;
    this._tickHandler = tickHandler;

    this._socket = new (networkInterface || lithium).Client(
        null, bison.encode, bison.decode
    );

    this._socket.on('connection', this._onConnection.bind(this));
    this._socket.on('message', this._onMessage.bind(this));
    this._socket.on('close', this._onClose.bind(this));

}

// Statics --------------------------------------------------------------------
Client.PROTOCOL_VERSION = '0.1';

// Methods --------------------------------------------------------------------
util.inherit(Client, Emitter, {

    // Public Interface -------------------------------------------------------
    connect: function(port, hostname) {

        this._port = +port;
        this._hostname = hostname;
        this._responseId = 1;
        this._isClosing = false;

        this._socket.connect(this._port, this._hostname);
        this._connectPromise = Promise.defer();

        this.log('Connecting...');

        return this._connectPromise.promise;

    },

    login: function(name) {
        this.log('Logging in as ', name, ' ...');
        return this._sendPromise(
            Action.CLIENT_MESSAGE_LOGIN,
            [Client.PROTOCOL_VERSION, this._gameIdent, this._gameVersion, name]
        );
    },

    createRoom: function(name, minPlayers, maxPlayers, tickRate, password) {
        this.log('Creating room "' + name + '" ...');
        return this._sendPromise(
            Action.CLIENT_MESSAGE_ROOM_CREATE,
            [name, minPlayers, maxPlayers, tickRate, password || null]
        );
    },

    setLogger: function(logger) {
        this._logger = logger;
    },

    setParent: function(parent) {
        this._parent = parent;
    },

    close: function() {

        if (this._isConnected && !this._closePromise) {

            this.log('Closing...');

            this._isClosing = true;
            this._isConnected = false;

            // Leave the current room
            if (this._room) {
                this.emit('room.leave', this._room);
                this._room = null;
            }

            // Clean up local state
            this._rooms.clear();
            this._players.clear();
            this._player = null;
            this._playerEvents.length = 0;
            this._serverVersion = null;

            this._socket.close();

            this._closePromise = Promise.defer();
            return this._closePromise.promise;

        } else {
            return Promise.rejected();
        }

    },

    destroy: function() {

        this.emit('destroy');
        Emitter.prototype.destroy.call(this);

        this._rooms.destroy();
        this._players.destroy();
        this._rooms = null;
        this._players = null;
        this._promises = null;
        this._loadHandler = null;
        this._tickHandler = null;
        this._playerEvents = null;

    },

    // Getter -----------------------------------------------------------------
    getRooms: function() {
        return this._rooms;
    },

    getPlayer: function() {
        return this._player;
    },

    getPlayers: function() {
        return this._players;
    },

    getGameIdent: function() {
        return this._gameIdent;
    },

    getGameVersion: function() {
        return this._gameVersion;
    },

    getParent: function() {
        return this._parent;
    },

    isConnected: function() {
        return this._isConnected;
    },

    // Friend -----------------------------------------------------------------
    __joinRoom: function(id, password) {
        return this._sendPromise(
            Action.CLIENT_MESSAGE_ROOM_JOIN,
            [id, password || null]
        );
    },

    __startRoom: function(countdown) {
        return this._sendPromise(Action.CLIENT_MESSAGE_ROOM_START, countdown);
    },

    __cancelRoom: function() {
        return this._sendPromise(Action.CLIENT_MESSAGE_ROOM_CANCEL_COUNTDOWN);
    },

    __leaveRoom: function() {
        return this._sendPromise(Action.CLIENT_MESSAGE_ROOM_LEAVE);
    },

    __setRoomParameter: function(key, value) {
        return this._sendPromise(
            Action.CLIENT_MESSAGE_ROOM_SET_PARAM,
            [key, value]
        );
    },

    __setRoomOwner: function(player) {
        return this._sendPromise(
            Action.CLIENT_MESSAGE_ROOM_SET_OWNER, player.getId()
        );
    },

    __setRoomPassword: function(password) {
        return this._sendPromise(
            Action.CLIENT_MESSAGE_ROOM_SET_PASSWORD, password
        );
    },

    __addPlayerEvent: function(event) {
        this._playerEvents.push(event);
    },

    // Events -----------------------------------------------------------------
    _onConnection: function() {
        this._isConnected = true;
    },

    _onMessage: function(msg) {

        var that = this,
            rid = msg[0],
            action = msg[1],
            data = msg[2];

        switch(action) {

            case Action.SERVER_MESSAGE_HELLO:
                this._protocolVersion = data[0];
                this._serverVersion = data[1];

                this.log('Connection established');
                this.emit('connect');
                this._connectPromise.resolve(this);
                this._connectPromise = null;
                break;

            case Action.SERVER_RESPOND_LOGIN:
                this._players.update([data]);
                this._player = this._players.at(0);

                this.log('Logged in as ', this._player);
                this.emit('login', this._player);
                this._resolvePromise(rid, null, this._player);
                break;

            case Action.SERVER_MESSAGE_ROOM_JOINED:
                this._room = this._rooms.get(data[0]);
                this._room.update.apply(this._room, data);
                break;

            case Action.SERVER_MESSAGE_ROOM_PLAYER_LIST:
                this._players.update(data);
                this._room.__setPlayerCount(this._players.length);
                this.emit('players', this._players);
                break;

            case Action.SERVER_MESSAGE_ROOM_SET_OWNER:
                this._room.__setOwner(this._players.get(data));
                break;

            case Action.SERVER_RESPOND_ROOM_OWNER_SET:
                this.log('Set room owner to ', this._room.getOwner());
                this._resolvePromise(rid, null, this._room.getOwner());
                break;

            case Action.SERVER_RESPOND_ROOM_JOINED:
                this.log('Joined room ', this._room);
                this.emit('room.join', this._room);
                this._resolvePromise(rid, null, this._room);
                break;

            case Action.SERVER_RESPOND_ROOM_LEFT:
                this.log('Left room ', this._room);
                this._player.__setOwner(false);

                // room get's destroy via room list update
                this._room = null;

                // update the player list and remove all other players
                this._players.update([
                    [this._player.getId(), this._player.getName()]
                ]);

                this.emit('players', this._players);
                this.emit('room.leave', this._room);
                this._resolvePromise(rid, null, this._player);
                break;

            case Action.SERVER_MESSAGE_ROOM_COUNTDOWN_STARTED:
                this._room.__startCountdown(data);
                break;

            case Action.SERVER_MESSAGE_ROOM_COUNTDOWN_UPDATED:
                this._room.__updateCountdown(data);
                break;

            case Action.SERVER_MESSAGE_ROOM_COUNTDOWN_ENDED:
                this._room.__endCountdown();
                break;

            case Action.SERVER_MESSAGE_ROOM_COUNTDOWN_CANCELED:
                this._room.__cancelCountdown();
                break;

            case Action.SERVER_MESSAGE_ROOM_PARAM_SET:
                this._room.__setParameter(data[0], data[1]);
                break;

            case Action.SERVER_RESPOND_ROOM_PARAM_SET:
                this._resolvePromise(rid, null, this._room);
                break;

            case Action.SERVER_MESSAGE_ROOM_LOAD:

                this._room.log('Now loading...');
                this._room.__setRandomSeed(data[0]);

                // Assign random player indexes
                for(var i = 0, l = data[1].length; i < l; i++) {
                    this._players.get(data[1][i]).__setRandomIndex(i);
                }

                this._loadRoom(data);
                break;

            case Action.SERVER_MESSAGE_ROOM_STARTED:
                this._tickCount = -1;
                this._lastTick = -1;
                this._room.__setStarted();
                break;

            case Action.SERVER_RESPOND_ROOM_START:
                this.log('Started room');
                this._resolvePromise(rid, null, this._room);
                break;

            case Action.SERVER_MESSAGE_ROOM_LIST:
                this._rooms.update(data);
                this.emit('rooms', this._rooms);
                break;

            case Action.SERVER_MESSAGE_ROOM_PLAYER_JOINED:
                this._room.__addPlayer(this._players.get(data));
                break;

            case Action.SERVER_MESSAGE_ROOM_PLAYER_LEFT:
                this._room.__removePlayer(this._players.get(data));
                break;

            case Action.SERVER_MESSAGE_TICK_UPDATE:

                // Handle Tick Wrapping in Packets
                var td = Math.abs(data[0] - this._lastTick);
                if (td === 1 || td === 255) {

                    // Count up the local (non-wrapped) tick counter
                    this._tickCount++;
                    this._lastTick = data[0];

                    // Attach events to their respective players
                    data[1].forEach(function(event) {

                        // TODO can this really fail? Since we're removing events
                        // for left players on the server this should not happen
                        var player = that._players.get(event[0]);
                        if (player) {
                            player.__addReceivedEvent(event[1]);
                        }

                    });

                    this._room.__setTickCount(this._tickCount);

                    // Invoke the tick handler passing the tick count and players
                    this._tickHandler(this._tickCount, this._players);

                    // Send collected events from the local player
                    this._socket.send([
                        0, Action.CLIENT_RESPOND_TICK_CONFIRM,
                        [this._tickCount % 256, this._playerEvents]
                    ]);

                    // Reset receives player events
                    this._players.forEach(function(player) {
                        player.__resetReceivedEvents();
                    });

                    // Reset events ready for sending
                    this._playerEvents.length = 0;

                }
                break;

            case Action.ERROR:
                this._resolvePromise(rid, data, null);
                break;

            default:
                this._resolvePromise(rid, null, data);
                break;
        }

    },

    _onClose: function(byRemote) {

        if (this._isConnected || this._isClosing) {

            // If the connection gets terminated by the server we need to
            // invoke the close logic "manually"
            if (!this._isClosing) {
                this.close();
            }

            this.emit('close', byRemote);

            if (this._closePromise) {
                this._closePromise.resolve(byRemote);
                this._closePromise = null;
            }

            this.log('Closed');

        } else if (this._connectPromise) {
            this._connectPromise.reject(byRemote);
            this._connectPromise = null;
        }

    },

    // Internal ---------------------------------------------------------------
    _loadRoom: function(params) {

        var that = this,
            defer = Promise.defer();

        defer.promise.then(function() {
            that._socket.send([0, Action.CLIENT_RESPOND_ROOM_LOADED, null]);

        }, function() {
            // TODO handle loading errors in a more detailed way
            // TODO tell server about failure?
            that._leaveRoom();
        });

        this._loadHandler(this._room, defer);

    },

    _sendPromise: function(action, data) {

        var defer = Promise.defer();
        this._promises[this._responseId] = {
            defer: defer,
            request: data
        };

        this._socket.send([
            this._responseId, action, data === undefined ? null : data
        ]);

        this._responseId++;
        return defer.promise;

    },

    _resolvePromise: function(rid, err, data, raw) {

        if (err) {
            err = new CobaltError(err, data);
        }

        var promise = this._promises[rid] || null;
        if (promise) {

            delete this._promises[rid];

            if (err) {
                err.request = promise.request;
                this.emit('error', err);
                promise.defer.reject(err);

            } else {
                promise.defer.resolve(data);
            }

        // TODO can these actually happen?
        } else if (err) {
            this.log('Unhandled Error:', raw);
            this.emit('error', err);

        } else if (rid !== 0) {
            this.log('Unhandled Message:', raw);
            this.emit('unknown.message', raw);
        }

    },

    // Logging ----------------------------------------------------------------
    log: function() {
        util.log(this._logger, this.toString(), arguments);
    },

    toString: function() {
        return '[ Client ' + this._hostname + ':' + this._port + ' ]';
    }

});


// Exports --------------------------------------------------------------------
Client.Player = Player;
Client.Room = Room;
Client.Error = CobaltError;

module.exports = Client;

