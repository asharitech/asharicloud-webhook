/**
 * Lambda function entry point for webhook receiver
 * 
 * Modular implementation with clean separation of concerns
 * Uses individual modules for each responsibility
 * 
 * @module WebhookReceiver
 */

const { handler } = require('./src/handlers/webhook.handler');

// Export the main handler
module.exports = { handler };