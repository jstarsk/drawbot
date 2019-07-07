//
//    ,--.                      ,--.          ,--.
//  ,-|  ,--.--.,--,--,--.   ,--|  |-. ,---.,-'  '-.
// ' .-. |  .--' ,-.  |  |.'.|  | .-. | .-. '-.  .-'
// \ `-' |  |  \ '-'  |   .'.   | `-' ' '-' ' |  |
//  `---'`--'   `--`--'--'   '--'`---' `---'  `--'
// Created by Andy Wise
//

// import external and node-specific modules
let Config = require('./modules/Config');
let BotController = require('./modules/BotController');
let LocalServer = require('./modules/LocalServer');
// let BotClient = require('./modules/BotClient') // for optional remote drawbot relay server client

// SETUP
let botController, botClient, localServer;
let config = Config('config.json', () => {

	// Main Controller
	botController = BotController(config);

	// Local Server
	localServer = LocalServer(config, botController);
	botController.localio = localServer.io;

	// Optional: Remote Drawbot Relay Server (requires "BotClient" import above, and "remoteURL" value in config.json)
	// botClient = BotClient(config, botController)
	// botController.client = botClient

	// Initialize!
	go()
});

//  START
let go = () => {
	botController.updateStringLengths();
	localServer.start()
};

// GRACEFUL EXIT
// per http://joseoncode.com/2014/07/21/graceful-shutdown-in-node-dot-js/
// and https://github.com/fivdi/pigpio/issues/6
let shutdown = () => {
	console.log('stopping the drawbot app...');
    localServer.server.close();
	process.exit(0)
};
process.on('SIGHUP', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGCONT', shutdown);