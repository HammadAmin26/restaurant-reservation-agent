// The tool input from Claude didn't match the tool's schema.
// Claude only hears that the tool failed; the real reason is logged.
class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
  }
}

module.exports = { ToolInputError };
