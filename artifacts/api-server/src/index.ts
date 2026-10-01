import "dotenv/config";
import http from "http";
import { Server } from "socket.io";
import { createApp } from "./app";
import { attachRealtime } from "./realtime";
import { verifyEmailTransport } from "./email";

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT must be a positive integer");
}

const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
});
attachRealtime(io);
httpServer.on("request", createApp(io));

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`T-SMART V7 API listening on port ${port}`);
});

void verifyEmailTransport()
  .then(() => console.log("SMTP connection verified"))
  .catch((error) => {
    const details = error as { code?: string; responseCode?: number; command?: string };
    console.error("SMTP verification failed", {
      code: details.code,
      responseCode: details.responseCode,
      command: details.command,
    });
  });