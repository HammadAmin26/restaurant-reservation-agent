// Load variables from the .env file into process.env
require("dotenv").config();

const { createApp } = require("./app");

const PORT = process.env.PORT || 5002;

createApp().listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
