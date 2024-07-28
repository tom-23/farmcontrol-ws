// WebSocketServer.js

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { MongoClient } = require("mongodb");
const socketioJwt = require("socketio-jwt");
const log4js = require("log4js");
const config = require("../config.json");
const { trace } = require("console");

const logger = log4js.getLogger("Web Sockets");
logger.level = config.logLevel;

class WebSocketServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = socketIo(this.server, {
      cors: {
        origin: "*",
      },
      maxHttpBufferSize: 1e8
    });
    this.JWT_SECRET = process.env.JWT_SECRET || config.jwt_secret;
    this.mongoUri = process.env.MONGO_URI || config.mongo_uri;
    this.dbName = "farmcontrol"; // DB Name

    this.hostSockets = [];
    this.userSockets = [];
  }

  async connectToMongo() {
    try {
      const client = new MongoClient(this.mongoUri, {});
      await client.connect();
      this.db = client.db(this.dbName);
      logger.info("Connected to MongoDB");
      this.clearHostsCollection();
    } catch (err) {
      logger.error("MongoDB connection error:", err);
    }
  }

  configureMiddleware() {
    // Middleware for JWT authentication
    this.io.use(
      socketioJwt.authorize({
        secret: this.JWT_SECRET,
        handshake: true,
      })
    );
  }

  setupSocketIO() {
    this.io.on("connection", (socket) => {
      var connectionType = "user";
      var hostId;
      var id, email;
      if (socket.decoded_token.hasOwnProperty("hostId")) {
        var connectionType = "host";
        hostId = socket.decoded_token.hostId;
        logger.info("Host connected:", hostId);
        this.hostSockets.push(socket.id);
        this.handleHostOnlineEvent({ hostId });
      } else {
        id = socket.decoded_token.id;
        email = socket.decoded_token.email;
        logger.info("User connected:", id);
        this.userSockets.push(socket.id);
      }

      socket.on("disconnect", () => {
        if (connectionType == "host") {
          logger.info("Host " + socket.decoded_token.hostId + " disconnected.");
          this.hostSockets = this.hostSockets.filter(id => id !== socket.id);
          this.handleHostOfflineEvent({ hostId: hostId });
        } else {
          logger.info("User " + socket.decoded_token.id + " disconnected.")
          this.userSockets = this.userSockets.filter(id => id !== socket.id);
        }
      });

      socket.on("status", (data) => {
        logger.info("Setting", data.remoteAddress, "status to", data.status);
        if (data.type == "printer") {
          this.handlePrinterStatusEvent(data);
        }
      });

      socket.on("online", (data) => {
        logger.info("Setting", data.remoteAddress, "to online.");
        if (data.type == "printer") {
          this.handlePrinterOnlineEvent(data, socket);
        }
      });
    
      socket.on("offline", (data) => {
        logger.info("Setting", data.remoteAddress, "to offline.");
        if (data.type == "printer") {
          this.handlePrinterOfflineEvent(data);
        }
      });

      socket.on("join", (data) => {
        if (data.remoteAddress) {
          logger.trace("Joining room", data.remoteAddress);
          socket.join(data.remoteAddress);
        }
      });

      socket.on("leave", (data) => {
        if (data.remoteAddress) {
          logger.trace("Leaving room", data.remoteAddress);
          socket.leave(data.remoteAddress);
        }
      });

      socket.on("temperature", (data) => {
        if (connectionType == "host") {
          socket.to(data.remoteAddress).emit("temperature", data);
        }
      });

      socket.on("command", (data) => {
        if (connectionType == "user") {
          socket.to(data.remoteAddress).emit(data.type, data);
        }
      });
    });
  }

  async clearHostsCollection() {
    try {
      if (!this.db) {
        await this.connectToMongo();
      }

      // Delete all documents from hosts collection
      const deleteResult = await this.db.collection("hosts").deleteMany({});

      logger.info(
        `Deleted ${deleteResult.deletedCount} documents from hosts collection`
      );
    } catch (error) {
      logger.error("Error clearing hosts collection:", error);
    }
  }

  async handlePrinterOnlineEvent(data, socket) {
    try {
      if (!this.db) {
        await this.connectToMongo();
      }

      // Check if data.remoteAddress exists in printers collection
      const existingPrinter = await this.db
        .collection("printers")
        .findOne({ remoteAddress: data.remoteAddress });

      if (existingPrinter) {
        // If exists, update the document
        const updateResult = await this.db.collection("printers").updateOne(
          { remoteAddress: data.remoteAddress },
          {
            $set: {
              online: true,
              status: { type: "Online" },
              connectedAt: new Date(),
              hostId: data.hostId, // Assuming hostId is passed as a parameter to handleIdentifyEvent
            },
          }
        );

        if (updateResult.modifiedCount > 0) {
          logger.info(`Printer updated: ${data.remoteAddress}`);
        } else {
          logger.warn(`Printer not updated: ${data.remoteAddress}`);
        }
      } else {
        // If not exists, insert a new document
        const insertData = {
          remoteAddress: data.remoteAddress,
          hostId: data.hostId,
          online: true,
          status: { type: "Online" },
          connectedAt: new Date(),
          friendlyName: "",
          loadedFillament: null,
        };
        const insertResult = await this.db
          .collection("printers")
          .insertOne(insertData);

        if (insertResult.insertedCount > 0) {
          logger.info(`New printer added: ${data.remoteAddress}`);
        } else {
          logger.warn(`Failed to add new printer: ${data.remoteAddress}`);
        }
      }

      const onlineData = {
        remoteAddress: data.remoteAddress,
        hostId: data.hostId,
        online: true,
        status: { type: "Online" },
        connectedAt: new Date(),
      };

      logger.trace("Sending online data", onlineData)
      this.sendStatusToUserSockets(onlineData);

      // Join socket room using remoteAddress as name
      //logger.trace("Joining room", data.remoteAddress);
      logger.trace("Joining room", data.remoteAddress);
      socket.join(data.remoteAddress);

    } catch (error) {
      logger.error("Error handling online event:", error);
    }
  }

  async handlePrinterStatusEvent(data) {
    try {
      if (!this.db) {
        await this.connectToMongo();
      }
  
      // Check if data.remoteAddress exists in printers collection
      const existingPrinter = await this.db
        .collection("printers")
        .findOne({ remoteAddress: data.remoteAddress });
  
      if (existingPrinter) {
        // If exists, update the document
        const updateResult = await this.db.collection("printers").updateOne(
          { remoteAddress: data.remoteAddress },
          {
            $set: {
              status: data.status,
            },
          }
        );
  
        if (updateResult.modifiedCount > 0) {
          logger.info(`Printer updated: ${data.remoteAddress}`);
        } else {
          logger.warn(`Printer not updated: ${data.remoteAddress}`);
        }
      } else {

      }
  
      const onlineData = {
        remoteAddress: data.remoteAddress,
        hostId: data.hostId,
        online: true,
        connectedAt: new Date(),
      };
  
      logger.trace("Sending status data", onlineData)
      this.sendStatusToUserSockets(data);
  
    } catch (error) {
      logger.error("Error handling status event:", error);
    }
  }

  async handlePrinterOfflineEvent(data) {
    try {
      if (!this.db) {
        await this.connectToMongo();
      }

      // Check if data.remoteAddress exists in printers collection
      const existingPrinter = await this.db
        .collection("printers")
        .findOne({ remoteAddress: data.remoteAddress });

      if (existingPrinter) {
        // If exists, update the document
        const updateResult = await this.db.collection("printers").updateOne(
          { remoteAddress: data.remoteAddress },
          {
            $set: {
              online: false,
              status: { type: "Offline" },
              connectedAt: null,
              hostId: data.hostId, // Assuming hostId is passed as a parameter to handleIdentifyEvent
            },
          }
        );

        if (updateResult.modifiedCount > 0) {
          logger.info(`Printer updated: ${data.remoteAddress}`);
        } else {
          logger.warn(`Printer not updated: ${data.remoteAddress}`);
        }
      } else {
        // If not exists, insert a new document
        const insertResult = await this.db.collection("printers").insertOne({
          remoteAddress: data.remoteAddress,
          hostId: data.hostId,
          online: false,
          status: { type: "Offline" },
          connectedAt: null,
          friendlyName: "",
          loadedFillament: null,
        });

        if (insertResult.insertedCount > 0) {
          logger.info(`New printer added: ${data.remoteAddress}`);
        } else {
          logger.warn(`Failed to add new printer: ${data.remoteAddress}`);
        }
      }
      const offlineData = {
        remoteAddress: data.remoteAddress,
        hostId: data.hostId,
        online: false,
        status: { type: "Offline" },
        connectedAt: null,
      };

      logger.trace("Sending offline data", offlineData)
      this.sendStatusToUserSockets(offlineData);

    } catch (error) {
      logger.error("Error handling offline event:", error);
    }
  }

  async handleHostOnlineEvent(data) {
    try {
      if (!this.db) {
        await this.connectToMongo();
      }

      // Add new entry to hosts collection.
      const insertResult = await this.db.collection("hosts").insertOne({
        hostId: data.hostId,
        online: true,
        connectedAt: new Date(),
      });

      if (insertResult.insertedCount != 0) {
        logger.info(`New host added: ${data.hostId}`);
      } else {
        logger.warn(`Failed to add new host: ${data.hostId}`);
      }
    } catch (error) {
      logger.error("Error handling online event:", error);
    }
  }

  async handleHostOfflineEvent(data) {
    //try {
    if (!this.db) {
      await this.connectToMongo();
    }

    // Delete user from hosts collection
    const deleteUserResult = await this.db
      .collection("hosts")
      .deleteOne({ hostId: data.hostId });

    if (deleteUserResult.deletedCount > 0) {
      logger.info(`User deleted from hosts collection: ${data.hostId}`);
    } else {
      logger.warn(`User not found in hosts collection: ${data.hostId}`);
    }

    // Update all printers with matching hostId
    const updatePrintersResult = await this.db
      .collection("printers")
      .updateMany(
        { hostId: data.hostId },
        {
          $set: {
            online: false,
            status: { type: "Offline" },
            connectedAt: null,
          },
        }
      );

    const listPrintersResult = await this.db
    .collection("printers")
    .find({ hostId: data.hostId }).toArray();
    
    if (updatePrintersResult.modifiedCount > 0) {
      logger.info(
        `Updated ${updatePrintersResult.modifiedCount} printers for user: ${data.hostId}`
      );
    for (let i = 0; i < listPrintersResult.length; i++) {
      const printer = listPrintersResult[i];
      const offlineData = {
        remoteAddress: printer.remoteAddress,
        hostId: printer.hostId,
        online: false,
        status: { type: "Offline" },
        connectedAt: null,
      };
      logger.info(
        `Sending offline status for: ${printer.remoteAddress}`
      );
      this.sendStatusToUserSockets(offlineData)
    }
    } else {
      logger.warn(`No printers found for user: ${data.hostId}`);
    }
    

    //} catch (error) {
    //  logger.error('Error handling user offline event:', error);
    //}
  }

  sendStatusToUserSockets(data) {
    this.userSockets.forEach(id => {
      this.io.to(id).emit("status", data);
    });
  }

  async start(port = 3000) {
    await this.connectToMongo();
    this.configureMiddleware();
    this.setupSocketIO();

    this.server.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
    });
  }
}

module.exports = { WebSocketServer };
