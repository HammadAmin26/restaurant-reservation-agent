const express = require("express");
const cors = require("cors");
const conversationRoutes = require("./routes/conversation.routes");
const { createReservationRouter } = require("./routes/reservation.routes");
const { createStaffRouter } = require("./routes/staff.routes");

// Build the Express app. server.js starts it; tests start it on a free port.
// clock returns the current time for reservation rules; tests pass a fixed one.
function createApp({ clock = () => new Date() } = {}) {
  const app = express();

  // Allow requests from other origins, such as the future frontend
  app.use(cors());

  // Parse JSON request bodies into req.body
  app.use(express.json());

  // Health check: confirms the server is up and responding
  app.get("/health", (req, res) => {
    res.json({
      success: true,
      message: "Hammad Foods API is running!",
    });
  });

  app.use("/conversations", conversationRoutes);
  // Has its own full paths: /reservations/... and /conversations/:id/...
  app.use(createReservationRouter({ clock }));
  // The staff dashboard's read-only routes; public, as the demo has no staff login
  app.use("/staff", createStaffRouter({ clock }));

  // Any request that did not match a route above
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      message: "Route not found",
    });
  });

  // Central error handler: Express needs all four arguments to treat this as one
  app.use((err, req, res, next) => {
    // Errors with a 4xx status are the client's fault, such as invalid JSON
    if (err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({
        success: false,
        message: err.message,
      });
    }

    console.error(err);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  });

  return app;
}

module.exports = { createApp };
