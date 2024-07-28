const log4js = require("log4js");
const os = require("os");
const config = require("./config.json");

const WebSocketServer = require("./src/websockets.js").WebSocketServer;

const logger = log4js.getLogger("App");
logger.level = config.logLevel;

function showSystemInfo() {
    logger.info("=== System Info ===")
    logger.info("Hostname:", os.hostname());
    logger.info("Memory:", os.totalmem() / 1024 / 1024 + "mb");
    console.log("");
}

showSystemInfo();
logger.info("Web Socket Server Starting...");

var server = new WebSocketServer();
server.start(5050);