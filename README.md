# Asharicloud Webhook Receiver

AWS Lambda-based webhook receiver service that captures incoming webhooks, stores them in MongoDB, and publishes events to SNS for downstream processing.

## Architecture

```
API Gateway → Lambda (Handler) → MongoDB
                              ↘ SNS → Subscribers
                                   ↘ DLQ → Lambda (DLQ Processor)
```

## Components

### 1. Main Webhook Handler (`index.js`)
- Receives webhooks via API Gateway
- Validates and structures incoming data
- Stores webhooks in MongoDB (database: `{env}-webhook`)
- Publishes events to SNS topic for downstream consumers
- Supports correlation ID tracking

### 2. DLQ Processor (`dlq-processor.js`)
- Processes failed SNS deliveries
- Analyzes failure patterns
- Implements retry logic for transient failures
- Sends CloudWatch metrics for monitoring

## Features

- **Multi-protocol Support**: Accepts POST, PUT, PATCH, DELETE (rejects GET)
- **Dynamic Collection Routing**: Creates MongoDB collections based on webhook path
- **Environment-based Database**: Separate databases for dev/prod environments
- **Concurrent Processing**: MongoDB storage and SNS publishing run in parallel
- **Connection Pooling**: Reuses MongoDB connections across Lambda invocations
- **Correlation Tracking**: Preserves X-Correlation-ID and X-Request-ID headers

## Deployment

This service uses GitHub Actions for CI/CD:

1. **Push to main branch** triggers automatic deployment
2. **Test stage** validates Lambda handlers
3. **Deploy stage** packages and deploys to AWS Lambda

### Lambda Functions

- **Main Handler**: `prod-webhook-receiver-handler`
  - Runtime: Node.js 18.x
  - Memory: 256 MB
  - Timeout: 30 seconds

- **DLQ Processor**: `prod-webhook-receiver-dlq-processor`
  - Runtime: Node.js 18.x
  - Memory: 512 MB
  - Timeout: 60 seconds

### Environment Variables

**Main Handler:**
- `SNS_TOPIC_ARN`: Target SNS topic for webhook events
- `MONGODB_URI_PARAMETER`: SSM parameter path for MongoDB connection string
- `LOG_LEVEL`: Logging verbosity (default: INFO)

**DLQ Processor:**
- `DLQ_URL`: SQS Dead Letter Queue URL
- `ORIGINAL_TOPIC_ARN`: Original SNS topic ARN
- `CRITICAL_FAILURE_TOPIC_ARN`: Topic for critical failure notifications
- `ENVIRONMENT`: Environment name (prod/dev)

## API Endpoint

Production: `https://cdprwuho0k.execute-api.ap-southeast-3.amazonaws.com/v1/{proxy+}`

### Example Request

```bash
curl -X POST https://cdprwuho0k.execute-api.ap-southeast-3.amazonaws.com/v1/webhook/test \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: test-123" \
  -d '{"event": "test", "data": {"key": "value"}}'
```

### Response

```json
{
  "message": "Webhook received, logged, stored, and published successfully",
  "requestId": "xxx-xxx-xxx",
  "database": "prod-webhook",
  "collection": "webhook-test",
  "operations_status": {
    "mongodb": "success",
    "sns": "success"
  },
  "processing_time_ms": 150
}
```

## SNS Subscribers

Current production subscribers:
- `https://api.brainybuddy.app/messages/telegram`
- `https://api.brainybuddy.app/messages/line`
- `https://api.brainybuddy.app/generatives`

## Development

### Prerequisites
- Node.js 18.x
- npm

### Installation
```bash
npm install
```

### Testing Lambda Handlers
```bash
node -c index.js
node -c dlq-processor.js
```

## Monitoring

- **CloudWatch Logs**: `/aws/lambda/prod-webhook-receiver-handler`
- **CloudWatch Metrics**: `WebhookReceiver/DLQ` namespace
- **SQS DLQ**: `prod-webhook-receiver-sns-dlq`

## Security

- MongoDB credentials stored in AWS SSM Parameter Store
- Lambda functions use IAM roles with least privilege
- API Gateway handles authentication if configured

## License

MIT