# Fluxity Lambda Processor

AWS Lambda function for processing Fluxity documents via SQS queue integration.

## Architecture

- **SQS Queue**: Receives document processing messages from the main Fluxity app
- **Lambda Function**: Processes documents using OpenAI API and updates Supabase
- **Dead Letter Queue**: Handles failed messages for retry or manual inspection
- **Container Deployment**: Uses Docker for dependency management and fast deployments

## Features

- ✅ Clean, minimal dependencies (@supabase/supabase-js, openai)
- ✅ Container-based deployment (no size limits)
- ✅ GitHub Actions CI/CD pipeline
- ✅ Built on Linux/AMD64 (no architecture issues)
- ✅ Proper error handling and DLQ integration
- ✅ CloudFormation infrastructure as code
- ✅ Least privilege IAM roles
- ✅ Automatic deployment on code changes

## Deployment

### 1. Deploy Infrastructure

```bash
cd infrastructure/
./deploy.sh production [supabase-url] [supabase-key] [openai-key]
```

### 2. Set up GitHub Repository

1. Create new repository: `fluxity-lambda-processor`
2. Add GitHub secrets:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `OPENAI_API_KEY`

### 3. Push Code

```bash
git remote add origin https://github.com/YourUsername/fluxity-lambda-processor.git
git push -u origin main
```

GitHub Actions will automatically build and deploy the Lambda function.

### 4. Update Main App

Update your main Fluxity app's environment variables:

```env
SQS_QUEUE_URL=https://sqs.us-west-2.amazonaws.com/[account]/fluxity-document-processing-production
USE_SQS=true
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run locally (requires environment variables)
npm run dev
```

## Monitoring

- **CloudWatch Logs**: `/aws/lambda/fluxity-document-processor`
- **SQS Metrics**: Monitor queue depth and processing rates
- **DLQ**: Check for failed messages requiring attention

## File Processing Support

- **Images**: JPG, JPEG, PNG, WEBP, GIF (via gpt-4o-mini Vision API)
- **PDFs**: Direct PDF processing (via gpt-4o)
- **Output**: Structured JSON with invoice data extraction

## Environment Variables

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_KEY`: Supabase service role key (not anon key)
- `OPENAI_API_KEY`: OpenAI API key with GPT-4o access
- `NODE_ENV`: Environment (development/staging/production)